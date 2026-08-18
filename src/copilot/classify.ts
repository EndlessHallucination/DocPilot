/**
 * copilot/classify.ts
 *
 * The classification task: sends the document's text to the model and gets back
 * a verdict per field. Owns the prompt, the payload serialisation and the
 * validation of what comes back. Transport lives in provider.ts.
 *
 * EXPLAINER §5.1–§5.3.
 */

import { callProvider, describeError } from "./provider";
import type { PayloadLine } from "./detect-field";
import type { Provider } from "./copilotStore";
import { COPILOT_DEV } from "./dev";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = "fill" | "skip" | "unclear";

export interface FieldClassification {
    /** A line id from the payload. Never invented — unknown ids are dropped. */
    id: string;
    /**
     * WHICH field on that line, when the line carries several.
     *
     * Often absent, and emission is high-variance run to run — anything
     * depending on it must degrade gracefully. Validated against the refs of
     * ITS OWN LINE: a ref belonging to a different line is a real ref and a
     * wrong answer. EXPLAINER §5.3.
     */
    ref?: string;
    fill: Verdict;
    /** The literal value to write, or an instruction if a value can't be known. */
    value_or_instruction: string;
    /** Why. Always English — see the prompt's CRITICAL block. */
    reason: string;
}

/** Success or a readable failure — never a thrown error, never a silent hang. */
export type ClassificationResult =
    | { ok: true; classifications: FieldClassification[] }
    | { ok: false; error: string };

export interface UserContext {
    documentDescription: string;
    goal: string;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** A full Hebrew page takes 60–100s to generate. EXPLAINER §5.4. */
const CLASSIFY_TIMEOUT_MS = 180_000;

/**
 * A REQUEST, NOT A GUARANTEE — provider.ts clamps this to the provider's own
 * ceiling. Hebrew output costs ~1 token per character, so this is the binding
 * constraint on how much can be classified per request. EXPLAINER §5.4.
 */
const CLASSIFY_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * ⚠ THE STRUCTURE IS LOAD-BEARING. The language rule sits AFTER the JSON schema
 * under its own heading because that is what made it stick — as rule 4 of 8 it
 * drifted on 2 of 5 rows. Do not tidy it back into the numbered list.
 * EXPLAINER §5.2.
 */
const SYSTEM_PROMPT = `You help a person fill in a bureaucratic form.

You receive every line of the form, in reading order, each with an id. Some
lines carry a "fields" array describing what can be marked or written there:
- checkbox: a tick box
- cells: a row of single-character boxes; "count" is how many characters fit
- writeIn: a blank to write on

Rules:

1. Decide for EVERY line whether it is something the person must act on. Most
   lines are headings, instructions or fine print — return nothing for those.
   But be thorough: a page of a bureaucratic form typically has 15-25 lines
   worth answering. If you have written fewer than 10 verdicts for a page, go
   back through the lines you passed over — you have almost certainly skipped
   real fields. Never stop early because the answer is getting long.

2. A line with no "fields" entry may still be a field. Absence of an entry
   means unknown, never "there is nothing here". Some options on a form have no
   box printed beside them, and instructions like "mark the relevant options
   below" create fields that cannot be detected mechanically.

3. Use the person's stated situation to decide which options apply to THEM.
   Do not describe every option neutrally — say which ones they should mark.

4. Keep each "reason" under 25 words. One sentence. A long explanation costs
   another field its verdict.

5. For a "cells" field, return exactly "count" characters. A 6-cell date is
   DDMMYY; an 8-cell date is DDMMYYYY.

6. A line may carry SEVERAL fields. A row of five tax-classification
   checkboxes is ONE line with five checkbox entries, each with its own "ref"
   and usually a "label". When you act on such a line, put the ref of the
   specific field you mean in "ref". Omit "ref" when the line has only one
   field, or when you genuinely cannot tell which is meant. Never guess a ref:
   an omitted ref is handled correctly, a wrong one puts a mark on the wrong
   box.

7. Never invent an id or a ref. Only use ones given to you.

8. If a line is marked "unreliableText", some characters may have been read
   incorrectly. Treat it with caution and say so rather than guessing.

9. For a checkbox the person should tick, "value_or_instruction" is the option
   being chosen — the field's label, or a short phrase naming it. Never leave
   it empty on a "fill" verdict.

Return ONLY a JSON object, no prose and no markdown fences:
{"fields":[{"id":"p1l3","ref":"p1l3f0","fill":"fill|skip|unclear","value_or_instruction":"...","reason":"..."}]}

- "fill": the person should act on this line
- "skip": it is a field but does not apply to them, with the reason why
- "unclear": you cannot tell without information they haven't given
- "ref": optional, and only when the line has more than one field

CRITICAL — TWO LANGUAGES, AND THEY ARE DIFFERENT.

"reason" is ENGLISH. Always. Even when the line you are explaining is Hebrew.
Even when you quote the form. Even when the whole document is Hebrew. Quoting
a Hebrew term inside an English sentence is correct; writing the sentence in
Hebrew is not.

"value_or_instruction" is in the FORM's language and script. A Hebrew form
needs Hebrew values, including names and addresses, because that is what the
receiving authority expects.

Check both before you answer.`;

/**
 * ⚠⚠ THIS IS THE PRIVACY BOUNDARY. Everything above it may hold coordinates;
 * nothing below it does.
 *
 * Rebuilt field by field rather than spread — `{ ...line }` would upload any
 * property added to PayloadLine later, silently and forever. Cell counts and
 * refs cross deliberately; nothing else does. EXPLAINER §5.1.
 *
 * Exported for ask.ts. One function, one audit — do not write a second one.
 */
export function projectLines(payload: PayloadLine[]) {
    return payload.map((line) => ({
        id: line.id,
        page: line.page,
        text: line.text,
        ...(line.fields
            ? {
                fields: line.fields.map((f) => ({
                    ref: f.ref,
                    kind: f.kind,
                    ...(f.count !== undefined ? { count: f.count } : {}),
                    ...(f.label ? { label: f.label } : {}),
                })),
            }
            : {}),
        ...(line.unreliableText ? { unreliableText: true } : {}),
    }));
}

function buildUserMessage(payload: PayloadLine[], context: UserContext): string {
    return [
        `What this document is: ${context.documentDescription || "(not stated)"}`,
        `What the person needs to do: ${context.goal || "(not stated)"}`,
        "",
        "Form lines:",
        JSON.stringify(projectLines(payload)),
    ].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function getFieldClassifications(
    payload: PayloadLine[],
    context: UserContext,
    provider: Provider,
    apiKey: string,
): Promise<ClassificationResult> {
    // No key check — provider.ts rejects an empty key with the message the user
    // needs, and duplicating it means two strings to keep in step.
    const result = await callProvider({
        system: SYSTEM_PROMPT,
        message: buildUserMessage(payload, context),
        provider,
        apiKey,
        json: true,
        maxTokens: CLASSIFY_MAX_TOKENS,
        timeoutMs: CLASSIFY_TIMEOUT_MS,
    });

    if (!result.ok) return { ok: false, error: result.error };

    // ⚠ The parse needs its OWN try/catch. callProvider has already returned
    // successfully by here, so a malformed answer throws out of THIS function,
    // not out of the transport — and without this the panel spins forever.
    try {
        return { ok: true, classifications: parseResponse(result.text, payload) };
    } catch (error) {
        return { ok: false, error: describeError(error, CLASSIFY_TIMEOUT_MS) };
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the model's JSON and discard what can't be trusted. Two severities:
 * a bad id drops the row, a bad ref only strips the ref. EXPLAINER §5.3.
 *
 * ⚠ Line ids are array positions, so a payload and its verdicts are only valid
 * together. Never cache classifications across a re-extraction.
 */
function parseResponse(raw: string, payload: PayloadLine[]): FieldClassification[] {
    // ⚠ Keyed by LINE, not a global set of all refs: "p1l7f0" returned against
    // line p1l3 is a real ref and a wrong answer, and a global check waves it
    // through — putting the mark on another line entirely.
    const refsByLine = new Map<string, Set<string>>(
        payload.map((line) => [line.id, new Set((line.fields ?? []).map((f) => f.ref))]),
    );

    // Models wrap JSON in fences despite being told not to, and it isn't worth
    // a retry loop.
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

    if (COPILOT_DEV) {
        console.log(`[copilot] raw response: ${raw.length} chars`);
        console.log("[copilot] raw:", cleaned);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        throw new Error("The model's answer wasn't readable. Try again.");
    }

    const entries = (parsed as { fields?: unknown }).fields;
    if (!Array.isArray(entries)) {
        throw new Error("The model's answer was missing its field list. Try again.");
    }

    const verdicts: Verdict[] = ["fill", "skip", "unclear"];

    const kept = entries.filter((entry): entry is FieldClassification => {
        if (typeof entry !== "object" || entry === null) return false;

        const e = entry as Record<string, unknown>;

        // ref deliberately NOT checked here — normalised after the filter, so a
        // bad one costs the ref rather than the row.
        return (
            typeof e.id === "string" &&
            refsByLine.has(e.id) &&
            typeof e.fill === "string" &&
            verdicts.includes(e.fill as Verdict) &&
            typeof e.value_or_instruction === "string" &&
            typeof e.reason === "string"
        );
    });

    if (COPILOT_DEV && kept.length !== entries.length) {
        // Set membership, not kept.includes() — includes() inside a filter is
        // quadratic on exactly the input that triggers it.
        const keptSet = new Set<unknown>(kept);
        const dropped = entries.filter((e) => !keptSet.has(e));

        console.warn(
            `[copilot] dropped ${dropped.length} of ${entries.length} classifications.`,
            dropped.slice(0, 3),
        );
    }

    return kept.map((entry) => normaliseRef(entry, refsByLine));
}

/**
 * Keep `ref` only when it names a field on its own line; otherwise delete it —
 * deleted rather than undefined, so the shape matches what a ref-less model
 * produces and downstream has one case to handle.
 */
function normaliseRef(
    entry: FieldClassification,
    refsByLine: Map<string, Set<string>>,
): FieldClassification {
    if (entry.ref === undefined) return entry;

    if (refsByLine.get(entry.id)?.has(entry.ref)) return entry;

    if (COPILOT_DEV) {
        console.warn(
            `[copilot] dropped invalid ref "${entry.ref}" on line ${entry.id}; ` +
            `verdict kept without it.`,
        );
    }

    const { ref: _dropped, ...rest } = entry;
    return rest;
}