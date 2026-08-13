/**
 * copilot/CopilotPanel.tsx
 *
 * The field list, and now the copilot's answers. §9.1 step 3 plus §9.3's
 * results rendered onto the rows it already had.
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
 * clicking a row to jump to its page, and every keystroke in the context form —
 * deselects whatever annotation the user is holding. It reads as a random,
 * intermittent bug. Do not remove it.
 *
 * ─── SHOWING ALL LINES IS DELIBERATE, AND CONTRARY TO §9.1 ───────────────
 * §9.1 specified one row per TAGGED line. That was written assuming one known
 * document. While extraction is still being generalised to other PDFs, the
 * question asked most often is "did line splitting work at all", and only the
 * full list answers it: a PDF with no hasEOL markers (§8.1) produces ONE LINE
 * PER PAGE with no error anywhere, and against a filtered list that looks like
 * "no fields found" rather than "the parser is broken".
 *
 * Flip the default to tagged-only once extraction is trusted on more than one
 * issuer. The toggle stays either way.
 */

import { useMemo, useState } from "react";
import { copilotStore, useCopilotStore } from "./copilotStore";
import { ContextForm } from "./ContextForm";
import type { FieldClassification } from "./classify";
import type { Extraction } from "./run-extraction";
import type { PayloadLine } from "./detect-field";

interface Props {
    extraction: Extraction | null;
    pageNumber: number;
    onSelectPage: (page: number) => void;
}

export function CopilotPanel({ extraction, pageNumber, onSelectPage }: Props) {
    const [taggedOnly, setTaggedOnly] = useState(false);

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
    const taggedCount = payload.filter((line) => line.fields).length;

    return (
        <Shell>
            {/* Inside Shell so it inherits data-editor-chrome — without that,
                typing an API key deselects the user's annotation. */}
            <ContextForm />

            <div className="border-b p-4">
                <button
                    type="button"
                    disabled={status === "loading"}
                    onClick={() => void copilotStore.getState().runClassification(payload)}
                    className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-40"
                >
                    {status === "loading"
                        ? "Reading the form…"
                        : status === "done"
                            ? "Ask again"
                            : "What should I fill in?"}
                </button>

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

            <div className="flex items-center justify-between border-b px-4 py-3">
                <span className="text-sm">
                    {taggedCount} tagged / {payload.length} lines
                </span>

                <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={taggedOnly}
                        onChange={(e) => setTaggedOnly(e.target.checked)}
                    />
                    Tagged only
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
                    const rows = taggedOnly ? group.tagged : group.all;
                    if (rows.length === 0) return null;

                    return (
                        <li key={page}>
                            <h3 className="sticky top-0 bg-gray-50 px-4 py-1 text-xs text-gray-500">
                                Page {page} — {group.all.length} lines, {group.tagged.length}{" "}
                                tagged
                            </h3>

                            <ul>
                                {rows.map((line) => (
                                    <LineRow
                                        key={line.id}
                                        line={line}
                                        verdict={classifications.get(line.id)}
                                        active={line.page === pageNumber}
                                        onSelect={() => onSelectPage(line.page)}
                                    />
                                ))}
                            </ul>
                        </li>
                    );
                })}
            </ul>
        </Shell>
    );
}

function LineRow({
    line,
    verdict,
    active,
    onSelect,
}: {
    line: PayloadLine;
    verdict?: FieldClassification;
    active: boolean;
    onSelect: () => void;
}) {
    // Whitespace-only lines are REAL and must stay visible. `str === " "` is a
    // run of whitespace on the page, and every blank on the Hebrew fixture is
    // a whitespace run followed by a large positional gap — that's the signal
    // detect-fields reads (§8.1). A row rendering blank looks like a bug, so
    // it gets a placeholder instead of being filtered out.
    const blank = line.text.trim() === "";

    return (
        <li>
            <button
                type="button"
                onClick={onSelect}
                // TODO styling: match Toolbar. Active state wants to be obvious
                // without shouting — this list is long.
                className={`w-full px-4 py-2 text-left text-sm hover:bg-gray-50 ${active ? "bg-blue-50" : ""
                    }`}
            >
                <div className="flex items-center gap-1">
                    {verdict && <VerdictBadge verdict={verdict.fill} />}

                    {line.fields?.map((field) => (
                        <Badge key={field.ref}>
                            {field.kind === "cells"
                                ? `${field.count} cells${field.label ? ` · ${field.label}` : ""}`
                                : field.kind}
                        </Badge>
                    ))}

                    {/* Character-range level, not per line (§8.4) — but the row
                        only has room for a flag. The ranges are on the Run, for
                        whoever wants to underline the exact characters later. */}
                    {line.unreliableText && <Badge>text unclear</Badge>}
                </div>

                {/* dir="auto" and NOT a computed direction. The browser applies
                    the bidi algorithm to the whole string, which is what you
                    want for display. detect-fields uses a different rule for a
                    different reason (§8.3) — don't unify them. */}
                <p dir="auto" className={blank ? "text-gray-400 italic" : ""}>
                    {blank ? "(blank)" : line.text}
                </p>

                {verdict && (
                    <div className="mt-1 border-l-2 border-gray-200 pl-2">
                        {/* Each gets its OWN dir="auto", and that is §9.3's
                            language rule made visible: the value is in the
                            FORM's language (Hebrew) while the reason is in the
                            USER's (English). Sharing one container's direction
                            renders one of them wrong. */}
                        {verdict.fill !== "skip" && (
                            <p dir="auto" className="font-medium">
                                {verdict.value_or_instruction}
                            </p>
                        )}

                        <p dir="auto" className="text-xs text-gray-600">
                            {verdict.reason}
                        </p>
                    </div>
                )}
            </button>
        </li>
    );
}

// ---------------------------------------------------------------------------
// TODO styling. Structure and the chrome attribute are the load-bearing parts;
// everything below is presentation and safe to rewrite.
// ---------------------------------------------------------------------------

/**
 * Colour carries the verdict, and so does the word.
 *
 * Not colour alone: red/green is the most common colour-blindness pair, and
 * acting on the wrong verdict here has financial consequences. Text costs
 * nothing.
 */
function VerdictBadge({ verdict }: { verdict: FieldClassification["fill"] }) {
    const styles: Record<FieldClassification["fill"], string> = {
        fill: "bg-green-100 text-green-800",
        skip: "bg-gray-100 text-gray-600",
        unclear: "bg-amber-100 text-amber-800",
    };

    const labels: Record<FieldClassification["fill"], string> = {
        fill: "fill in",
        skip: "skip",
        unclear: "unclear",
    };

    return (
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles[verdict]}`}>
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
    return <p className="px-4 py-3 text-sm text-gray-600">{children}</p>;
}

function Badge({ children }: { children: React.ReactNode }) {
    return (
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">
            {children}
        </span>
    );
}