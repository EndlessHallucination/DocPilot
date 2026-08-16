/**
 * copilot/copilotStore.ts
 *
 * Provider credentials, the user's stated situation, and the copilot's two
 * results: per-field classifications (§9.3) and the follow-up question thread
 * (§9.7). Separate from annotationStore, deliberately — an AI response must
 * never mark the document dirty.
 *
 * ─── ⚠ WHAT MAY BE PERSISTED, AND WHAT MAY NOT ───────────────────────────
 * chrome.storage.local holds ONE key: { provider, apiKey }. Nothing else in
 * this file may ever be written to it.
 *
 * The context answers are the most personal thing in the app (§4), and the ask
 * thread is worse — it is a transcript of someone's questions about their own
 * severance withdrawal. In memory, gone on refresh or tab close. That is the
 * privacy story, and it is only true as long as persist() keeps taking a
 * StoredCredentials and nothing wider.
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { getFieldClassifications, type FieldClassification } from "./classify";
import { askQuestion, type AskTurn } from "./ask";
import { COPILOT_DEV } from "./dev";
import type { PayloadLine } from "./detect-field";

export type Provider = "anthropic" | "openai" | "groq";

export const PROVIDERS: Array<{ id: Provider; label: string; keyLabel: string }> = [
    { id: "anthropic", label: "Anthropic (Claude)", keyLabel: "Anthropic API key" },
    { id: "openai", label: "OpenAI", keyLabel: "OpenAI API key" },
    { id: "groq", label: "Groq (free tier)", keyLabel: "Groq API key" },
];

/** The one key chrome.storage.local is allowed to hold. */
const STORAGE_KEY = "copilot.credentials";

interface StoredCredentials {
    provider: Provider;
    apiKey: string;
}

interface CopilotState {
    provider: Provider;
    apiKey: string;
    /** False until chrome.storage has been read, so the UI can avoid flashing
     *  an empty key field at a user who already has one saved. */
    credentialsLoaded: boolean;

    /** "What is this document?" — free text, in-memory only. */
    documentDescription: string;
    /** "What do you need to do?" — free text, in-memory only. */
    goal: string;

    classifications: Map<string, FieldClassification>;
    status: "idle" | "loading" | "done" | "error";
    error: string | null;

    /**
     * Completed exchanges, oldest first (§9.7).
     *
     * ⚠ INVARIANT: every turn has BOTH a question and an answer. ask.ts
     * resends the tail of this array to the model as conversation history, so
     * a turn with an empty answer would upload `A:` followed by nothing. The
     * in-flight question lives in pendingQuestion instead, precisely so this
     * array never holds a half-turn.
     */
    askThread: AskTurn[];
    /** The question currently in flight, shown immediately so the UI doesn't
     *  look frozen while the model thinks. Null when nothing is pending. */
    pendingQuestion: string | null;
    /**
     * No "done" state: the thread itself is the result, so there is nothing for
     * a done flag to reveal. Idle after a successful answer.
     */
    askStatus: "idle" | "loading" | "error";
    askError: string | null;

    loadCredentials: () => Promise<void>;
    setProvider: (provider: Provider) => void;
    setApiKey: (apiKey: string) => void;
    setDocumentDescription: (text: string) => void;
    setGoal: (text: string) => void;
    clearCredentials: () => Promise<void>;

    runClassification: (payload: PayloadLine[]) => Promise<void>;
    /** Resolves true when an answer landed — see the comment on the action. */
    ask: (payload: PayloadLine[], question: string) => Promise<boolean>;
    resetResults: () => void;
}

export const copilotStore = createStore<CopilotState>((set, get) => ({
    provider: "anthropic",
    apiKey: "",
    credentialsLoaded: false,

    documentDescription: "",
    goal: "",

    classifications: new Map(),
    status: "idle",
    error: null,

    askThread: [],
    pendingQuestion: null,
    askStatus: "idle",
    askError: null,

    async runClassification(payload) {
        const { provider, apiKey, documentDescription, goal, status } = get();

        // Guard against a double-click firing two requests. The second would
        // resolve after the first and overwrite it, which on a slow network
        // means the user sees results flip.
        if (status === "loading") return;

        set({ status: "loading", error: null });

        const result = await getFieldClassifications(
            payload,
            { documentDescription, goal },
            provider,
            apiKey,
        );

        if (!result.ok) {
            set({ status: "error", error: result.error });
            return;
        }

        if (COPILOT_DEV) {
            const withRef = result.classifications.filter((c) => c.ref);
            console.log(
                `[copilot] ${result.classifications.length} verdicts, ${withRef.length} with a ref:`,
                result.classifications,
            );
        }
        set({
            classifications: new Map(result.classifications.map((c) => [c.ref ?? c.id, c])),
            status: "done",
            error: null,
        });
    },


    /**
     * Ask one follow-up question (§9.7).
     *
     * ⚠ INDEPENDENT OF CLASSIFICATION ON PURPOSE. It does not read `status`,
     * does not require `classifications` to be populated, and is not blocked
     * while a classification is running. That independence is what makes it
     * §10's network-failure fallback: if the big call fails live, this one
     * still answers questions.
     *
     * ⚠ RETURNS A BOOLEAN because the panel owns the textarea's text. Local
     * state there rather than store state here, so typing doesn't re-render
     * the 124-row line list on every keystroke — the same cost the panel's
     * useMemo already exists to avoid. The panel clears the box only on true;
     * clearing it on failure would delete what the user typed at the exact
     * moment they want to retry it.
     */
    async ask(payload, question) {
        const { provider, apiKey, documentDescription, goal, askStatus, askThread } = get();

        if (askStatus === "loading") return false;

        const trimmed = question.trim();
        if (trimmed === "") {
            set({ askStatus: "error", askError: "Type a question first." });
            return false;
        }

        // Shown immediately. The answer can be 10+ seconds away on a full
        // Hebrew document, and a send button that visibly does nothing reads
        // as broken.
        set({ pendingQuestion: trimmed, askStatus: "loading", askError: null });

        const result = await askQuestion({
            payload,
            context: { documentDescription, goal },
            // Read from the snapshot above, not from a fresh get(). The guard
            // means no other ask can have landed in between, and a re-read
            // would only invite someone to remove the guard later.
            history: askThread,
            question: trimmed,
            provider,
            apiKey,
        });

        if (!result.ok) {
            // pendingQuestion cleared: it is a record of something in flight,
            // and nothing is. The question survives in the panel's textarea,
            // which is why that state lives there.
            set({ pendingQuestion: null, askStatus: "error", askError: result.error });
            return false;
        }

        set({
            askThread: [...get().askThread, { question: trimmed, answer: result.answer }],
            pendingQuestion: null,
            askStatus: "idle",
            askError: null,
        });

        return true;
    },

    resetResults() {
        // Credentials and context survive: the user is likely opening a second
        // form in the same session, and re-typing their situation is the kind
        // of friction that makes a tool feel hostile. Only results are
        // document-specific.
        //
        // ⚠ THE THREAD IS DOCUMENT-SPECIFIC TOO. An answer about the Harel
        // form's section ב is not merely stale beside a W-9, it is wrong — and
        // it would be resent to the model as history, teaching it about a
        // document that is no longer open. Line ids are array positions and
        // shift on every re-extraction (§8.14), so nothing here survives a new
        // document.
        set({
            classifications: new Map(),
            status: "idle",
            error: null,
            askThread: [],
            pendingQuestion: null,
            askStatus: "idle",
            askError: null,
        });
    },

    async loadCredentials() {
        try {
            const stored = await chrome.storage.local.get(STORAGE_KEY);
            const saved = stored[STORAGE_KEY] as StoredCredentials | undefined;

            set({
                provider: saved?.provider ?? "anthropic",
                apiKey: saved?.apiKey ?? "",
                credentialsLoaded: true,
            });
        } catch {
            // Storage being unavailable is not fatal — the user can paste a key
            // and use the copilot for this session. Deliberately no error
            // detail: a storage exception can echo the value it was handling.
            set({ credentialsLoaded: true });
        }
    },

    setProvider(provider) {
        if (provider === get().provider) return;

        // Clearing the key on switch is required, not tidiness: an Anthropic
        // key sent to OpenAI produces an auth error that reads like a broken
        // integration, and the user has no reason to suspect a stale field.
        // Only one { provider, apiKey } pair is ever stored (§9.5), so there is
        // no other key to fall back to.
        set({ provider, apiKey: "" });
        void persist({ provider, apiKey: "" });
    },

    setApiKey(apiKey) {
        set({ apiKey });
        void persist({ provider: get().provider, apiKey });
    },

    setDocumentDescription(documentDescription) {
        set({ documentDescription });
    },

    setGoal(goal) {
        set({ goal });
    },

    async clearCredentials() {
        set({ apiKey: "" });

        try {
            await chrome.storage.local.remove(STORAGE_KEY);
        } catch {
            // Nothing useful to do. The in-memory value is already gone, which
            // is what the user asked for.
        }
    },
}));


/**
 * ⚠ TAKES StoredCredentials, NOT A PARTIAL STATE. That signature is the only
 * thing preventing the context answers or the ask thread from reaching disk —
 * widening it to accept arbitrary state would break §4's privacy claim in a
 * way nothing would flag.
 */
async function persist(credentials: StoredCredentials): Promise<void> {
    try {
        await chrome.storage.local.set({ [STORAGE_KEY]: credentials });
    } catch {
        // Non-fatal: the session keeps working, the key just won't survive a
        // reload. Silent because the alternative is an error toast on every
        // keystroke.
    }
}

/**
 * React binding, mirroring useAnnotationStore. Kept in this file rather than a
 * separate one only because the store is small; split it if it grows to match
 * the state/ + viewer/ pattern.
 *
 * Note this store MAY import React, unlike state/ — nothing in the background
 * worker needs credentials, and the AI call runs in the viewer.
 */
export function useCopilotStore<T>(selector: (state: CopilotState) => T): T {
    return useStore(copilotStore, selector);
}