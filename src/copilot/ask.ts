/**
 * copilot/ask.ts
 *
 * The follow-up question box: a free-text question about the form, answered in
 * prose with the document already in context. Markers answer "what goes in this
 * field"; this answers "what does this term mean" and "does this option apply
 * to me". EXPLAINER §5.6.
 *
 * Also the network-failure fallback — see the note on independence below.
 */

import { callProvider } from "./provider";
import { projectLines, type UserContext } from "./classify";
import type { PayloadLine } from "./detect-field";
import type { Provider } from "./copilotStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One completed exchange. Stored in copilotStore, in memory only. */
export interface AskTurn {
    question: string;
    answer: string;
}

export type AskResult =
    | { ok: true; answer: string }
    | { ok: false; error: string };

export interface AskRequest {
    payload: PayloadLine[];
    context: UserContext;
    /** Prior exchanges, oldest first. Only the tail is actually sent. */
    history: AskTurn[];
    question: string;
    provider: Provider;
    apiKey: string;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * ⚠ Much shorter than classify.ts's 180s, deliberately. A user watching a
 * question box assumes a long wait means "broken" and reloads — which loses the
 * extraction AND every annotation, since nothing persists across a refresh.
 */
const ASK_TIMEOUT_MS = 45_000;

/** A few paragraphs, not a document. */
const ASK_MAX_TOKENS = 1_200;

/**
 * Every follow-up re-sends the whole document — there is no server and no
 * conversation state, so the model starts from nothing each time. Unbounded
 * history means cost grows per question until the request is rejected.
 */
const MAX_HISTORY_TURNS = 3;

/** Prior answers are truncated when resent; questions are kept whole. */
const HISTORY_ANSWER_CHARS = 500;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are helping a person understand a bureaucratic form
they are filling in. They can see the form; you are answering a specific
question about it.

You receive every line of the form in reading order, each with an id, and the
person's own description of their situation.

Rules:

1. LANGUAGE. Write your answer in English, whatever language the question was
   asked in. The one exception: if you tell them a literal value to write on
   the form, that value stays in the form's own language and script. A Hebrew
   form needs Hebrew values, because that is what the receiving authority
   expects. So: an English sentence containing a Hebrew value is correct.

2. Answer from the document and from what the person has told you about their
   situation. If the answer depends on a rule, a threshold or a date that is
   not stated in the document, say so plainly instead of supplying one from
   memory. Being wrong about eligibility on this kind of form costs the person
   money.

3. Point them at the part of the form you mean — the section letter or heading,
   or a few words of the line. Do not quote line ids; they are internal and
   mean nothing to the reader.

4. Be brief. A few sentences. This is a narrow panel beside the document, not a
   report.

5. If a line is marked "unreliableText", some of its characters may have been
   read incorrectly. Say so rather than guessing what it said.

6. If the question cannot be answered from this form at all, say that in one
   sentence rather than answering a different question.

Reply in plain text. No markdown, no headings, no bullet lists.`;

/**
 * Assemble the single user turn.
 *
 * ⚠ History is flattened into TEXT, not sent as chat roles. ProviderRequest
 * carries one message by design. If follow-ups start losing the thread, add a
 * messages array to ProviderRequest — don't special-case it here.
 *
 * ⚠ Uses projectLines, the same function classify.ts uses. That is the only
 * serialisation of document data in the codebase; a second one here would mean
 * two places a coordinate could leak. EXPLAINER §5.1.
 */
function buildUserMessage(request: AskRequest): string {
    const { payload, context, history, question } = request;

    const parts: string[] = [
        `What this document is: ${context.documentDescription || "(not stated)"}`,
        `What the person needs to do: ${context.goal || "(not stated)"}`,
        "",
        "Form lines:",
        JSON.stringify(projectLines(payload)),
    ];

    const recent = history.slice(-MAX_HISTORY_TURNS);

    if (recent.length > 0) {
        parts.push("", "Earlier in this conversation:");

        for (const turn of recent) {
            parts.push(
                `Q: ${turn.question}`,
                `A: ${truncate(turn.answer, HISTORY_ANSWER_CHARS)}`,
            );
        }
    }

    parts.push("", `Their question now: ${question}`);

    return parts.join("\n");
}

function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * ⚠ Reads no classification state, by design. This must keep answering when
 * classification has failed or never run — that is what makes it the live
 * fallback. Don't gate it. EXPLAINER §5.6.
 */
export async function askQuestion(request: AskRequest): Promise<AskResult> {
    const question = request.question.trim();

    if (question === "") {
        return { ok: false, error: "Type a question first." };
    }

    // No key check — provider.ts rejects an empty key with the message the user
    // needs, and duplicating it means two strings to keep in step.
    const result = await callProvider({
        system: SYSTEM_PROMPT,
        message: buildUserMessage({ ...request, question }),
        provider: request.provider,
        apiKey: request.apiKey,
        json: false,
        maxTokens: ASK_MAX_TOKENS,
        timeoutMs: ASK_TIMEOUT_MS,
    });

    if (!result.ok) return { ok: false, error: result.error };

    const answer = result.text.trim();

    // A successful call returning nothing is rare but real, and an empty bubble
    // reads as the app dropping the answer rather than the model producing none.
    if (answer === "") {
        return { ok: false, error: "The model didn't return an answer. Try rephrasing." };
    }

    return { ok: true, answer };
}