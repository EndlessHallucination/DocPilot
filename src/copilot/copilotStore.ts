/**
 *
 * Provider credentials and the user's stated situation. Separate from
 * annotationStore, deliberately.
 *
 *  */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { getFieldClassifications, type FieldClassification } from "./classify";
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

    loadCredentials: () => Promise<void>;
    setProvider: (provider: Provider) => void;
    setApiKey: (apiKey: string) => void;
    setDocumentDescription: (text: string) => void;
    setGoal: (text: string) => void;
    clearCredentials: () => Promise<void>;

    runClassification: (payload: PayloadLine[]) => Promise<void>;
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

        set({
            classifications: new Map(result.classifications.map((c) => [c.id, c])),
            status: "done",
            error: null,
        });
    },
    resetResults() {
        // Credentials and context survive: the user is likely opening a second
        // form in the same session, and re-typing their situation is the kind
        // of friction that makes a tool feel hostile. Only results are
        // document-specific.
        set({ classifications: new Map(), status: "idle", error: null });
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