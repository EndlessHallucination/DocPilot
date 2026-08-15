/**
 * copilot/ask.ts
 *
 * §9.7 — the follow-up question box. The user types a question about the form
 * and gets a prose answer, with the document already in context.
 *
 * ─── WHY THIS EXISTS ALONGSIDE classify.ts ───────────────────────────────
 * Markers answer "what goes in this field". They cannot answer "what does
 * מס שבירה mean", or "I have a loan against the account — does that change
 * which box I tick". Those are the questions that actually stop someone
 * filling a form, and they have no coordinate to attach to.
 *
 * It also doubles as §10's network-failure fallback. A working question box is
 * a far better live recovery than narrating screenshots, and it works even
 * when classification has never run or failed — nothing here reads
 * `classifications` or `status`.
 *
 * ─── ⚠ ENGLISH ANSWERS, HEBREW VALUES ────────────────────────────────────
 * §9.3 splits language by FIELD (reason in the user's language, value in the
 * form's). That split doesn't transfer, because a follow-up answer is all
 * explanation. So the rule here is simpler and stricter: answer in English,
 * EXCEPT a literal value the user should type, which stays in the form's
 * script.
 *
 * Hardcoded rather than inherited from the user's phrasing, because a Hebrew
 * document plus a question containing Hebrew terms pulls hard toward a Hebrew
 * answer and "the language they wrote in" is genuinely ambiguous when the
 * question is half Hebrew. §10 wants English explanations on demo day. One
 * line to change if an Israeli end user should get Hebrew later.
 *
 * ─── ⚠ NO PARSING ────────────────────────────────────────────────────────
 * The answer is prose and is rendered as-is. json: false — asking an
 * OpenAI-compatible provider for a JSON object and then not parsing it gets
 * you an answer wrapped in a pointless envelope.
 *
 * ─── DELIBERATELY NOT SENT: the classifications ──────────────────────────
 * "Why did you say skip on this line" is a natural question this cannot
 * currently answer well, since the verdicts aren't in context. Left out of v1
 * on token cost: a full verdict set is comparable in size to the document
 * itself, and the Hebrew fixture is already near Groq's ceiling (§8.18). If it
 * goes in later, send only the verdicts for lines the question plausibly
 * refers to, never all of them.
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
 * Much shorter than classify.ts's 90s, on purpose. A user watching a question
 * box will assume 90 seconds means "broken" and hit reload — which loses the
 * extraction AND every annotation on the page, since nothing persists across a
 * refresh (§4). A short answer that fails fast is recoverable; a reload is not.
 */
const ASK_TIMEOUT_MS = 45_000;

/**
 * A few paragraphs, not a document.
 *
 * ⚠ THIS IS THE TERM THAT MIGHT LET GROQ RUN THE HEBREW FIXTURE. Groq's free
 * tier counts the requested output against its 12,000 TPM cap BEFORE the
 * request runs, and classification's 3,000 is what puts the Hebrew document
 * over (§8.18). 1,200 may squeak under where 3,000 cannot — worth trying once,
 * but do not plan the demo around it: Groq's own estimator put the fixture's
 * input higher than our count did, so it is genuinely marginal.
 */
const ASK_MAX_TOKENS = 1_200;

/**
 * How many prior exchanges to resend.
 *
 * Every follow-up re-sends the whole document — there is no server and no
 * conversation state anywhere, so the model starts from nothing each time.
 * Unbounded history means cost grows with every question until the request is
 * rejected mid-demo. Three is enough for "and what about the other option?"
 * to resolve, and keeps the cost flat.
 */
const MAX_HISTORY_TURNS = 3;

/**
 * Prior ANSWERS are truncated when resent. They can be a thousand characters
 * each, and three of them would rival the document. Questions are kept whole —
 * they are one line, and they are what makes the thread make sense.
 */
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
 * ⚠ HISTORY IS FLATTENED INTO TEXT, not sent as chat roles. ProviderRequest
 * carries one message by design, and three short exchanges against a ~12,000
 * character document gain almost nothing from role structure. If follow-ups
 * start losing the thread, the fix is to give ProviderRequest a messages array
 * and map it in both request shapes — not to special-case it here.
 *
 * ⚠ The document goes through projectLines, the SAME function classify.ts
 * uses. That is the only thing standing between PayloadLine and an uploaded
 * coordinate, and a second serialisation written here would mean two places to
 * audit forever (§3.2).
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

export async function askQuestion(request: AskRequest): Promise<AskResult> {
    const question = request.question.trim();

    // Cheaper than a round trip, and a provider error for an empty prompt
    // reads like the integration is broken rather than like nothing was typed.
    if (question === "") {
        return { ok: false, error: "Type a question first." };
    }

    // No key check — provider.ts rejects an empty key with the message the
    // user needs, and duplicating it means two strings to keep in step.
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

    // A successful call returning nothing is rare but real — a model can stop
    // on its first token, and an empty bubble in the thread looks like the app
    // dropped the answer rather than like the model produced none.
    if (answer === "") {
        return { ok: false, error: "The model didn't return an answer. Try rephrasing." };
    }

    return { ok: true, answer };
}