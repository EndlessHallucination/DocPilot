/**
 * copilot/ContextForm.tsx
 *
 * §9.2 — everything the copilot needs from the user before it can be asked
 * anything: which provider, the key for it, and their situation in their own
 * words.
 *
 * ─── WHY THE TWO QUESTIONS EXIST ─────────────────────────────────────────
 * They are what makes this different from pasting the form into a chat window.
 * The same Harel form is filled completely differently by someone who resigned
 * two years ago and someone withdrawing early and eating the tax — different
 * clauses, different boxes, different documents to attach. Without the user's
 * situation the model can only describe what each field is, which the user can
 * already read. With it, the model can say which ones apply to THEM.
 *
 * Free text rather than a questionnaire on purpose: any fixed set of questions
 * encodes assumptions about one kind of form, and this has to work on a form
 * nobody has seen.
 *
 * ─── ⚠ NEVER LOG, NEVER RENDER, NEVER SEND THE KEY ANYWHERE BUT THE PROVIDER ─
 * No console.log of the field value, not even while debugging. The key is
 * masked on screen, excluded from the payload builder, and travels only in the
 * Authorization header of the provider call.
 *
 * ─── ⚠ data-editor-chrome ────────────────────────────────────────────────
 * Same requirement as CopilotPanel (§6.10). Deselect-on-background-click is a
 * document-level listener identifying background by exclusion, so without this
 * attribute every click into a text field deselects the annotation the user is
 * holding. Typing in a form should not disturb the canvas.
 */

import { useEffect } from "react";
import { copilotStore, useCopilotStore, PROVIDERS } from "./copilotStore";

export function ContextForm() {
    const provider = useCopilotStore((s) => s.provider);
    const apiKey = useCopilotStore((s) => s.apiKey);
    const credentialsLoaded = useCopilotStore((s) => s.credentialsLoaded);
    const documentDescription = useCopilotStore((s) => s.documentDescription);
    const goal = useCopilotStore((s) => s.goal);

    // Read once per mount. Cheap, idempotent, and doing it here rather than in
    // App keeps the store's lifecycle owned by the only thing that uses it.
    useEffect(() => {
        void copilotStore.getState().loadCredentials();
    }, []);

    const active = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

    return (
        <section data-editor-chrome className="flex flex-col gap-4 border-b p-4">
            {/* TODO styling throughout. The structure, the masking, the
                disabled state and the copy are the load-bearing parts. */}

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
                    // type="password" so it isn't readable over a shoulder or
                    // in a screen share — which is how this gets demoed.
                    type="password"
                    // Chrome offers to save anything it thinks is a login.
                    // Nothing here is a login, and a browser-saved API key is a
                    // second copy nobody accounted for.
                    autoComplete="off"
                    spellCheck={false}
                    // Disabled rather than empty until storage has been read.
                    // A returning user seeing a blank field re-enters a key
                    // they already have, and the flash reads as data loss.
                    disabled={!credentialsLoaded}
                    value={apiKey}
                    onChange={(e) => copilotStore.getState().setApiKey(e.target.value)}
                    placeholder={credentialsLoaded ? "Paste your key" : "Loading…"}
                    className="rounded border px-2 py-1 font-mono text-sm"
                />

                {/* Accurate, and deliberately not more than accurate. Chrome
                    sandboxes extension storage from other extensions and from
                    web pages, and does not sync it. It is NOT encrypted, and
                    claiming otherwise is the kind of thing that unravels in a
                    demo Q&A. */}
                <span className="text-xs text-gray-500">
                    Stored locally in this browser and sent only to {active.label}.
                    Your document is never uploaded. Not encrypted — avoid using
                    this on a shared computer.
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
                    // The placeholder is doing real work. Left to themselves
                    // users write "fill this form", which adds nothing. The
                    // example shows the shape of answer that changes the
                    // model's output: dates, employment status, intent.
                    placeholder="I left my job in March 2024 and haven't worked since. I want to withdraw everything."
                    className="rounded border px-2 py-1 text-sm"
                />

                <span className="text-xs text-gray-500">
                    Sent to {active.label} along with the form&apos;s text. The more
                    specific you are, the more the copilot can tell you which
                    options apply to you.
                </span>
            </label>
        </section>
    );
}