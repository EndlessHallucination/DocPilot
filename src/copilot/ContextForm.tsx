/**
 * copilot/ContextForm.tsx
 *
 * Everything the copilot needs before it can be asked anything: which provider,
 * the key for it, and the user's situation in their own words. Collapses to a
 * one-line summary once a classification has run.
 *
 * The two free-text questions are what separate this from pasting the form into
 * a chat window — without a situation the model can only describe fields the
 * user can already read. EXPLAINER §5.5.
 *
 * ⚠ NEVER log, render or send the key anywhere but the provider. The collapsed
 * summary says whether a key EXISTS and never shows any part of one — not a
 * prefix, not a length, not a masked stand-in sized to the real thing.
 */

import { useEffect, useState } from "react";
import { copilotStore, useCopilotStore, PROVIDERS } from "./copilotStore";
import { STORAGE_DESCRIPTION } from "./storage";

export function ContextForm() {
    const provider = useCopilotStore((s) => s.provider);
    const apiKey = useCopilotStore((s) => s.apiKey);
    const credentialsLoaded = useCopilotStore((s) => s.credentialsLoaded);
    const documentDescription = useCopilotStore((s) => s.documentDescription);
    const goal = useCopilotStore((s) => s.goal);
    const status = useCopilotStore((s) => s.status);

    /**
     * null means "follow the status", NOT false. A plain boolean would freeze
     * whatever the first document implied and never re-derive.
     */
    const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);

    // Read once per mount. Cheap, idempotent, and keeps the store's lifecycle
    // owned by the only thing that uses it.
    useEffect(() => {
        void copilotStore.getState().loadCredentials();
    }, []);

    /**
     * Starting a run re-arms the derived default — without this, one click of
     * "Edit" pins the form open for the session and the panel never recovers its
     * space. Clearing on `loading` rather than `done` means the fold happens as
     * the request starts, so the waiting state gets the room.
     */
    useEffect(() => {
        if (status === "loading") setExpandedOverride(null);
    }, [status]);

    const active = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

    // ⚠ Collapses on an EVENT, not on the fields being non-empty — the latter
    // would fold the form up under the user's own typing.
    const expanded = expandedOverride ?? (status === "idle" || status === "error");

    if (!expanded) {
        return (
            // ⚠ data-editor-chrome on BOTH branches. Losing it here would make
            // clicks deselect the user's annotation only after the first
            // classification — the hardest version to notice. EXPLAINER §6.5.
            <section
                data-editor-chrome
                className="flex items-start gap-3 border-b px-4 py-3"
            >
                <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-gray-500">
                        {active.label} · {apiKey ? "key saved" : "no key"}
                    </p>

                    {/* dir="auto": the goal may be Hebrew while the label above
                        is English. */}
                    {goal.trim() !== "" && (
                        <p dir="auto" className="mt-0.5 truncate text-sm text-gray-700">
                            {goal}
                        </p>
                    )}
                </div>

                <button
                    type="button"
                    onClick={() => setExpandedOverride(true)}
                    className="shrink-0 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
                >
                    Edit
                </button>
            </section>
        );
    }

    return (
        <section data-editor-chrome className="flex flex-col gap-4 border-b p-4">
            <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Provider</span>

                <select
                    value={provider}
                    onChange={(e) =>
                        copilotStore.getState().setProvider(e.target.value as typeof provider)
                    }
                    className="rounded border px-2 py-1"
                >
                    {PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.label}
                        </option>
                    ))}
                </select>
            </label>

            <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">{active.keyLabel}</span>

                <input
                    // password: this gets demoed on a screen share.
                    type="password"
                    // Chrome offers to save anything it thinks is a login, and a
                    // browser-saved API key is a second copy nobody accounted for.
                    autoComplete="off"
                    spellCheck={false}
                    // Disabled rather than empty until storage has been read — a
                    // returning user seeing a blank field reads it as data loss.
                    disabled={!credentialsLoaded}
                    value={apiKey}
                    onChange={(e) => copilotStore.getState().setApiKey(e.target.value)}
                    placeholder={credentialsLoaded ? "Paste your key" : "Loading…"}
                    className="rounded border px-2 py-1 font-mono text-sm"
                />

                {/* ⚠ STORAGE_DESCRIPTION differs per build and the two claims are
                    not interchangeable — Chrome sandboxes extension storage;
                    localStorage is origin-scoped. Don't hardcode either.
                    EXPLAINER §8.2. */}
                <span className="text-xs text-gray-500">
                    {STORAGE_DESCRIPTION} Sent only to {active.label}. Your document
                    is never uploaded. Not encrypted — avoid using this on a shared
                    computer.
                </span>

                {apiKey && (
                    <button
                        type="button"
                        onClick={() => void copilotStore.getState().clearCredentials()}
                        className="self-start text-xs text-gray-600 underline"
                    >
                        Forget this key
                    </button>
                )}
            </label>

            <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">What is this document?</span>

                <textarea
                    rows={2}
                    value={documentDescription}
                    onChange={(e) =>
                        copilotStore.getState().setDocumentDescription(e.target.value)
                    }
                    dir="auto"
                    placeholder="A withdrawal form from my pension fund"
                    className="rounded border px-2 py-1 text-sm"
                />
            </label>

            <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">What do you need to do?</span>

                <textarea
                    rows={3}
                    value={goal}
                    onChange={(e) => copilotStore.getState().setGoal(e.target.value)}
                    dir="auto"
                    // The placeholder does real work: left alone, users write
                    // "fill this form", which adds nothing. This shows the shape
                    // of answer that changes the output — dates, status, intent.
                    placeholder="I left my job in March 2024 and haven't worked since. I want to withdraw everything."
                    className="rounded border px-2 py-1 text-sm"
                />

                <span className="text-xs text-gray-500">
                    Sent to {active.label} along with the form&apos;s text. The more
                    specific you are, the more the copilot can tell you which
                    options apply to you.
                </span>
            </label>

            {/* Only once there is something to collapse back to — on a fresh
                document the form IS the panel, and a "Hide" button that empties
                the panel is a trap. */}
            {status === "done" && (
                <button
                    type="button"
                    onClick={() => setExpandedOverride(false)}
                    className="self-start text-xs text-gray-600 underline"
                >
                    Hide setup
                </button>
            )}
        </section>
    );
}