/**
 * copilot/classify.ts
 *
 * §9.3 — sends the document's text to the model and gets back a verdict per
 * field.
 *
 * ─── WHAT THIS FILE IS NOW ───────────────────────────────────────────────
 * The classification TASK: its prompt, how the payload is turned into a
 * message, and how the answer is validated. Talking to a provider moved to
 * provider.ts when §9.7 needed a second caller — endpoints, request shapes,
 * timeouts and error vocabulary all live there.
 *
 * §9.5's rule survives the split unchanged: no UI code contains
 * `if (provider === "openai")`. A component asks for classifications and gets
 * classifications.
 *
 * ─── ⚠ EVERY LINE GOES, NOT A FILTERED LIST OF BLANKS ────────────────────
 * The payload is all ~124 lines including headings, fine print and the address
 * block. That is the design, not laziness (§3.1). Geometry cannot find a field
 * created by a heading that says "mark the relevant options below", and the
 * fixture has nine eligibility clauses with only eight checkboxes drawn — a
 * filtered list silently loses the ninth. The W-9 proves it harder: that form
 * draws no rectangles at all, and the model still returned "fill in" for line
 * 1, which has no detectable affordance of any kind (§8.17).
 *
 * ─── ⚠ COORDINATES NEVER LEAVE — AND projectLines IS THE PROOF ───────────
 * PayloadLine carries no geometry by construction, and projectLines rebuilds
 * each line FIELD BY FIELD rather than spreading it, so a coordinate added to
 * PayloadLine later cannot silently start being uploaded.
 *
 * It is exported for ask.ts (§9.7) deliberately. A second feature writing its
 * own serialisation would create a second place a coordinate could leak, and
 * you would have to audit both forever. One function, one audit.
 */

import { callProvider, describeError } from "./provider";
import type { PayloadLine } from "./detect-field";
import type { Provider } from "./copilotStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = "fill" | "skip" | "unclear";

export interface FieldClassification {
    /** A line id from the payload. Never invented — unknown ids are dropped. */
    id: string;
    fill: Verdict;
    /** The literal value to write, or an instruction if a value can't be known. */
    value_or_instruction: string;
    /** Why, in the user's language. */
    reason: string;
}

/**
 * Success or a readable failure — never a thrown error and never a silent
 * hang. §10 lists "visible error if key missing or invalid" as its own demo
 * checklist item because a spinner that never resolves is the worst possible
 * live failure.
 */
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

/**
 * Past this, give up and say so. Generous because a full document is a real
 * amount of thinking — 124 lines of verdicts is not a chat reply.
 *
 * ⚠ Deliberately different from ask.ts's, which is much shorter. A user
 * watching a question box will assume 90 seconds means "broken" and reload,
 * which loses the extraction and every annotation on the page.
 */
const CLASSIFY_TIMEOUT_MS = 90_000;

/**
 * A whole document's worth of verdicts needs real room: 124 lines × a short
 * object each. A truncated response is unparseable JSON, which surfaces as
 * "the model returned something unreadable" rather than as the length problem
 * it actually is.
 *
 * A REQUEST, NOT A GUARANTEE — provider.ts clamps this down to the provider's
 * own ceiling. Groq's is 3000 (§8.18), which is why Groq cannot run the Hebrew
 * fixture at all and is for pipeline testing on Latin documents only.
 */
const CLASSIFY_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * ⚠ THE LANGUAGE SEPARATION IS THE MOST IMPORTANT RULE HERE.
 *
 * The EXPLANATION goes in the user's language — they need to understand it.
 * The VALUE stays in the document's language and script. A name or address
 * written in English on a Hebrew form gets the submission rejected, because
 * the authority expects Hebrew. The model will not do this reliably unless
 * told explicitly, and the failure is invisible to a demo audience who can't
 * read Hebrew.
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

2. A line with no "fields" entry may still be a field. Absence of an entry
   means unknown, never "there is nothing here". Some options on a form have no
   box printed beside them, and instructions like "mark the relevant options
   below" create fields that cannot be detected mechanically.

3. Use the person's stated situation to decide which options apply to THEM.
   Do not describe every option neutrally — say which ones they should mark.

4. LANGUAGE. Write "reason" in the language the person used. Write
   "value_or_instruction" in the language and script of the FORM. A Hebrew form
   needs Hebrew values, including names and addresses, because that is what the
   receiving authority expects.

5. For a "cells" field, return exactly "count" characters. A 6-cell date is
   DDMMYY; an 8-cell date is DDMMYYYY.

6. Never invent an id. Only use ids given to you.

7. If a line is marked "unreliableText", some characters may have been read
   incorrectly. Treat it with caution and say so rather than guessing.

Return ONLY a JSON object, no prose and no markdown fences:
{"fields":[{"id":"p1l3","fill":"fill|skip|unclear","value_or_instruction":"...","reason":"..."}]}

- "fill": the person should act on this line
- "skip": it is a field but does not apply to them, with the reason why
- "unclear": you cannot tell without information they haven't given`;

/**
 * Turn the payload into the plain objects that get serialised and uploaded.
 *
 * ⚠ THIS IS THE PRIVACY BOUNDARY. Everything above it may hold coordinates;
 * nothing below it does. Rebuilt field by field rather than spread for exactly
 * that reason — `{ ...line }` would upload any property added to PayloadLine
 * later, silently and forever.
 *
 * Cell counts DO go, because they change the answer: "nine cells, one
 * character each" produces nine digits, and a six-cell date wants DDMMYY where
 * an eight-cell one wants DDMMYYYY (§3.2). The model cannot know which without
 * being told, and the text layer does not contain it.
 *
 * Exported for ask.ts. Do not write a second one.
 */
export function projectLines(payload: PayloadLine[]) {
    return payload.map((line) => ({
        id: line.id,
        page: line.page,
        text: line.text,
        ...(line.fields
            ? {
                fields: line.fields.map((f) => ({
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
    // No key check here — provider.ts rejects an empty key with the message
    // the user needs, and duplicating it means two strings to keep in step.
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

    // ⚠ THE PARSE NEEDS ITS OWN try/catch. callProvider has already returned
    // successfully by this point, so a malformed answer throws out of THIS
    // function, not out of the transport. Losing this catch turns a bad reply
    // into an unhandled rejection and the panel spins forever.
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
 * Parse the model's JSON and discard anything that can't be trusted.
 *
 * ⚠ IDS ARE VALIDATED AGAINST THE PAYLOAD. A hallucinated id has no entry in
 * detect-fields' geometry map, so a marker for it has nowhere to go. Dropping
 * it here means the failure is one missing row rather than an undefined rect
 * reaching the annotation layer.
 *
 * ⚠ IDS ARE ARRAY POSITIONS (§8.14). They shift whenever line splitting
 * changes, so a payload and its verdicts are only valid together. Never cache
 * classifications across a re-extraction.
 */
function parseResponse(raw: string, payload: PayloadLine[]): FieldClassification[] {
    const known = new Set(payload.map((line) => line.id));

    // Models wrap JSON in markdown fences despite being told not to, and the
    // instruction is not worth a retry loop. Anthropic needs this; the
    // OpenAI-compatible providers are held to it by response_format.
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

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

        return (
            typeof e.id === "string" &&
            known.has(e.id) &&
            typeof e.fill === "string" &&
            verdicts.includes(e.fill as Verdict) &&
            typeof e.value_or_instruction === "string" &&
            typeof e.reason === "string"
        );
    });

    if (import.meta.env.DEV && kept.length !== entries.length) {
        // Set membership, not kept.includes() — includes() is a linear scan
        // inside a filter, so the old version was quadratic on the exact input
        // that triggers it (a model returning many bad rows).
        const keptSet = new Set<unknown>(kept);
        const dropped = entries.filter((e) => !keptSet.has(e));

        console.warn(
            `[copilot] dropped ${dropped.length} of ${entries.length} classifications.`,
            dropped.slice(0, 3),
        );
    }

    return kept;
}