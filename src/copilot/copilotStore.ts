/**
 * copilot/copilotStore.ts
 *
 * Provider credentials, the user's stated situation, and the copilot's two
 * results: per-field classifications and the question thread. Separate from
 * annotationStore deliberately — an AI response must never mark the document
 * dirty.
 *
 * ⚠ ONE key is persisted: { provider, apiKey }. Nothing else in this file may
 * ever reach storage — the context answers and the ask thread are the most
 * personal things in the app and are in-memory only. EXPLAINER §8.1.
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { getFieldClassifications, type FieldClassification } from "./classify";
import { askQuestion, type AskTurn } from "./ask";
import { COPILOT_DEV } from "./dev";
import type { PayloadLine } from "./detect-field";
import { readStored, writeStored, removeStored } from "./storage";

export type Provider = "anthropic" | "openai" | "groq";

export const PROVIDERS: Array<{ id: Provider; label: string; keyLabel: string }> = [
    { id: "anthropic", label: "Anthropic (Claude)", keyLabel: "Anthropic API key" },
    { id: "openai", label: "OpenAI", keyLabel: "OpenAI API key" },
    { id: "groq", label: "Groq (free tier)", keyLabel: "Groq API key" },
];

/** The one key persistent storage is allowed to hold. */
const STORAGE_KEY = "copilot.credentials";

interface StoredCredentials {
    provider: Provider;
    apiKey: string;
}

interface CopilotState {
    provider: Provider;
    apiKey: string;
    /** False until storage has been read, so the UI doesn't flash an empty key
     *  field at a user who already has one saved. */
    credentialsLoaded: boolean;

    /** "What is this document?" — free text, in-memory only. */
    documentDescription: string;
    /** "What do you need to do?" — free text, in-memory only. */
    goal: string;

    /** ⚠ Keyed by `ref ?? id`, per FIELD. A line can carry several verdicts. */
    classifications: Map<string, FieldClassification>;
    status: "idle" | "loading" | "done" | "error";
    error: string | null;

    /**
     * Completed exchanges, oldest first.
     *
     * ⚠ Every turn has BOTH a question and an answer. ask.ts resends the tail as
     * history, so a half-turn would upload `A:` followed by nothing — which is
     * why the in-flight question lives in pendingQuestion instead.
     */
    askThread: AskTurn[];
    /** In flight, shown immediately so the UI doesn't look frozen. */
    pendingQuestion: string | null;
    /** No "done": the thread itself is the result. Idle after a good answer. */
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

        // Guard against a double-click firing two requests: the second resolves
        // after the first and overwrites it, so results visibly flip.
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

            // ⚠ Logs the FULL array, not withRef. Printing the filtered subset
            // beside an unfiltered count read as a silent data loss for three
            // debugging rounds. EXPLAINER §9.6.
            console.log(
                `[copilot] ${result.classifications.length} verdicts, ${withRef.length} with a ref:`,
                result.classifications,
            );
        }

        // ⚠ Keyed `ref ?? id`, never `id` alone. Three verdicts share one line
        // id on a multi-field row, and keying by line silently kept the last.
        // EXPLAINER §4.4.
        set({
            classifications: new Map(result.classifications.map((c) => [c.ref ?? c.id, c])),
            status: "done",
            error: null,
        });
    },

    /**
     * ⚠ INDEPENDENT OF CLASSIFICATION ON PURPOSE. Reads no `status`, requires no
     * `classifications`, and is not blocked while a classification runs — that
     * independence is what makes it the live fallback. EXPLAINER §5.6.
     *
     * ⚠ Returns a boolean because the panel owns the textarea's text: it clears
     * only on success, so a failed request leaves the question there to retry.
     */
    async ask(payload, question) {
        const { provider, apiKey, documentDescription, goal, askStatus, askThread } = get();

        if (askStatus === "loading") return false;

        const trimmed = question.trim();
        if (trimmed === "") {
            set({ askStatus: "error", askError: "Type a question first." });
            return false;
        }

        set({ pendingQuestion: trimmed, askStatus: "loading", askError: null });

        const result = await askQuestion({
            payload,
            context: { documentDescription, goal },
            // From the snapshot above, not a fresh get(): the guard means no
            // other ask can have landed in between.
            history: askThread,
            question: trimmed,
            provider,
            apiKey,
        });

        if (!result.ok) {
            // pendingQuestion records something in flight, and nothing is. The
            // question survives in the panel's textarea.
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

    /**
     * Credentials and context survive a new document; results do not.
     *
     * ⚠ The thread is document-specific too. An answer about the old form isn't
     * merely stale, it is wrong — and it would be resent as history, teaching
     * the model about a document that is no longer open. Line ids are array
     * positions and shift on every re-extraction.
     */
    resetResults() {
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
            const saved = await readStored<StoredCredentials>(STORAGE_KEY);

            set({
                provider: saved?.provider ?? "anthropic",
                apiKey: saved?.apiKey ?? "",
                credentialsLoaded: true,
            });
        } catch {
            // Not fatal — the user can paste a key for this session. No error
            // detail: a storage exception can echo the value it was handling.
            set({ credentialsLoaded: true });
        }
    },

    setProvider(provider) {
        if (provider === get().provider) return;

        // Clearing the key on switch is required, not tidiness: an Anthropic key
        // sent to OpenAI produces an auth error that reads like a broken
        // integration, and the user has no reason to suspect a stale field.
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
            await removeStored(STORAGE_KEY);
        } catch {
            // Nothing useful to do — the in-memory value is already gone, which
            // is what the user asked for.
        }
    },
}));

/**
 * ⚠⚠ TAKES StoredCredentials, NOT A PARTIAL STATE. That signature is the only
 * thing keeping the context answers and the ask thread off disk. Widening it
 * breaks the privacy claim and nothing would flag it. EXPLAINER §8.1.
 */
async function persist(credentials: StoredCredentials): Promise<void> {
    try {
        await writeStored(STORAGE_KEY, credentials);
    } catch {
        // Non-fatal: the session keeps working, the key just won't survive a
        // reload. Silent, because the alternative is a toast per keystroke.
    }
}

/**
 * React binding, mirroring useAnnotationStore. This store MAY import React,
 * unlike state/ — nothing in the background worker needs credentials.
 */
export function useCopilotStore<T>(selector: (state: CopilotState) => T): T {
    return useStore(copilotStore, selector);
}