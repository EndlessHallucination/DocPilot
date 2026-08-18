/**
 * copilot/provider.ts
 *
 * Transport. The ONE place that sends anything to an AI provider, and therefore
 * the one place to audit when answering "what leaves the browser?"
 *
 * Owns endpoints, both request shapes, the timeout and the error vocabulary.
 * Prompts and parsing belong to the callers — the test for whether something
 * belongs here is whether a completely different feature asking a completely
 * different question would still need it.
 *
 * ⚠ NO UI CODE MAY CONTAIN `if (provider === "openai")`. A caller asks for text
 * and gets text. Adding a compatible provider stays a one-line change to
 * PROVIDER_CONFIG.
 *
 * ⚠ NEVER LOG THE KEY, not in an error path either. Provider errors surface
 * their status and the RESPONSE body; the request headers never do.
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
     * Hard output ceiling for this provider.
     *
     * ⚠ A CEILING, NOT A REQUEST — callers pass what they need and this only
     * clamps it. Per-provider because Groq's free tier counts this toward its
     * tokens-per-minute cap BEFORE the request runs, so an unused 8000 still
     * consumes the budget and gets rejected outright.
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
     * ⚠ ONLY THE OPENAI-COMPATIBLE PROVIDERS HAVE THIS SWITCH. Anthropic gets the
     * same result by instruction alone. That asymmetry is worth keeping visible
     * rather than papering over — only one of them is enforced by the API, and
     * classify.ts's parser strips fences because of it.
     */
    json: boolean;
    /** Desired reply length. Clamped DOWN to the provider's ceiling, never up. */
    maxTokens: number;
    /**
     * ⚠ A parameter, not a constant, because the right value differs per caller: a
     * whole document earns minutes; a typed question with a user watching the box
     * does not, because they will reload and lose the extraction.
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
 * ⚠ VERIFY BEFORE A DEMO. Groq's catalogue rotates fastest.
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
 * ⚠ NEVER THROWS. Every failure comes back as { ok: false, error } with a message
 * written for a user — a spinner that never resolves is the worst possible live
 * failure. A caller that PARSES the returned text must still wrap its own parsing
 * in try/catch; describeError is exported for that.
 *
 * No retries, on purpose. Every failure here is either permanent within the next
 * few seconds or something the user should be told about rather than have
 * silently doubled — a retried classification on a free tier turns one 429 into
 * two.
 */
export async function callProvider(request: ProviderRequest): Promise<ProviderResult> {
    if (!request.apiKey.trim()) {
        return { ok: false, error: "No API key. Add one above to use the copilot." };
    }

    const config = PROVIDER_CONFIG[request.provider];

    // ⚠ Clamp, never raise. Asking for 8000 where the ceiling is 3000 yields a
    // truncated answer; actually SENDING 8000 there is rejected before the model
    // runs at all.
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
        // ⚠ In finally, not after the await. An early return or a throw would leave
        // the timer live and abort a LATER request, presenting as a random timeout
        // on a request that never had a problem.
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
            // ⚠ REQUIRED FOR BROWSER CALLS, extension and web alike. Without it the
            // API rejects on CORS grounds and the failure arrives as a TypeError —
            // i.e. looks like the network is down.
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.message }],
            // No response_format — see ProviderRequest.json.
        }),
    });

    if (!response.ok) throw await providerError(response);

    const data = await response.json();

    // ⚠ Keep this. It distinguishes "ran out of room" from "chose to stop", which
    // was the measurement that killed two wrong theories about truncation.
    if (data.stop_reason && data.stop_reason !== "end_turn") {
        console.warn(`[copilot] stop_reason: ${data.stop_reason}`);
    }

    // ⚠ content is an ARRAY OF BLOCKS — concatenate the text ones rather than
    // assuming content[0]. A refusal or stop block sitting first would otherwise
    // return empty and look like the model said nothing.
    return (data.content ?? [])
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("");
}

/**
 * The OpenAI Chat Completions shape, used by OpenAI AND Groq.
 *
 * ⚠ Groq implements this contract deliberately — same body, same response shape.
 * Do not add a third branch for it; sharing this function is what keeps adding a
 * provider a one-line config change.
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
            // Spread rather than a literal undefined: some compatible hosts
            // validate the key's presence rather than its value, and reject a null
            // response_format where they'd accept a missing one.
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
 * Turn a provider failure into something a user can act on. Mapped by hand
 * because the raw bodies are unhelpful at exactly the moments that matter — a 401
 * mid-demo needs to say "your key was rejected", not surface a JSON object.
 */
async function providerError(response: Response): Promise<Error> {
    if (response.status === 401 || response.status === 403) {
        return new Error("The provider rejected your API key. Check it and try again.");
    }

    // On a free tier a 429 is usually the TOKENS-per-minute cap rather than
    // requests-per-minute, and a whole document is one large request — so waiting
    // is the right advice but sending less may be what's needed.
    if (response.status === 429) {
        return new Error("Rate limited by the provider. Wait a moment and try again.");
    }

    // ⚠ The 413 body names both the limit and the amount requested, which is the
    // only way to tell a too-long document from a too-high maxTokens. Surfaced
    // rather than swallowed for that reason.
    if (response.status === 413) {
        const body = await response.text().catch(() => "");
        return new Error(
            `Too large for this provider's per-minute limit. ${body.slice(0, 300)}`,
        );
    }

    if (response.status >= 500) {
        return new Error("The provider is having trouble. Try again shortly.");
    }

    // Body only as a fallback, and never the request — the key is in the headers
    // we sent, never in the response.
    const body = await response.text().catch(() => "");
    return new Error(`Provider error ${response.status}. ${body.slice(0, 200)}`);
}

/**
 * Exported so callers can describe failures in their OWN try/catch with the same
 * vocabulary — classify.ts's parsing throws after this file has already returned
 * successfully, and those messages shouldn't read like a different application.
 *
 * timeoutMs is passed rather than read from a constant so the message states the
 * limit that actually applied, which differs per caller.
 */
export function describeError(error: unknown, timeoutMs: number): string {
    if (error instanceof DOMException && error.name === "AbortError") {
        return `The request took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`;
    }

    if (error instanceof TypeError) {
        // ⚠ fetch rejects with TypeError for network failure AND for CORS. In the
        // extension that usually means host_permissions is missing the provider's
        // origin — and Chrome does not apply manifest permission changes on hot
        // reload, so the extension must be reloaded.
        return "Couldn't reach the provider. Check your connection and that the extension is allowed to call it.";
    }

    return error instanceof Error ? error.message : "Something went wrong.";
}