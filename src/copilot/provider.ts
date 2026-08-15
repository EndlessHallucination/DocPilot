/**
 * copilot/provider.ts
 *
 * Transport. The ONE place in the extension that sends anything to an AI
 * provider, and therefore the one place to audit when answering "what leaves
 * the browser?"
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 * All of this lived inside classify.ts until §9.7 needed a second caller. It
 * moved out unchanged in behaviour, because the alternative — a second file
 * with its own fetch — is how you end up with two timeout values, two error
 * vocabularies, and the API key logged in one of them but not the other.
 *
 * §9.5's rule is unchanged and now enforced here instead: no UI code contains
 * `if (provider === "openai")`. A caller asks for text and gets text; which
 * provider served it is not its business. Adding a compatible provider stays a
 * one-line change to PROVIDER_CONFIG.
 *
 * ─── WHAT MOVED, AND WHAT DELIBERATELY DID NOT ───────────────────────────
 * Moved: PROVIDER_CONFIG, both request shapes, the AbortController timeout,
 * providerError, describeError.
 *
 * Stayed in classify.ts: the system prompt, the payload projection, and the
 * JSON parsing. Those describe the CLASSIFICATION TASK, not how to talk to a
 * provider — ask.ts brings its own prompt and does no parsing at all. The test
 * for whether something belongs here: would a completely different feature,
 * asking a completely different question, still need it?
 *
 * ─── ⚠ THREE PROVIDERS, TWO REQUEST SHAPES ───────────────────────────────
 * Groq implements OpenAI's Chat Completions contract deliberately, so it
 * shares that path entirely — the only differences are the host, the model
 * name and the token ceiling. Do not add a third branch for it.
 *
 * ─── ⚠ THIS FUNCTION NEVER THROWS ────────────────────────────────────────
 * Every failure comes back as { ok: false, error } carrying a message written
 * for a user, never a thrown error and never a silent hang. §10 lists "visible
 * error if key missing or invalid" as its own checklist item because a spinner
 * that never resolves is the worst possible live failure.
 *
 * A caller that parses the returned text must still wrap ITS OWN parsing in
 * try/catch — a malformed answer is the caller's failure to describe, not
 * this file's. describeError is exported for exactly that.
 *
 * ─── ⚠ NEVER LOG THE KEY ─────────────────────────────────────────────────
 * Not in an error path either. Provider errors surface their status and the
 * RESPONSE body; the request headers never do. No console call in this file
 * takes an argument that could reach the key.
 */

import type { Provider } from "./copilotStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
    url: string;
    model: string;
    openAiCompatible: boolean;
    /**
     * Hard output ceiling for this provider. Per-provider because Groq's free
     * tier counts this toward its tokens-per-minute cap BEFORE the request
     * runs — an unused 8000 still consumes the budget. The Hebrew fixture is
     * ~8,200 input tokens by our count (Groq's own estimator says more) against
     * a 12,000 TPM limit, so anything above ~3,000 is rejected outright with a
     * 413 (§8.18).
     *
     * ⚠ A CEILING, NOT A REQUEST. Callers pass what they actually need and
     * this value only clamps it. The follow-up question box asks for far less,
     * which is what may let it run on Groq where classification cannot.
     */
    maxTokens: number;
}

export interface ProviderRequest {
    /** Task instructions. Owned by the caller — this file has no prompts. */
    system: string;
    /** The user turn. Already assembled; nothing here inspects it. */
    message: string;
    provider: Provider;
    apiKey: string;
    /**
     * Ask for a guaranteed-JSON reply.
     *
     * ⚠ ONLY THE OPENAI-COMPATIBLE PROVIDERS HAVE THIS SWITCH. Anthropic gets
     * the same result by instruction alone, which is an asymmetry worth
     * keeping rather than papering over: classify.ts's parser strips markdown
     * fences and tolerates both, and pretending the two are identical would
     * hide the fact that only one of them is enforced by the API.
     *
     * false for prose answers. Passing true and then not parsing JSON gets you
     * a reply wrapped in a pointless object.
     */
    json: boolean;
    /** Desired reply length. Clamped down to the provider's ceiling, never up. */
    maxTokens: number;
    /**
     * How long to wait before giving up.
     *
     * Deliberately a parameter, not a constant. A whole document is a real
     * amount of thinking and earns 90s; a typed question with a user watching
     * the box does not — at 90s they will assume it is broken and reload,
     * which loses the extraction and every annotation on the page.
     */
    timeoutMs: number;
}

export type ProviderResult =
    | { ok: true; text: string }
    | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Endpoint and model per provider. ONE PLACE, because these names move and a
 * stale one produces a 404 that reads like a broken integration.
 *
 * ⚠ VERIFY BEFORE A DEMO. Groq's catalogue rotates fastest — check
 * console.groq.com/docs/models.
 */
export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Send one request and return the model's text.
 *
 * No retries, on purpose. Every failure this can hit is either permanent
 * within the next few seconds (a bad key, a payload too large) or something
 * the user should be told about rather than have silently doubled behind their
 * back — a retried classification on Groq's free tier is the fastest way to
 * turn one 429 into two.
 */
export async function callProvider(request: ProviderRequest): Promise<ProviderResult> {
    if (!request.apiKey.trim()) {
        return { ok: false, error: "No API key. Add one above to use the copilot." };
    }

    const config = PROVIDER_CONFIG[request.provider];

    // Clamp, never raise. A caller asking for 8000 on Groq gets 3000 and a
    // truncated answer; a caller asking for 8000 on Groq and GETTING it gets a
    // 413 before the model runs at all (§8.18).
    const maxTokens = Math.min(request.maxTokens, config.maxTokens);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
        const text = config.openAiCompatible
            ? await callOpenAiCompatible(request, config, maxTokens, controller.signal)
            : await callAnthropic(request, config, maxTokens, controller.signal);

        return { ok: true, text };
    } catch (error) {
        return { ok: false, error: describeError(error, request.timeoutMs) };
    } finally {
        // In finally, not after the await — an early return or a throw would
        // otherwise leave the timer live and abort a LATER request, which
        // presents as a random timeout on a request that never had a problem.
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

async function callAnthropic(
    request: ProviderRequest,
    config: ProviderConfig,
    maxTokens: number,
    signal: AbortSignal,
): Promise<string> {
    const response = await fetch(config.url, {
        method: "POST",
        signal,
        headers: {
            "content-type": "application/json",
            "x-api-key": request.apiKey,
            "anthropic-version": "2023-06-01",
            // ⚠ REQUIRED FOR BROWSER CALLS. Without it the API rejects the
            // request on CORS grounds and the failure arrives as a TypeError,
            // i.e. looks like the network is down (§8.19).
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.message }],
            // No response_format here — see ProviderRequest.json. Anthropic is
            // instructed to return JSON by the prompt instead.
        }),
    });

    if (!response.ok) throw await providerError(response);

    const data = await response.json();

    // content is an ARRAY OF BLOCKS; concatenate the text ones rather than
    // assuming content[0]. A refusal or a stop-reason block sitting first
    // would otherwise return empty and look like the model said nothing.
    return (data.content ?? [])
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("");
}

/**
 * The OpenAI Chat Completions shape, used by OpenAI and by Groq.
 *
 * Sharing this function is what keeps adding a compatible provider a one-line
 * change to PROVIDER_CONFIG rather than a new branch here.
 */
async function callOpenAiCompatible(
    request: ProviderRequest,
    config: ProviderConfig,
    maxTokens: number,
    signal: AbortSignal,
): Promise<string> {
    const response = await fetch(config.url, {
        method: "POST",
        signal,
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            max_completion_tokens: maxTokens,
            // Spread rather than a literal `undefined`: some OpenAI-compatible
            // hosts validate the key's presence rather than its value, and a
            // null response_format is rejected by more of them than a missing
            // one.
            ...(request.json ? { response_format: { type: "json_object" } } : {}),
            messages: [
                { role: "system", content: request.system },
                { role: "user", content: request.message },
            ],
        }),
    });

    if (!response.ok) throw await providerError(response);

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
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
    // than requests-per-minute, and a whole document is one large request — so
    // "wait a moment" is the right advice but "send less" may be what's needed.
    if (response.status === 429) {
        return new Error("Rate limited by the provider. Wait a moment and try again.");
    }

    // Groq's 413 body names both the limit and the amount requested, which is
    // the only way to tell a too-long document from a too-high maxTokens.
    // Surfaced rather than swallowed for that reason (§8.18).
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

/**
 * Exported so callers can describe failures in their OWN try/catch with the
 * same vocabulary — classify.ts's JSON parsing throws after this file has
 * already returned successfully, and those messages should not read like they
 * came from a different application.
 *
 * timeoutMs is passed rather than read from a constant so the message states
 * the limit that actually applied, which differs per caller.
 */
export function describeError(error: unknown, timeoutMs: number): string {
    if (error instanceof DOMException && error.name === "AbortError") {
        return `The request took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`;
    }

    if (error instanceof TypeError) {
        // fetch rejects with TypeError for network failure AND for CORS. On
        // this extension that almost always means host_permissions is missing
        // the provider's origin — and Chrome does not apply manifest permission
        // changes on hot reload, so the extension must be reloaded (§8.19).
        return "Couldn't reach the provider. Check your connection and that the extension is allowed to call it.";
    }

    return error instanceof Error ? error.message : "Something went wrong.";
}