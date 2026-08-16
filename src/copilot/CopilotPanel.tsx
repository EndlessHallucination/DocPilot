/**
 * copilot/CopilotPanel.tsx
 *
 * The field list, the copilot's per-field answers, and the follow-up question
 * box. §9.1 step 3 plus §9.3's results rendered onto the rows it already had,
 * plus §9.7.
 *
 * ─── WHY IT EXISTS AT ALL ────────────────────────────────────────────────
 * The viewer is page-at-a-time with no continuous scroll (§6.12). Scrolling
 * doesn't affect correctness — markers anchor to page plus coordinates either
 * way — but it destroys DISCOVERABILITY: a user has no way to learn there's a
 * field on page 3 without navigating there. This list is the substitute, which
 * is why extraction runs over every page at load rather than per render.
 *
 * ─── ⚠ data-editor-chrome IS LOAD-BEARING ────────────────────────────────
 * AnnotationLayer is transparent to the mouse in select mode so the text layer
 * keeps its selection, which means deselect-on-background-click is a
 * DOCUMENT-LEVEL listener identifying background by exclusion: anything not
 * inside [data-annotation-id] or [data-editor-chrome] (§6.10).
 *
 * Without that attribute on the root, every click in this panel — including
 * clicking a row to jump to its page, every keystroke in the context form, and
 * every keystroke in the question box — deselects whatever annotation the user
 * is holding. It reads as a random, intermittent bug. Do not remove it.
 *
 * ─── ⚠ A LINE CAN CARRY SEVERAL VERDICTS ─────────────────────────────────
 * Harel's עמית header line carries three — family name, ID, birth date — and
 * the withdrawal-type line carries two. The store keyed classifications by
 * line id until §8.36 and kept only the last of each set; this file then found
 * that survivor with an O(n) scan per row and rendered it alone.
 *
 * Both halves are fixed: the store keys on `ref ?? id`, and this file builds
 * one line-keyed index of ARRAYS. That is the fourth appearance of §8.12's
 * line-vs-run bug, and the rule from there applies — when a line can carry
 * several of something, check every map keyed by line id.
 *
 * ─── DENSITY IS THE WHOLE STYLING BRIEF ──────────────────────────────────
 * At 4–6 visible rows this list cannot do its job: a user has to scroll to
 * learn that a field exists, which is the problem the panel was built to
 * solve. Three changes buy the room back, and none of them removes
 * information:
 *
 *   1. THE LEFT RAIL IS THE ONLY STRUCTURAL DEVICE, and it encodes the one
 *      thing worth scanning for — whether this line has an answer, and which
 *      kind. Colour is spent there and on the verdict badge, nowhere else, so
 *      an answered line is findable at a glance down the edge of the list.
 *
 *   2. UNANSWERED ROWS CLAMP TO ONE LINE, answered rows to two. A truthful
 *      hierarchy rather than a cosmetic one: an unanswered line is context,
 *      and its full text is on the page a click away.
 *
 *   3. EACH VERDICT IS TWO LINES, not four — badge, field label and value
 *      share a row; the reason takes the next and clamps at two.
 *
 * Clamping is inline -webkit-line-clamp rather than Tailwind's `line-clamp-*`
 * so it needs no plugin and no Tailwind version floor. This is a Chrome
 * extension; the vendor prefix costs nothing here.
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

/** Truncate to n rendered lines without a Tailwind plugin. See the header. */
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
     * ─── THE FILTER DEFAULT IS DERIVED, NOT STORED ───────────────────────
     * §9.1 specified one row per TAGGED line; the first implementation showed
     * all lines instead, because while extraction was being generalised the
     * question asked most often was "did line splitting work at all", and only
     * the full list answers it — a PDF with no hasEOL markers produces ONE
     * LINE PER PAGE with no error anywhere (§8.1, §8.15), and against a
     * filtered list that reads as "no fields found" rather than "the parser is
     * broken".
     *
     * Both are right, on different documents. So the default follows the
     * document: filtered when tagging found anything, everything when it found
     * nothing — which is exactly the case where the full list is diagnostic.
     *
     * null means "no one has touched the toggle", NOT false. A boolean here
     * would lock in whatever the first document implied and never re-derive.
     */
    const [taggedOnlyOverride, setTaggedOnlyOverride] = useState<boolean | null>(null);

    const classifications = useCopilotStore((s) => s.classifications);
    const status = useCopilotStore((s) => s.status);
    const error = useCopilotStore((s) => s.error);

    // Group once per document rather than filtering the payload inside the
    // render tree. The previous version called payload.filter() three times
    // per page — twice for the header counts, once for the rows — so the work
    // was 3n per page on every keystroke in the context form. Correct either
    // way at 124 lines; this stops the cost scaling with document size.
    //
    // Keyed off the payload's identity, which changes only when a new document
    // opens, so the toggle and every store update reuse the same grouping.
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
     * Verdicts for a line, in the order the model returned them.
     *
     * ⚠ ARRAYS, and keyed by LINE even though the store keys by `ref ?? id`.
     * The two maps answer different questions: the store's key must be unique
     * per FIELD so nothing is overwritten (§8.36), and this one must be
     * per LINE because that is what a row is. Deriving one from the other here
     * is what keeps them from drifting.
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

    /**
     * How many of each verdict, for the summary strip.
     *
     * This is the first question anyone asks of a page of results — "so what
     * do I actually have to do?" — and until now the only way to answer it was
     * to read every row. Counted off the store's map, so it counts FIELDS
     * rather than lines: the עמית row is three things to fill in, not one.
     */
    const counts = useMemo(() => {
        const tally = { fill: 0, skip: 0, unclear: 0 };

        for (const verdict of classifications.values()) tally[verdict.fill] += 1;

        return tally;
    }, [classifications]);

    const taggedCount = useMemo(
        () => [...byPage.values()].reduce((n, group) => n + group.tagged.length, 0),
        [byPage],
    );

    // Every early return still renders the chrome attribute. A bare <p> without
    // it would make clicks in the empty panel deselect annotations — the exact
    // bug this file warns about, reintroduced through the error path.
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
            {/* Inside Shell so it inherits data-editor-chrome — without that,
                typing an API key deselects the user's annotation. */}
            <ContextForm />

            <div className="shrink-0 border-b p-4">
                {/* ⚠ CURRENT PAGE ONLY (§8.30). Hebrew output tokenizes at
                    roughly one token per character, and 124 verdicts with prose
                    reasons do not fit in 8,000 output tokens however long you
                    wait. The cost is cross-page reasoning — Harel page 3 lists
                    which documents to attach depending on the withdrawal type
                    picked on page 1 — and it is stated out loud in the demo
                    rather than hidden. */}
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

                {/* ─── THE WAITING STATE (§15.4) ─────────────────────────────
                    A full Hebrew page takes 60–100 seconds, and a button
                    reading "Reading the form…" with nothing else moving reads
                    as a hang. Naming the actual work — this page, this many
                    lines — makes the wait legible and gives the demo somewhere
                    to stand while it runs. Deliberately no spinner or progress
                    bar: the request reports nothing until it returns, and an
                    indicator that cannot report progress is a lie about what is
                    happening. */}
                {status === "loading" && (
                    <p className="mt-2 text-xs text-gray-500">
                        Reading {pageLineCount} lines on page {pageNumber}. A page of Hebrew
                        takes about a minute.
                    </p>
                )}

                {/* Never a silent failure (§10). classify.ts already writes
                    these for a user, so don't wrap them in "Error:". */}
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
                {/* Results replace the extraction counts once they exist. What
                    geometry tagged matters while you are setting up; what you
                    have to DO matters once the answers are in. The two are
                    never interesting at the same moment. */}
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

            {/* Placement degraded, discovery unaffected — say which. A user who
                sees markers land badly should be told it's known, and a user
                who sees no warning should trust the positions. */}
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
                    // Tagged OR answered. A line the model gave a verdict to is
                    // the most interesting row on the page even when no
                    // detector tagged it — the התחלתי לעבוד clause has no
                    // checkbox drawn beside it, which is exactly why it matters
                    // (§3.1). Filtering on `fields` alone hides it.
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
                                        // Both, always. Navigating to the page
                                        // without highlighting leaves the user
                                        // hunting; highlighting without
                                        // navigating points at a page they
                                        // cannot see.
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

            {/* Last child, and OUTSIDE the scrolling <ul> above. The list runs
                to 124 rows; a question box that scrolls away with it is a
                feature nobody finds. shrink-0 keeps it pinned while the list
                flexes. */}
            <AskBox payload={payload} />
        </Shell>
    );
}

/** Stable identity, so a row with no verdicts doesn't get a new array each render. */
const EMPTY_VERDICTS: FieldClassification[] = [];

// ---------------------------------------------------------------------------
// §9.7 — the follow-up question box
// ---------------------------------------------------------------------------

/**
 * A free-text question about the form, answered with the document already in
 * context.
 *
 * ─── WHY IT'S SEPARATE FROM THE MARKERS ──────────────────────────────────
 * Markers answer "what goes in this field". They cannot answer "what does
 * מס שבירה mean" or "I have a loan against the account — does that change
 * which box I tick". Those questions have no coordinate to attach to, and they
 * are the ones that actually stop someone filling a form.
 *
 * ─── ⚠ IT MUST KEEP WORKING WHEN CLASSIFICATION DOESN'T ──────────────────
 * Nothing here reads `status`, `error` or `classifications`. That is §10's
 * network-failure fallback: if the big call dies live, this still answers
 * questions, which recovers a demo far better than narrating screenshots. It
 * has already earned its keep twice — it answered correctly about W-9 line 6
 * on a run where classification omitted that line entirely (§8.28).
 * Don't "tidy" this by disabling the box until classification has run.
 *
 * ─── ⚠ THE DRAFT IS LOCAL STATE, NOT STORE STATE ─────────────────────────
 * Every keystroke would otherwise re-render the whole line list above — the
 * exact cost CopilotPanel's useMemo exists to avoid. It also means the store
 * cannot clear the box, which is why ask() returns a boolean: clear only on
 * success, so a failed request leaves the question there to retry.
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
            {/* TODO styling. Auto-scroll to the newest turn is NOT implemented:
                add a ref on the last item and scrollIntoView({ block: "end" })
                in a layout effect keyed on thread.length + pending. Do it in a
                LAYOUT effect, not useEffect — the answer can be several
                paragraphs, and a passive effect scrolls after the browser has
                already painted the pre-growth height, which flashes. */}
            {(thread.length > 0 || pending) && (
                <ul className="max-h-56 overflow-auto px-3 pt-3">
                    {thread.map((turn, index) => (
                        // Index keys are safe here and only here: the thread is
                        // append-only and never reordered or filtered.
                        <li key={index} className="mb-3">
                            {/* ⚠ dir="auto" PER MESSAGE, never on a shared
                                parent. The question may be Hebrew while the
                                answer is English by ask.ts's rule — one
                                container's direction renders one of them
                                backwards. Same reasoning as LineRow (§8.3). */}
                            <p dir="auto" className="text-[13px] font-medium">
                                {turn.question}
                            </p>
                            {/* whitespace-pre-line: ask.ts asks for plain text,
                                and the model separates paragraphs with newlines
                                that would otherwise collapse. */}
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
                {/* ⚠ NOT A <form>. A real form in an extension page submits and
                    navigates, which unmounts the viewer and loses the document,
                    every annotation and the whole thread. Nothing here persists
                    across a reload (§4). */}
                <div className="flex items-end gap-2">
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            // Enter sends, Shift+Enter breaks the line.
                            // isComposing guards an IME mid-word — pressing
                            // Enter to accept a candidate would otherwise send
                            // a half-typed question.
                            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)
                                return;

                            e.preventDefault();
                            void send();
                        }}
                        // TODO verify against AnnotationLayer's keyboard
                        // handling. If Delete/Backspace is bound at DOCUMENT
                        // level rather than on the layer element, editing text
                        // here will delete the selected annotation (§5.1:
                        // selectedId means Delete removes it). ContextForm has
                        // the same exposure, so if it's already fine, this is
                        // too — check, don't assume. The fix if it bites is a
                        // target check in the layer's handler, NOT
                        // stopPropagation here, which would mask it for one
                        // input and leave the next one broken.
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

                {/* ask.ts and provider.ts already write these for a user, so
                    don't wrap them in "Error:". */}
                {askStatus === "error" && askError && (
                    <p className="mt-2 text-sm text-red-600">{askError}</p>
                )}

                {thread.length === 0 && !pending && askStatus !== "error" && (
                    // An empty panel is an invitation, so it names the two
                    // things this answers that markers can't: what a term
                    // means, and whether an option applies to you.
                    <p className="mt-2 text-[11px] text-gray-500">
                        Ask what a term means, or whether an option applies to you.
                    </p>
                )}
            </div>
        </section>
    );
}

/**
 * The rail colour: the strongest verdict on this line.
 *
 * fill beats unclear beats skip, because that is the order in which someone
 * needs to find them. A line carrying both a fill and a skip is a line with
 * something to do on it.
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
    /** All verdicts on this line, in the order the model returned them (§8.36). */
    verdicts: FieldClassification[];
    active: boolean;
    /** This row's line is the one banded on the page right now. */
    focused: boolean;
    onSelect: () => void;
}) {
    // Whitespace-only lines are REAL and must stay visible. `str === " "` is a
    // run of whitespace on the page, and every blank on the Hebrew fixture is
    // a whitespace run followed by a large positional gap — that's the signal
    // detect-field reads (§8.1). A row rendering blank looks like a bug, so it
    // gets a placeholder instead of being filtered out.
    const blank = line.text.trim() === "";
    const answered = verdicts.length > 0;
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
                // The focused tint matches the band drawn on the page (amber),
                // so the row and the place it points at are visibly the same
                // act. It wins over the current-page tint, which is ambient.
                className={`w-full cursor-pointer border-l-[3px] px-3 py-2 text-left transition-colors ${accentFor(
                    verdicts,
                )} ${tint}`}
            >
                {(line.fields || line.unreliableText) && (
                    <div className="mb-1 flex flex-wrap items-center gap-1">
                        {line.fields?.map((field) => (
                            <Badge key={field.ref}>{fieldLabel(field)}</Badge>
                        ))}

                        {/* Character-range level, not per line (§8.4) — but the
                            row only has room for a flag. The ranges are on the
                            Run, for whoever wants to underline the exact
                            characters later. */}
                        {line.unreliableText && <Badge>text unclear</Badge>}
                    </div>
                )}

                {/* dir="auto" and NOT a computed direction. The browser applies
                    the bidi algorithm to the whole string, which is what you
                    want for display. detect-field uses a different rule for a
                    different reason (§8.3) — don't unify them.

                    Answered rows get two lines, unanswered one. See the header:
                    an unanswered line is context, and clamping it is what makes
                    the answered ones findable. */}
                <p
                    dir="auto"
                    style={clampLines(answered ? 2 : 1)}
                    className={`text-[13px] leading-snug ${blank ? "italic text-gray-400" : "text-gray-800"
                        }`}
                >
                    {blank ? "(blank)" : line.text}
                </p>

                {/* One block per verdict, not one per line. The עמית row
                    carries three — family name, ID, birth date — and showing
                    the first alone is what §8.36 was still doing on the panel
                    side after the store was fixed. */}
                {answered && (
                    <div className="mt-1.5 space-y-1.5">
                        {verdicts.map((verdict) => (
                            <VerdictBlock
                                // ref where the model named a field, id where it
                                // didn't — the store's own key, so it is unique
                                // by construction.
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
 * What a detected field is called ON SCREEN.
 *
 * `writeIn` and `checkbox` are type names, and a type name in the interface
 * describes how the code is built rather than what the person is looking at.
 * The form has tick boxes and rows of boxes to write single characters in —
 * say that instead.
 */
function fieldLabel(field: DetectedField): string {
    if (field.kind === "cells") {
        return field.label ? `${field.count} boxes · ${field.label}` : `${field.count} boxes`;
    }

    return field.kind === "checkbox" ? "tick box" : "write-in";
}

/**
 * One verdict, named by the field it applies to when the model said which.
 *
 * The field label is what makes several verdicts on one line readable: three
 * unlabelled blocks under the עמית header are three anonymous answers, while
 * "מס' הזהות · 039274865" is self-explanatory. It comes from the document, not
 * the model (§8.22), so it is there whether or not the model returned a value.
 *
 * Badge, label and value share ONE line and the reason takes the next. Four
 * stacked lines per verdict is what pushed the third answer on the עמית row
 * past the bottom of the panel.
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

                {/* Each gets its OWN dir="auto", and that is §9.3's language
                    rule made visible: the value is in the FORM's language
                    (Hebrew) while the reason is in the USER's (English).
                    Sharing one container's direction renders one of them
                    wrong. */}
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
 * Colour carries the verdict, and so does the word.
 *
 * Not colour alone: red/green is the most common colour-blindness pair, and
 * acting on the wrong verdict here has financial consequences. Text costs
 * nothing.
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