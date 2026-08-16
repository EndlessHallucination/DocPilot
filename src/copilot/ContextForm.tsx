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
 * Authorization header of the provider call. The collapsed summary below says
 * whether a key EXISTS and never shows any part of one — not a prefix, not a
 * length, not a masked stand-in sized to the real thing.
 *
 * ─── ⚠ data-editor-chrome ────────────────────────────────────────────────
 * Same requirement as CopilotPanel (§6.10). Deselect-on-background-click is a
 * document-level listener identifying background by exclusion, so without this
 * attribute every click into a text field deselects the annotation the user is
 * holding. Typing in a form should not disturb the canvas. BOTH branches below
 * carry it — the collapsed summary is still panel chrome, and losing it there
 * would make the bug appear only after the first classification, which is the
 * hardest possible version to notice.
 *
 * ─── SETUP GETS OUT OF THE WAY ONCE IT IS DONE ───────────────────────────
 * This form is ~430px of a panel whose whole job is the field list. Expanded
 * it is the first thing an audience sees, which frames the product as
 * configuration rather than as an answer to a question.
 *
 * So it collapses — but on an EVENT, not continuously. Collapsing the moment
 * the fields happen to be non-empty would fold the form up under the user's
 * own typing. The trigger is a classification having been run: at that point
 * the setup demonstrably worked, and the answer below deserves the room.
 */

import { useEffect, useState } from "react";
import { copilotStore, useCopilotStore, PROVIDERS } from "./copilotStore";

export function ContextForm() {
    const provider = useCopilotStore((s) => s.provider);
    const apiKey = useCopilotStore((s) => s.apiKey);
    const credentialsLoaded = useCopilotStore((s) => s.credentialsLoaded);
    const documentDescription = useCopilotStore((s) => s.documentDescription);
    const goal = useCopilotStore((s) => s.goal);
    const status = useCopilotStore((s) => s.status);

    /**
     * null means "follow the status", NOT false — the same derived-default
     * pattern as CopilotPanel's tagged-only toggle. A plain boolean would
     * freeze whatever the first document implied and never re-derive, so a
     * user who expanded the form once would never see it fold away again.
     */
    const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);

    // Read once per mount. Cheap, idempotent, and doing it here rather than in
    // App keeps the store's lifecycle owned by the only thing that uses it.
    useEffect(() => {
        void copilotStore.getState().loadCredentials();
    }, []);

    /**
     * Pressing "What should I fill in?" re-arms the derived default.
     *
     * Without this, one click of "Edit" pins the form open for the rest of the
     * session and the panel never recovers its space. Clearing on `loading`
     * rather than on `done` means the fold happens as the request starts, so
     * the waiting state gets the room rather than inheriting a cramped panel
     * and jumping a second later.
     */
    useEffect(() => {
        if (status === "loading") setExpandedOverride(null);
    }, [status]);

    const active = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
    const expanded = expandedOverride ?? (status === "idle" || status === "error");

    if (!expanded) {
        return (
            <section
                data-editor-chrome
                className="flex items-start gap-3 border-b px-4 py-3"
            >
                <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-gray-500">
                        {active.label} · {apiKey ? "key saved" : "no key"}
                    </p>

                    {/* The goal, one line, as a reminder of what the answers
                        below were computed FROM. dir="auto" because it may be
                        Hebrew while the label above is English (§8.3). */}
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

            {/* Only offered once there is something to collapse back to. On a
                fresh document the form IS the panel, and a "Hide" button that
                empties the panel is a trap. */}
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