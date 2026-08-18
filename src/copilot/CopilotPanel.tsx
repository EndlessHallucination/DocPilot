/**
 * copilot/CopilotPanel.tsx
 *
 * The field list, the copilot's per-field answers, and the follow-up question
 * box. This list is the substitute for continuous scrolling: the viewer is
 * page-at-a-time, so without it a user has no way to learn a field exists on a
 * page they haven't opened. EXPLAINER §6.5 for the pointer-events rules the
 * panel depends on.
 *
 * ⚠⚠ data-editor-chrome ON THE ROOT IS LOAD-BEARING. Deselect-on-background-
 * click is a document-level listener identifying background by exclusion, so
 * without that attribute every click in this panel — and every keystroke in the
 * key field or the question box — deselects whatever annotation the user is
 * holding. It reads as a random, intermittent bug. Every early return renders
 * through Shell so no error path can lose it. EXPLAINER §6.5.
 */

import { useMemo, useState } from "react";
import { copilotStore, useCopilotStore } from "./copilotStore";
import { ContextForm } from "./ContextForm";
import type { FieldClassification } from "./classify";
import type { Extraction } from "./run-extraction";
import type { PayloadLine, DetectedField } from "./detect-field";

interface Props {
    extraction: Extraction | null;
    pageNumber: number;
    onSelectPage: (page: number) => void;
    /** Tell the page which line a row is about, so it can be highlighted. */
    onFocusLine: (lineId: string) => void;
    /** The line id currently highlighted on the page, so the row can say so. */
    focusedLineId: string | null;
}

/**
 * Truncate to n rendered lines. Inline rather than Tailwind's `line-clamp-*` so
 * it needs no plugin and no version floor; Chrome-only, so the prefix is free.
 */
function clampLines(lines: number): React.CSSProperties {
    return {
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: lines,
        overflow: "hidden",
    };
}

export function CopilotPanel({
    extraction,
    pageNumber,
    onSelectPage,
    onFocusLine,
    focusedLineId,
}: Props) {
    /**
     * null means "follow the document", NOT false. Filtered when tagging found
     * anything; everything when it found nothing — which is the case where the
     * full list is diagnostic, because a PDF with no line markers yields one
     * line per page with no error anywhere. EXPLAINER §3.2.
     */
    const [taggedOnlyOverride, setTaggedOnlyOverride] = useState<boolean | null>(null);

    const classifications = useCopilotStore((s) => s.classifications);
    const status = useCopilotStore((s) => s.status);
    const error = useCopilotStore((s) => s.error);

    // Grouped once per document rather than filtering inside the render tree,
    // so the cost stops scaling with document size on every keystroke elsewhere.
    const byPage = useMemo(() => {
        const groups = new Map<number, { all: PayloadLine[]; tagged: PayloadLine[] }>();

        for (const line of extraction?.detection.payload ?? []) {
            const group = groups.get(line.page) ?? { all: [], tagged: [] };

            group.all.push(line);
            if (line.fields) group.tagged.push(line);

            groups.set(line.page, group);
        }

        return groups;
    }, [extraction?.detection.payload]);

    /**
     * ⚠ ARRAYS, keyed by LINE — even though the store keys by `ref ?? id`. The
     * store's key must be unique per FIELD so nothing is overwritten; this one
     * must be per LINE because that is what a row is. Deriving one from the
     * other is what keeps them from drifting. EXPLAINER §4.4.
     */
    const byLine = useMemo(() => {
        const index = new Map<string, FieldClassification[]>();

        for (const verdict of classifications.values()) {
            const existing = index.get(verdict.id);

            if (existing) existing.push(verdict);
            else index.set(verdict.id, [verdict]);
        }

        return index;
    }, [classifications]);

    /** Counts FIELDS, not lines — a multi-field row is three things to do. */
    const counts = useMemo(() => {
        const tally = { fill: 0, skip: 0, unclear: 0 };

        for (const verdict of classifications.values()) tally[verdict.fill] += 1;

        return tally;
    }, [classifications]);

    const taggedCount = useMemo(
        () => [...byPage.values()].reduce((n, group) => n + group.tagged.length, 0),
        [byPage],
    );

    if (!extraction) {
        return (
            <Shell>
                <Notice>
                    Couldn&apos;t read this document. The editor works normally — you can
                    still place text, symbols and signatures.
                </Notice>
            </Shell>
        );
    }

    if (!extraction.readable) {
        return (
            <Shell>
                <Notice>
                    This PDF has no text layer, so it&apos;s probably a scan or an image.
                    The editor works normally; the copilot needs readable text.
                </Notice>
            </Shell>
        );
    }

    const { payload } = extraction.detection;
    const taggedOnly = taggedOnlyOverride ?? taggedCount > 0;
    const pageLineCount = payload.filter((l) => l.page === pageNumber).length;

    return (
        <Shell>
            {/* Inside Shell so it inherits data-editor-chrome. */}
            <ContextForm />

            <div className="shrink-0 border-b p-4">
                {/* ⚠ CURRENT PAGE ONLY. Hebrew output costs ~1 token per
                    character, so a whole document's verdicts don't fit however
                    long you wait. EXPLAINER §5.4. */}
                <button
                    type="button"
                    disabled={status === "loading"}
                    onClick={() =>
                        void copilotStore
                            .getState()
                            .runClassification(payload.filter((l) => l.page === pageNumber))
                    }
                    className="w-full rounded bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-40"
                >
                    {status === "loading"
                        ? "Reading the form…"
                        : status === "done"
                            ? `Read page ${pageNumber} again`
                            : "What should I fill in?"}
                </button>

                {/* Says the copilot is gated, not broken — a visitor with no key
                    still gets extraction, the field list and the whole editor. */}
                {status === "idle" && (
                    <p className="mt-2 text-xs text-gray-500">
                        Needs your own API key. Everything else — reading the form,
                        placing text, signing and exporting — works without one.
                    </p>
                )}

                {/* Names the work rather than showing a spinner: the request
                    reports nothing until it returns, and an indicator that can't
                    report progress is a lie about what is happening. */}
                {status === "loading" && (
                    <p className="mt-2 text-xs text-gray-500">
                        Reading {pageLineCount} lines on page {pageNumber}. A page of Hebrew
                        takes about a minute.
                    </p>
                )}

                {/* classify.ts already writes these for a user — don't wrap them
                    in "Error:". */}
                {status === "error" && error && (
                    <p className="mt-2 text-sm text-red-600">{error}</p>
                )}

                {status === "done" && classifications.size === 0 && (
                    <p className="mt-2 text-sm text-gray-600">
                        The model didn&apos;t find anything to fill in on this document.
                    </p>
                )}
            </div>

            <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
                {/* Results replace the extraction counts once they exist: what
                    geometry tagged matters while setting up, what you have to DO
                    matters afterwards. Never both at once. */}
                {classifications.size > 0 ? (
                    <span className="text-xs">
                        <span className="font-medium text-emerald-700">
                            {counts.fill} to fill in
                        </span>
                        {counts.unclear > 0 && (
                            <span className="text-amber-700"> · {counts.unclear} unclear</span>
                        )}
                        <span className="text-gray-500"> · {counts.skip} to skip</span>
                    </span>
                ) : (
                    <span className="text-xs text-gray-500">
                        {taggedCount} tagged / {payload.length} lines
                    </span>
                )}

                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
                    <input
                        type="checkbox"
                        checked={taggedOnly}
                        onChange={(e) => setTaggedOnlyOverride(e.target.checked)}
                    />
                    Fields only
                </label>
            </div>

            {/* Placement degraded, discovery unaffected — say which, so a user
                seeing marks land badly knows it's known. */}
            {!extraction.geometryOk && (
                <Notice>
                    Couldn&apos;t read this document&apos;s drawn shapes. Fields are still
                    listed; marker positions will be approximate.
                </Notice>
            )}

            {extraction.pages.some((p) => p.lineSource === "clustered") && (
                <Notice>
                    This PDF doesn&apos;t mark where its lines end, so lines were rebuilt
                    from their positions. Fields may be grouped imprecisely.
                </Notice>
            )}

            <ul className="flex-1 overflow-auto">
                {[...byPage].map(([page, group]) => {
                    // ⚠ Tagged OR answered. The most interesting row on the page
                    // can be one no detector tagged — a clause with no checkbox
                    // drawn beside it. Filtering on `fields` alone hides it.
                    // EXPLAINER §4.1.
                    const rows = taggedOnly
                        ? group.all.filter((l) => l.fields || byLine.has(l.id))
                        : group.all;

                    if (rows.length === 0) return null;

                    return (
                        <li key={page}>
                            <h3 className="sticky top-0 z-10 border-b bg-gray-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                                Page {page}
                                <span className="ml-2 font-normal normal-case tracking-normal">
                                    {group.tagged.length} of {group.all.length} lines tagged
                                </span>
                            </h3>

                            <ul>
                                {rows.map((line) => (
                                    <LineRow
                                        key={line.id}
                                        line={line}
                                        verdicts={byLine.get(line.id) ?? EMPTY_VERDICTS}
                                        active={line.page === pageNumber}
                                        focused={line.id === focusedLineId}
                                        // Both, always. Navigating without
                                        // highlighting leaves the user hunting;
                                        // highlighting without navigating points
                                        // at a page they cannot see.
                                        onSelect={() => {
                                            onSelectPage(line.page);
                                            onFocusLine(line.id);
                                        }}
                                    />
                                ))}
                            </ul>
                        </li>
                    );
                })}
            </ul>

            {/* Last child and OUTSIDE the scrolling list — a question box that
                scrolls away with 124 rows is a feature nobody finds. */}
            <AskBox payload={payload} />
        </Shell>
    );
}

/** Stable identity, so a row with no verdicts doesn't get a new array per render. */
const EMPTY_VERDICTS: FieldClassification[] = [];

// ---------------------------------------------------------------------------
// The follow-up question box
// ---------------------------------------------------------------------------

/**
 * Markers answer "what goes in this field"; this answers "what does this term
 * mean" and "does this option apply to me" — questions with no coordinate to
 * attach to. EXPLAINER §5.6.
 *
 * ⚠ Reads no `status`, `error` or `classifications`. That independence is what
 * makes it the live fallback when classification fails. Don't gate it.
 *
 * ⚠ The draft is LOCAL state, not store state: every keystroke would otherwise
 * re-render the whole line list. It also means the store can't clear the box,
 * which is why ask() returns a boolean.
 */
function AskBox({ payload }: { payload: PayloadLine[] }) {
    const [draft, setDraft] = useState("");

    const thread = useCopilotStore((s) => s.askThread);
    const pending = useCopilotStore((s) => s.pendingQuestion);
    const askStatus = useCopilotStore((s) => s.askStatus);
    const askError = useCopilotStore((s) => s.askError);

    const loading = askStatus === "loading";

    async function send() {
        if (loading) return;

        const answered = await copilotStore.getState().ask(payload, draft);
        if (answered) setDraft("");
    }

    return (
        <section className="shrink-0 border-t bg-gray-50">
            {/* TODO auto-scroll to the newest turn: a ref on the last item plus
                scrollIntoView in a LAYOUT effect, not useEffect — a passive
                effect scrolls after the browser painted the pre-growth height,
                which flashes. */}
            {(thread.length > 0 || pending) && (
                <ul className="max-h-56 overflow-auto px-3 pt-3">
                    {thread.map((turn, index) => (
                        // Index keys are safe here and only here: append-only,
                        // never reordered or filtered.
                        <li key={index} className="mb-3">
                            {/* ⚠ dir="auto" PER MESSAGE, never on a shared parent.
                                The question may be Hebrew while the answer is
                                English, and one container's direction renders one
                                of them backwards. */}
                            <p dir="auto" className="text-[13px] font-medium">
                                {turn.question}
                            </p>
                            {/* whitespace-pre-line: ask.ts returns plain text with
                                newlines that would otherwise collapse. */}
                            <p
                                dir="auto"
                                className="mt-1 whitespace-pre-line text-[13px] leading-snug text-gray-700"
                            >
                                {turn.answer}
                            </p>
                        </li>
                    ))}

                    {pending && (
                        <li className="mb-3">
                            <p dir="auto" className="text-[13px] font-medium">
                                {pending}
                            </p>
                            <p className="mt-1 text-[13px] text-gray-500">Reading the form…</p>
                        </li>
                    )}
                </ul>
            )}

            <div className="p-3">
                {/* ⚠ NOT A <form>. A real form on an extension page submits and
                    navigates, unmounting the viewer and losing the document,
                    every annotation and the whole thread. */}
                <div className="flex items-end gap-2">
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            // Enter sends, Shift+Enter breaks the line. isComposing
                            // guards an IME mid-word: Enter accepting a candidate
                            // would otherwise send a half-typed question.
                            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)
                                return;

                            e.preventDefault();
                            void send();
                        }}
                        // TODO verify against AnnotationLayer's keyboard handling.
                        // If Delete/Backspace is bound at DOCUMENT level, editing
                        // here deletes the selected annotation. The fix would be a
                        // target check in the layer's handler, NOT stopPropagation
                        // here — that masks it for one input and leaves the next
                        // one broken. EXPLAINER §6.5.
                        rows={2}
                        dir="auto"
                        placeholder="Ask about anything on this form"
                        className="min-w-0 flex-1 resize-none rounded border bg-white px-3 py-2 text-[13px]"
                    />

                    <button
                        type="button"
                        disabled={loading || draft.trim() === ""}
                        onClick={() => void send()}
                        className="shrink-0 rounded bg-black px-3 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-40"
                    >
                        {loading ? "…" : "Ask"}
                    </button>
                </div>

                {askStatus === "error" && askError && (
                    <p className="mt-2 text-sm text-red-600">{askError}</p>
                )}

                {thread.length === 0 && !pending && askStatus !== "error" && (
                    // An empty panel is an invitation, so it names the two things
                    // this answers that markers can't.
                    <p className="mt-2 text-[11px] text-gray-500">
                        Ask what a term means, or whether an option applies to you.
                    </p>
                )}
            </div>
        </section>
    );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The rail colour: the strongest verdict on this line. fill beats unclear beats
 * skip, because that is the order someone needs to find them in.
 */
function accentFor(verdicts: FieldClassification[]): string {
    if (verdicts.length === 0) return "border-transparent";
    if (verdicts.some((v) => v.fill === "fill")) return "border-emerald-500";
    if (verdicts.some((v) => v.fill === "unclear")) return "border-amber-400";

    return "border-gray-300";
}

function LineRow({
    line,
    verdicts,
    active,
    focused,
    onSelect,
}: {
    line: PayloadLine;
    /** ALL verdicts on this line, not the first. EXPLAINER §4.4. */
    verdicts: FieldClassification[];
    active: boolean;
    /** This row's line is the one banded on the page right now. */
    focused: boolean;
    onSelect: () => void;
}) {
    // ⚠ Whitespace-only lines are REAL and must stay visible — a whitespace run
    // followed by a wide gap IS a blank, and that is the write-in signal. A row
    // rendering empty looks like a bug, so it gets a placeholder. EXPLAINER §3.1.
    const blank = line.text.trim() === "";
    const answered = verdicts.length > 0;

    // Each state's hover is a step darker than its own resting tint, so hovering
    // never erases the colour that means something.
    const tint = focused
        ? "bg-amber-50 hover:bg-amber-100"
        : active
            ? "bg-blue-50/40 hover:bg-blue-100/60"
            : "hover:bg-gray-100";

    return (
        <li>
            <button
                type="button"
                onClick={onSelect}
                // Focused (amber) wins over current-page (blue), and matches the
                // band drawn on the page so the row and the place it points at
                // read as one act.
                className={`w-full cursor-pointer border-l-[3px] px-3 py-2 text-left transition-colors ${accentFor(
                    verdicts,
                )} ${tint}`}
            >
                {(line.fields || line.unreliableText) && (
                    <div className="mb-1 flex flex-wrap items-center gap-1">
                        {line.fields?.map((field) => (
                            <Badge key={field.ref}>{fieldLabel(field)}</Badge>
                        ))}

                        {/* Corruption is per character range, but the row only has
                            room for a flag. The ranges live on the Run. */}
                        {line.unreliableText && <Badge>text unclear</Badge>}
                    </div>
                )}

                {/* ⚠ dir="auto", never a computed direction — the browser's bidi
                    algorithm is what you want for display. detect-field uses a
                    different rule for a different reason; don't unify them.
                    EXPLAINER §3.4.

                    Answered rows get two lines, unanswered one: an unanswered
                    line is context, and clamping it is what makes the answered
                    ones findable. */}
                <p
                    dir="auto"
                    style={clampLines(answered ? 2 : 1)}
                    className={`text-[13px] leading-snug ${blank ? "italic text-gray-400" : "text-gray-800"
                        }`}
                >
                    {blank ? "(blank)" : line.text}
                </p>

                {answered && (
                    <div className="mt-1.5 space-y-1.5">
                        {verdicts.map((verdict) => (
                            // ⚠ `ref ?? id` — three verdicts share one line id, and
                            // duplicate React keys make reconciliation undefined.
                            <VerdictBlock
                                key={verdict.ref ?? verdict.id}
                                line={line}
                                verdict={verdict}
                            />
                        ))}
                    </div>
                )}
            </button>
        </li>
    );
}

/**
 * What a detected field is called ON SCREEN. `writeIn` and `checkbox` are type
 * names, and a type name in the interface describes how the code is built rather
 * than what the person is looking at.
 */
function fieldLabel(field: DetectedField): string {
    if (field.kind === "cells") {
        return field.label ? `${field.count} boxes · ${field.label}` : `${field.count} boxes`;
    }

    return field.kind === "checkbox" ? "tick box" : "write-in";
}

/**
 * One verdict, named by the field it applies to when the model said which. The
 * label comes from the document, not the model, so it is there whether or not a
 * value came back.
 */
function VerdictBlock({
    line,
    verdict,
}: {
    line: PayloadLine;
    verdict: FieldClassification;
}) {
    const label = verdict.ref
        ? line.fields?.find((f) => f.ref === verdict.ref)?.label
        : undefined;

    const value = verdict.value_or_instruction.trim();
    const showValue = verdict.fill !== "skip" && value !== "";

    return (
        <div>
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <VerdictBadge verdict={verdict.fill} />

                {label && (
                    <span dir="auto" className="text-[11px] text-gray-500">
                        {label}
                    </span>
                )}

                {/* ⚠ Value and reason get their OWN dir="auto": the value is in
                    the FORM's language, the reason in English. Sharing one
                    container's direction renders one of them wrong. */}
                {showValue && (
                    <span
                        dir="auto"
                        style={clampLines(1)}
                        className="min-w-0 flex-1 text-[13px] font-medium text-gray-900"
                    >
                        {value}
                    </span>
                )}
            </div>

            <p
                dir="auto"
                style={clampLines(2)}
                className="mt-0.5 text-[11px] leading-snug text-gray-600"
            >
                {verdict.reason}
            </p>
        </div>
    );
}

/**
 * Colour carries the verdict, and so does the word — red/green is the most
 * common colour-blindness pair and acting on the wrong verdict costs money.
 */
function VerdictBadge({ verdict }: { verdict: FieldClassification["fill"] }) {
    const styles: Record<FieldClassification["fill"], string> = {
        fill: "bg-emerald-100 text-emerald-800",
        skip: "bg-gray-100 text-gray-500",
        unclear: "bg-amber-100 text-amber-800",
    };

    const labels: Record<FieldClassification["fill"], string> = {
        fill: "fill in",
        skip: "skip",
        unclear: "unclear",
    };

    return (
        <span
            className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${styles[verdict]}`}
        >
            {labels[verdict]}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ⚠ data-editor-chrome lives here — see the file header. */
function Shell({ children }: { children: React.ReactNode }) {
    return (
        <aside
            data-editor-chrome
            className="flex w-80 shrink-0 flex-col overflow-hidden border-l bg-white"
        >
            {children}
        </aside>
    );
}

function Notice({ children }: { children: React.ReactNode }) {
    return <p className="shrink-0 px-4 py-3 text-sm text-gray-600">{children}</p>;
}

function Badge({ children }: { children: React.ReactNode }) {
    return (
        <span className="rounded bg-gray-100 px-1.5 py-px text-[10px] text-gray-600">
            {children}
        </span>
    );
}