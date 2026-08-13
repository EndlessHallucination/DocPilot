/**
 * copilot/classify.ts
 *
 * §9.3 — sends the document's text to the model and gets back a verdict per
 * field. The ONE function that talks to a provider.
 *
 * ─── ⚠ ONE FUNCTION, BRANCHING INTERNALLY ────────────────────────────────
 * getFieldClassifications is the only export that calls out. §9.5: never
 * scatter `if (provider === 'openai')` through UI code. A component asks for
 * classifications and gets classifications; which provider served them is not
 * its business, and keeping it that way is what makes adding a provider a
 * change to PROVIDER_CONFIG rather than a change everywhere.
 *
 * Groq speaks OpenAI's Chat Completions contract, so it shares that code path
 * entirely — the only differences are the host and the model name. There are
 * three providers but only TWO request shapes.
 *
 * ─── ⚠ EVERY LINE GOES, NOT A FILTERED LIST OF BLANKS ────────────────────
 * The payload is all ~124 lines including headings, fine print and the address
 * block. That is the design, not laziness (§3.1). Geometry cannot find a field
 * created by a heading that says "mark the relevant options below", and the
 * fixture has nine eligibility clauses with only eight checkboxes drawn — a
 * filtered list silently loses the ninth. The model reads everything and
 * decides.
 *
 * ─── ⚠ COORDINATES NEVER LEAVE ───────────────────────────────────────────
 * PayloadLine carries no geometry by construction, and buildUserMessage
 * re-projects each line field by field rather than spreading the object, so a
 * coordinate added to PayloadLine later cannot silently start being uploaded.
 * That is the entire privacy claim: text out, positions stay.
 *
 * ─── ⚠ NEVER LOG THE KEY ─────────────────────────────────────────────────
 * Not in an error path either. Provider errors surface their status and the
 * response body; the request headers never do.
 */

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

interface ProviderConfig {
    url: string;
    model: string;
    openAiCompatible: boolean;
    /**
     * Output ceiling. Per-provider because Groq's free tier counts this
     * toward its tokens-per-minute cap BEFORE the request runs — an unused
     * 8000 still consumes the budget. The Hebrew fixture is ~8,200 input
     * tokens against a 12,000 TPM limit, so anything above ~3,500 is
     * rejected outright with a 413.
     */
    maxTokens: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Endpoint and model per provider. ONE PLACE, because these names move and a
 * stale one produces a 404 that reads like a broken integration.
 *
 * Verify before a demo. Groq's catalogue rotates fastest — check
 * console.groq.com/docs/models.
 */
const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
    anthropic: {
        url: "https://api.anthropic.com/v1/messages",
        model: "claude-sonnet-5",
        openAiCompatible: false,
        maxTokens: 8000,
    },
    openai: {
        url: "https://api.openai.com/v1/chat/completions",
        model: "gpt-5.6",
        openAiCompatible: true,
        maxTokens: 8000,

    },
    groq: {
        url: "https://api.groq.com/openai/v1/chat/completions",
        model: "llama-3.3-70b-versatile",
        openAiCompatible: true,
        maxTokens: 3000,

    },
};

/**
 * A whole document's worth of verdicts. 124 lines × a short object each needs
 * real room, and a truncated response is unparseable JSON — which surfaces as
 * "the model returned something unreadable" rather than as the length problem
 * it actually is.
 *
 * ⚠ Groq's free tier caps TOKENS PER MINUTE (12K on llama-3.3-70b-versatile),
 * and Hebrew tokenizes badly. Input plus this ceiling can exceed the cap in a
 * single request. Lower it to ~4000 if Groq starts returning 429s.
 */

/**
 * Past this, give up and say so. §9.6 requires a timeout on web search for the
 * same reason it's needed here: no network call may hang the UI. Generous
 * because a full document is a real amount of thinking.
 */
const TIMEOUT_MS = 90_000;

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

function buildUserMessage(payload: PayloadLine[], context: UserContext): string {
    // Projected field by field rather than JSON.stringify(payload). If a
    // coordinate is ever added to PayloadLine, a spread would upload it
    // silently; this cannot.
    const lines = payload.map((line) => ({
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

    return [
        `What this document is: ${context.documentDescription || "(not stated)"}`,
        `What the person needs to do: ${context.goal || "(not stated)"}`,
        "",
        "Form lines:",
        JSON.stringify(lines),
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
    if (!apiKey.trim()) {
        return { ok: false, error: "No API key. Add one above to use the copilot." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const message = buildUserMessage(payload, context);
        const config = PROVIDER_CONFIG[provider];

        const raw = config.openAiCompatible
            ? await callOpenAiCompatible(message, apiKey, config, controller.signal)
            : await callAnthropic(message, apiKey, config, controller.signal);

        return { ok: true, classifications: parseResponse(raw, payload) };
    } catch (error) {
        return { ok: false, error: describeError(error) };
    } finally {
        // In finally, not after the await — an early return or a throw would
        // otherwise leave the timer live and abort a later request.
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function callAnthropic(
    message: string,
    apiKey: string,
    config: ProviderConfig,
    signal: AbortSignal,
): Promise<string> {
    const response = await fetch(config.url, {
        method: "POST",
        signal,
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            // ⚠ REQUIRED FOR BROWSER CALLS. Without it the API rejects the
            // request on CORS grounds and the error looks like a network
            // failure rather than a missing header.
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: message }],
        }),
    });

    if (!response.ok) throw await providerError(response);

    const data = await response.json();

    // content is an array of blocks; concatenate the text ones rather than
    // assuming content[0].
    return (data.content ?? [])
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("");
}

/**
 * The OpenAI Chat Completions shape, used by OpenAI and by Groq.
 *
 * Groq implements the same contract deliberately, so sharing this function is
 * what keeps adding a compatible provider a one-line change to
 * PROVIDER_CONFIG rather than a new branch here.
 */
async function callOpenAiCompatible(
    message: string,
    apiKey: string,
    config: ProviderConfig,
    signal: AbortSignal,
): Promise<string> {
    const response = await fetch(config.url, {
        method: "POST",
        signal,
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            max_completion_tokens: config.maxTokens,
            // Guarantees parseable JSON. Anthropic gets the same result by
            // instruction alone — an asymmetry that's fine to keep, since
            // parseResponse tolerates both.
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: message },
            ],
        }),
    });

    if (!response.ok) throw await providerError(response);

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
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
 */
function parseResponse(raw: string, payload: PayloadLine[]): FieldClassification[] {
    const known = new Set(payload.map((line) => line.id));

    // Models wrap JSON in markdown fences despite being told not to, and the
    // instruction is not worth a retry loop.
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
        const dropped = entries.filter((e) => !kept.includes(e as FieldClassification));

        console.warn(
            `[copilot] dropped ${dropped.length} of ${entries.length} classifications.`,
            dropped.slice(0, 3),
        );
    }

    return kept;

}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turn a provider failure into something a user can act on.
 *
 * Status codes are mapped by hand because the raw bodies are unhelpful at
 * exactly the moments that matter: a 401 during a demo needs to say "your key
 * was rejected", not surface a JSON error object.
 */
async function providerError(response: Response): Promise<Error> {
    if (response.status === 401 || response.status === 403) {
        return new Error("The provider rejected your API key. Check it and try again.");
    }

    // On Groq's free tier a 429 is usually the TOKENS-per-minute cap rather
    // than requests-per-minute, and a whole document is one large request —
    // so "wait a moment" is the right advice but "send less" may be needed.
    if (response.status === 429) {
        return new Error("Rate limited by the provider. Wait a moment and try again.");
    }

    if (response.status === 413) {
        const body = await response.text().catch(() => "");
        return new Error(
            `Too large for this provider's per-minute limit. ${body.slice(0, 300)}`,
        );
    }

    if (response.status >= 500) {
        return new Error("The provider is having trouble. Try again shortly.");
    }

    // Body only as a fallback, and never the request — the key is in the
    // headers we sent, never in the response.
    const body = await response.text().catch(() => "");
    return new Error(`Provider error ${response.status}. ${body.slice(0, 200)}`);
}

function describeError(error: unknown): string {
    if (error instanceof DOMException && error.name === "AbortError") {
        return `The request took longer than ${TIMEOUT_MS / 1000} seconds and was stopped.`;
    }

    if (error instanceof TypeError) {
        // fetch rejects with TypeError for network failure AND for CORS. On
        // this extension that almost always means host_permissions is missing
        // the provider's origin.
        return "Couldn't reach the provider. Check your connection and that the extension is allowed to call it.";
    }

    return error instanceof Error ? error.message : "Something went wrong.";
}