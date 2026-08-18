/**
 * copilot/detect-field.ts
 *
 * Joins extract-text.ts (lines) to extract-geometry.ts (drawn shapes) and emits
 * the two things Phase 2 needs:
 *
 *   1. A PAYLOAD for the model — text plus a small semantic tag. No coordinates.
 *   2. A CLIENT MAP — where a mark would go if the model says to mark a line.
 *      Coordinates only, never sent anywhere.
 *
 * ⚠ THIS FILE ONLY ENRICHES. Geometry never gates discovery: if every detector
 * here returns nothing, every field is still found, explained and listed — only
 * placement degrades. Preserve that property when editing. EXPLAINER §4.1.
 *
 * ⚠ ABSENCE IS NEVER ASSERTED. A line carries a tag or carries nothing, and
 * nothing means UNKNOWN, not "no checkbox here". Telling the model "no checkbox
 * on this line" when the detector merely broke would have it confidently
 * instruct the user to write on a line that has a box.
 */

import type { ExtractedPage, Line, Run } from "./extract-text";
import type { CombField, DocumentGeometry, GeometryRect } from "./extract-geometry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AffordanceKind = "checkbox" | "cells" | "writeIn";

/**
 * Which detector decided where a mark goes. Diagnostics only.
 *
 * ⚠ On FieldGeometry, not DetectedField — DetectedField is uploaded, and the
 * model can do nothing with "a gap detector found this". It exists because two
 * detectors both emit kind "writeIn", so a tag alone cannot tell them apart —
 * and a tag with no provenance cannot confirm the detector that produced it.
 * EXPLAINER §9.6.
 */
export type MarkSource =
    | "checkbox"    // a drawn checkbox matched to this line
    | "comb"        // a row of comb cells
    | "literal"     // an underscore / dot / dash run in the TEXT
    | "leader"      // a dashed vector rule
    | "gap"         // a wide positional jump between runs
    | "calibrated"; // nothing found here; placed by the learned offset

/**
 * One field found on a line.
 *
 * ⚠ A LINE CAN CARRY SEVERAL — four column labels with two combs beneath, or a
 * row of five checkboxes. Affordances belong to RUNS, not lines, and any map
 * keyed by line id silently keeps one and drops the rest. EXPLAINER §4.4.
 */
export interface DetectedField {
    /** Stable id the model quotes back, e.g. "p1l3f0". Keys `geometry`. */
    ref: string;
    kind: AffordanceKind;
    /** Character count, `cells` only. Changes the model's answer. */
    count?: number;
    /** The specific run labelling this field, when narrower than the line. */
    label?: string;
}

/** What the model is told about one line. Text and meaning only. */
export interface PayloadLine {
    id: string;
    page: number;
    text: string;
    /** Omitted when nothing was detected. Never present as a negative claim. */
    fields?: DetectedField[];
    /** Part of this line's text failed the readability check. */
    unreliableText?: true;
}

/** What the client keeps. Coordinates only; never serialised. EXPLAINER §5.1. */
export interface FieldGeometry {
    id: string;
    page: number;
    /** Where to place a mark if the model says to mark this line. */
    markRect: GeometryRect;
    /**
     * False when markRect came from the calibrated offset rather than a shape
     * found on this line. Lets the UI say "no box printed on the form" — a fact
     * we hold, not a guess the model made.
     */
    fromDrawnShape: boolean;
    /** Which detector produced markRect. Diagnostics only. */
    source: MarkSource;
    /**
     * Reading direction of the LINE this field was matched to, copied off
     * Line.dir.
     *
     * ⚠ NOT derived from the coordinate. `markRect.x > pageWidth / 2` is the
     * obvious proxy and it is wrong on a wide comb, whose left-hand cells sit the
     * other side of the midpoint from the rest of the same comb. EXPLAINER §6.4.
     *
     * ⚠ REQUIRED, not optional: miss one map.set below and strict mode names the
     * line. Optional would silently default to LTR at exactly the call site that
     * forgot it — the bug this exists to fix, on one detector only.
     */
    dir: "ltr" | "rtl";
    /**
     * The whole LINE's extent, not this field's — markRect is nine points wide on
     * a checkbox line and useless as a highlight. This is what the focus band
     * draws when a row has a verdict but no marker. EXPLAINER §6.3.
     */
    lineRect: GeometryRect;
    /** Per-cell rects, left to right, when this is a comb. See cellRects. */
    cells?: GeometryRect[];
}

export interface DetectionResult {
    payload: PayloadLine[];
    geometry: Map<string, FieldGeometry>;
    markOffset: number;
    corruptionCheckApplied: boolean;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** A shape and a baseline within this many points are on the same line. */
const SAME_LINE_BAND = 6;

/** How far above a comb its label may sit. Two line-heights. */
const LABEL_SEARCH_HEIGHT = 40;

/** Minimum horizontal overlap for a run to count as a comb's label. */
const LABEL_MIN_OVERLAP = 2;

/**
 * How far a checkbox's label may sit from it before the box counts as
 * unlabelled — narrow enough that a box at the end of a line doesn't claim the
 * next option's label.
 */
const LABEL_MAX_GAP = 40;

/** Overlap below this is rounding, not evidence of the wrong side. */
const LABEL_OVERLAP_TOLERANCE = 1;

/**
 * Used only when nothing could be calibrated, so marks still land somewhere sane
 * rather than on top of the text.
 *
 * ⚠ Seeing this value in markOffset means calibration found no boxes at all.
 */
const FALLBACK_MARK_OFFSET = 3;

/** A mark with no box to sit in gets this size, in points. */
const DEFAULT_MARK_SIZE = 9;

const LATIN_SHARE_DISABLING_CORRUPTION_CHECK = 0.15;

/**
 * ⚠ Thresholds are set by what they must NOT match — `...`, `1.1.2008`, `co-op`.
 * They are correct; the limitation is that literalBlanks tests them per RUN, and
 * a dot leader extracts as one run per dot. Fires only on forms that type their
 * blanks as a single run. EXPLAINER §10.
 */
const LITERAL_BLANK_PATTERNS: RegExp[] = [
    /_(?:\s?_){2,}/g,
    /\.(?:\s?\.){4,}/g,
    /-(?:\s?-){3,}/g,
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function detectFields(
    pages: ExtractedPage[],
    geometry: DocumentGeometry,
): DetectionResult {
    const payload: PayloadLine[] = [];
    const map = new Map<string, FieldGeometry>();

    // Calibrate first, across the whole document.
    const offset = calibrateMarkOffset(pages, geometry);
    const markSize = geometry.checkboxSize ?? DEFAULT_MARK_SIZE;

    // Document-level, not per page, so an English appendix inside a Hebrew form
    // is still checked. EXPLAINER §3.5.
    const latin = pages.reduce((n, p) => n + p.letters.latin, 0);
    const rtl = pages.reduce((n, p) => n + p.letters.rtl, 0);
    const totalLetters = latin + rtl;
    const corruptionCheckApplies =
        totalLetters === 0 || latin / totalLetters < LATIN_SHARE_DISABLING_CORRUPTION_CHECK;

    for (const page of pages) {
        const shapes = geometry.pages.find((p) => p.pageNumber === page.pageNumber);

        const checkboxes = matchCheckboxes(page.lines, shapes?.checkboxes ?? []);
        const leaders = matchLeaders(page.lines, shapes?.leaders ?? []);
        const combs = matchCombs(page.lines, shapes?.combs ?? []);

        page.lines.forEach((line, index) => {
            const id = `p${page.pageNumber}l${index}`;
            const fields: DetectedField[] = [];

            // Once per line, shared by every field on it — so the focus band is
            // the same rect whichever field a row click resolved to.
            const bounds = lineBounds(line);

            // Combs, possibly several on one line.
            for (const { comb, label } of combs.get(line) ?? []) {
                const ref = `${id}f${fields.length}`;

                fields.push({ ref, kind: "cells", count: comb.cellCount, label });
                map.set(ref, {
                    id: ref,
                    page: page.pageNumber,
                    markRect: { x: comb.x, y: comb.y, width: comb.width, height: comb.height },
                    fromDrawnShape: true,
                    source: "comb",
                    dir: line.dir,
                    lineRect: bounds,
                    cells: cellRects(comb),
                });
            }

            // Checkboxes, also possibly several. Each needs its own ref, or one
            // verdict against five identical rects marks whichever box happened
            // to be drawn first. EXPLAINER §4.4.
            for (const { box, run } of checkboxes.get(line) ?? []) {
                const ref = `${id}f${fields.length}`;
                const label = run?.text.trim();

                fields.push({ ref, kind: "checkbox", ...(label ? { label } : {}) });
                map.set(ref, {
                    id: ref,
                    page: page.pageNumber,
                    markRect: box,
                    fromDrawnShape: true,
                    source: "checkbox",
                    dir: line.dir,
                    lineRect: bounds,
                });
            }

            const leader = leaders.get(line);
            const literals = literalBlanks(line);

            // Literal blanks emit one field each; a leader or a text gap emits one
            // per line, because neither can tell two blanks apart.
            for (const rect of literals) {
                const ref = `${id}f${fields.length}`;

                fields.push({ ref, kind: "writeIn" });
                map.set(ref, {
                    id: ref,
                    page: page.pageNumber,
                    markRect: rect,
                    // True: an underscore run is ink printed on the form. The flag
                    // means "we know where this goes", not "a vector shape exists".
                    fromDrawnShape: true,
                    source: "literal",
                    dir: line.dir,
                    lineRect: bounds,
                });
            }

            if (literals.length === 0 && (leader || hasWideGap(line))) {
                const ref = `${id}f${fields.length}`;

                fields.push({ ref, kind: "writeIn" });
                map.set(ref, {
                    id: ref,
                    page: page.pageNumber,
                    markRect: leaderMark(leader, markSize) ?? offsetMark(line, offset, markSize),
                    fromDrawnShape: leader !== undefined,
                    source: leader !== undefined ? "leader" : "gap",
                    dir: line.dir,
                    lineRect: bounds,
                });
            }

            payload.push({
                id,
                page: page.pageNumber,
                text: line.text,
                ...(fields.length > 0 ? { fields } : {}),
                ...(corruptionCheckApplies && line.hasSuspectText
                    ? { unreliableText: true as const }
                    : {}),
            });

            // ⚠ EVERY line gets a fallback entry under its own id, so a line the
            // model calls a field with no shape detected on it still has somewhere
            // to put a mark — and the focus band has a rect for every row.
            //
            // The guard can never fail (refs are `p1l3f0`, this key is `p1l3`) and
            // is kept as documentation of that. Do NOT "fix" it into skipping
            // lines that already have fields — the fallback existing for every
            // line is the point. EXPLAINER §4.3, §6.3.
            if (!map.has(id)) {
                map.set(id, {
                    id,
                    page: page.pageNumber,
                    markRect: offsetMark(line, offset, markSize),
                    fromDrawnShape: false,
                    source: "calibrated",
                    dir: line.dir,
                    lineRect: bounds,
                });
            }
        });
    }

    return {
        payload,
        geometry: map,
        markOffset: offset,
        corruptionCheckApplied: corruptionCheckApplies,
    };
}

// ---------------------------------------------------------------------------
// Matching shapes to lines
// ---------------------------------------------------------------------------

/**
 * One checkbox and the text run it sits beside. Carries the RUN, not just its
 * text, because calibrateMarkOffset needs its geometry.
 */
export interface CheckboxMatch {
    box: GeometryRect;
    /** Null when nothing sits on the reading side of the box. */
    run: Run | null;
}

/**
 * Attach each checkbox to the line it belongs to.
 *
 * ⚠ Nearest-baseline alone is NOT enough. A box 2.4pt from its real line can be
 * 2.3pt from an unrelated sidebar line, which then steals it. The tiebreak is
 * horizontal: among lines in the vertical band, pick the one whose text EDGE is
 * nearest. EXPLAINER §4.5.
 *
 * ⚠ RETURNS AN ARRAY PER LINE. One box per line loses four of five options on a
 * multi-option row, and is invisible on a form where no line carries two.
 */
function matchCheckboxes(
    lines: Line[],
    boxes: GeometryRect[],
): Map<Line, CheckboxMatch[]> {
    const matched = new Map<Line, CheckboxMatch[]>();

    for (const box of boxes) {
        const candidates = lines.filter((l) => Math.abs(l.y - box.y) <= SAME_LINE_BAND);
        if (candidates.length === 0) continue;

        let best: Line | null = null;
        let bestDistance = Infinity;

        for (const line of candidates) {
            const distance = edgeDistance(line, box);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = line;
            }
        }

        if (!best) continue;

        const match: CheckboxMatch = { box, run: labelRun(best, box) };
        const existing = matched.get(best);

        if (existing) existing.push(match);
        else matched.set(best, [match]);
    }

    // Reading order within the line, so the model is offered the options in the
    // order a human reads them. Right to left on an RTL line.
    for (const [line, matches] of matched) {
        matches.sort((a, b) => (line.dir === "rtl" ? b.box.x - a.box.x : a.box.x - b.box.x));
    }

    return matched;
}

/**
 * The run a checkbox labels: the nearest one on the side the text runs toward.
 *
 * ⚠ LTR looks RIGHT, RTL looks LEFT. Getting this backwards labels every box
 * with its NEIGHBOUR's text, which reads perfectly plausibly on a row of similar
 * options — the exact class of silently-wrong answer to fear. EXPLAINER §4.5.
 *
 * Returns null rather than a distant run: an unlabelled box still reaches the
 * model as a checkbox field, and a wrong label is worse than none.
 */
function labelRun(line: Line, box: GeometryRect): Run | null {
    const boxRight = box.x + box.width;

    let best: Run | null = null;
    let bestGap = Infinity;

    for (const run of line.runs) {
        if (run.text.trim() === "") continue;

        const gap = line.dir === "rtl" ? box.x - (run.x + run.width) : run.x - boxRight;

        if (gap < -LABEL_OVERLAP_TOLERANCE) continue;
        if (gap > LABEL_MAX_GAP) continue;
        if (gap >= bestGap) continue;

        bestGap = gap;
        best = run;
    }

    return best;
}

/**
 * Distance from a shape to the side of the line a mark would go on.
 *
 * ⚠ On an RTL line that is the RIGHT edge. Using the wrong edge puts every mark
 * on the far side of the page, which looks like a coordinate bug and is not one.
 */
function edgeDistance(line: Line, shape: GeometryRect): number {
    return line.dir === "rtl"
        ? Math.abs(shape.x - line.maxX)
        : Math.abs(line.minX - (shape.x + shape.width));
}

function matchLeaders(lines: Line[], leaders: GeometryRect[]): Map<Line, GeometryRect> {
    const matched = new Map<Line, GeometryRect>();

    for (const leader of leaders) {
        let best: Line | null = null;
        let bestDistance = Infinity;

        for (const line of lines) {
            const distance = Math.abs(line.y - leader.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = line;
            }
        }

        if (best && bestDistance <= SAME_LINE_BAND && !matched.has(best)) {
            matched.set(best, leader);
        }
    }

    return matched;
}

export interface CombMatch {
    comb: CombField;
    /** Text of the run that labels this comb. */
    label: string;
}

/**
 * Attach each comb to the line carrying its label.
 *
 * ⚠ A comb has no text of its own, and "nearest line above" is WRONG — a layout
 * that puts labels, signature text and tick marks on three lines makes the
 * nearest line above a comb the signature text, in a different column. The rule
 * that works: walk upward and take the first line containing a run that
 * horizontally OVERLAPS the comb. EXPLAINER §4.5.
 */
function matchCombs(lines: Line[], combs: CombField[]): Map<Line, CombMatch[]> {
    const matched = new Map<Line, CombMatch[]>();

    for (const comb of combs) {
        const above = lines
            .filter((l) => l.y > comb.y && l.y - comb.y <= LABEL_SEARCH_HEIGHT)
            .sort((a, b) => a.y - b.y);

        for (const line of above) {
            const label = overlappingRun(line, comb);
            if (!label) continue;

            // ⚠ Append, never replace. One header line can label BOTH combs, and
            // replacing here silently dropped a whole field.
            const existing = matched.get(line);
            if (existing) existing.push({ comb, label: label.text.trim() });
            else matched.set(line, [{ comb, label: label.text.trim() }]);

            break;
        }
    }

    return matched;
}

/**
 * The run of `line` that best overlaps `comb` horizontally, or null.
 *
 * ⚠ Returns the RUN, not a boolean: when both combs match the same line, only
 * the individual run distinguishes one column's label from the other's. BEST
 * overlap, not first — neighbouring labels can both clip a comb's edge.
 */
function overlappingRun(line: Line, comb: CombField): Run | null {
    const right = comb.x + comb.width;

    let best: Run | null = null;
    let bestOverlap = LABEL_MIN_OVERLAP;

    for (const run of line.runs) {
        if (run.text.trim() === "") continue;

        const overlap = Math.min(run.x + run.width, right) - Math.max(run.x, comb.x);
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            best = run;
        }
    }

    return best;
}

/** Underscore, dot and dash runs printed in the TEXT, as opposed to drawn. */
function literalBlanks(line: Line): GeometryRect[] {
    const rects: GeometryRect[] = [];

    for (const run of line.runs) {
        if (run.text.length === 0) continue;

        for (const pattern of LITERAL_BLANK_PATTERNS) {
            // matchAll on a /g regex is safe to reuse — it clones internally
            // rather than advancing lastIndex on the shared object.
            for (const match of run.text.matchAll(pattern)) {
                if (match.index === undefined) continue;

                const perChar = run.width / run.text.length;
                const width = match[0].length * perChar;

                // ⚠ A run's x is its LEFT edge in either script, but a logical
                // character index counts from the RIGHT in RTL. Measuring from the
                // wrong end puts the mark on the far side of the run.
                const x =
                    run.dir === "rtl"
                        ? run.x + run.width - (match.index + match[0].length) * perChar
                        : run.x + match.index * perChar;

                rects.push({ x, y: run.y, width, height: run.height });
            }
        }
    }

    return rects.sort((a, b) => a.x - b.x);
}

// ---------------------------------------------------------------------------
// Text gaps
// ---------------------------------------------------------------------------

/**
 * Does this line contain a gap wide enough to be a blank?
 *
 * The threshold is one em of the adjacent text rather than a constant, so it
 * scales with type size instead of needing a number per document.
 *
 * ⚠ ONE verdict per line however many gaps it finds, and deliberately NOT
 * run-keyed: on a multi-option row the gaps are the spaces between options, and
 * the checkbox fields there already carry the placement — so the extra writeIn
 * is redundant rather than wrong. EXPLAINER §4.4.
 */
function hasWideGap(line: Line): boolean {
    const runs = [...line.runs].sort((a, b) => a.x - b.x);

    for (let i = 0; i < runs.length - 1; i++) {
        const gap = runs[i + 1].x - (runs[i].x + runs[i].width);
        const em = Math.max(runs[i].height, runs[i + 1].height);

        if (gap > em) return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Mark placement
// ---------------------------------------------------------------------------

/**
 * Learn this document's offset from a text edge to its checkbox, then use it on
 * lines where NO box was drawn — so a clause with no printed box still gets a
 * mark exactly where a box would have been. EXPLAINER §4.3.
 *
 * Median, not mean, so one mismatched box can't drag it.
 *
 * ⚠ Measures to each box's OWN LABEL RUN, falling back to the line edge only for
 * unlabelled boxes. line.minX is the leftmost point of the WHOLE line, so on a
 * row of five options boxes two through five would each report a wildly negative
 * offset. While one box per line survived, the two measurements were identical —
 * so this depends on matchCheckboxes being run-keyed.
 */
function calibrateMarkOffset(
    pages: ExtractedPage[],
    geometry: DocumentGeometry,
): number {
    const offsets: number[] = [];

    for (const page of pages) {
        const shapes = geometry.pages.find((p) => p.pageNumber === page.pageNumber);
        if (!shapes) continue;

        for (const [line, matches] of matchCheckboxes(page.lines, shapes.checkboxes)) {
            for (const { box, run } of matches) {
                offsets.push(labelOffset(line, box, run));
            }
        }
    }

    if (offsets.length === 0) return FALLBACK_MARK_OFFSET;

    offsets.sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)];
}

/** Gap between a box and the text it labels, signed the same way for both scripts. */
function labelOffset(line: Line, box: GeometryRect, run: Run | null): number {
    if (run) {
        return line.dir === "rtl"
            ? box.x - (run.x + run.width)
            : run.x - (box.x + box.width);
    }

    return line.dir === "rtl" ? box.x - line.maxX : line.minX - (box.x + box.width);
}

/** A mark centred on a leader line — for write-ins with a rule drawn. */
function leaderMark(leader: GeometryRect | undefined, size: number): GeometryRect | null {
    if (!leader) return null;

    return {
        x: leader.x,
        y: leader.y,
        width: leader.width,
        height: size,
    };
}

/**
 * The rectangle a line occupies on the page, for the focus band.
 *
 * ⚠ line.y is the BASELINE, not the top, so the box grows upward — drawing from
 * the baseline down puts a highlight under the text. Direction-agnostic:
 * minX/maxX are extents regardless of script.
 *
 * The 9pt fallback guards zero-height whitespace items, which some producers
 * emit; a zero-height highlight is invisible rather than obviously wrong.
 */
function lineBounds(line: Line): GeometryRect {
    const height = Math.max(...line.runs.map((r) => r.height || 9), 1);

    return {
        x: line.minX,
        y: line.y - height * 0.25,
        width: Math.max(line.maxX - line.minX, 1),
        height: height * 1.25,
    };
}

/** A mark placed by calibration, for lines with no shape of their own. */
function offsetMark(line: Line, offset: number, size: number): GeometryRect {
    const x = line.dir === "rtl" ? line.maxX + offset : line.minX - offset - size;

    // Baseline minus a fraction of the size, matching where drawn boxes sit
    // relative to their text.
    return { x, y: line.y - size * 0.15, width: size, height: size };
}

/**
 * Per-cell rects for a comb.
 *
 * ⚠ INDEXED LEFT TO RIGHT, GEOMETRICALLY. On an RTL form the first character the
 * user writes belongs in the RIGHTMOST cell, so a 9-digit ID fills index 8 down
 * to 0 — filling 0 upward writes it mirrored, and it looks entirely plausible on
 * screen. Not currently a live risk because nothing writes into cells
 * programmatically; if autofill is ever added, this is the first thing to get
 * right. EXPLAINER §9.5.
 */
function cellRects(comb: CombField): GeometryRect[] {
    return Array.from({ length: comb.cellCount }, (_, i) => ({
        x: comb.x + i * comb.cellWidth,
        y: comb.y,
        width: comb.cellWidth,
        height: comb.height,
    }));
}