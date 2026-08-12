/**
 * copilot/detect-fields.ts
 *
 * Joins extract-text.ts (lines) to extract-geometry.ts (drawn shapes) and
 * produces the two things the rest of Phase 2 needs:
 *
 *   1. A PAYLOAD for the model — text only, plus a small semantic tag saying
 *      "this line has a checkbox" or "this line has a 9-cell field". No
 *      coordinates ever.
 *   2. A CLIENT MAP — for each line, where a mark would go if the model says
 *      to put one there. Coordinates only, never sent anywhere.
 *
 * ─── RENAMED FROM detect-blanks.ts, ON PURPOSE ───────────────────────────
 * §7.1 called this "blank detection" and described it as finding the blanks
 * and sending that list to the model. That design makes geometry a GATE: no
 * shape found, no field, no advice. The fixture disproves it — section ב has
 * nine eligibility clauses and only eight checkboxes, so a gated design
 * silently drops a real option. And no geometric rule can ever handle a
 * heading that says "mark the relevant options below."
 *
 * So the model sees the WHOLE document text and decides what the fields are.
 * This file only enriches. If every detector here returns nothing, the copilot
 * still works: every field is still found, still explained, still listed. Only
 * mark placement degrades. Preserve that property when editing.
 *
 * ─── WHAT GOES TO THE MODEL, AND WHAT NEVER DOES ─────────────────────────
 * Coordinates never go. The model can do nothing with x: 544.3, and mapping an
 * answer to a position is this codebase's job — that is the whole reason local
 * extraction exists (§3).
 *
 * Cell counts DO go, because they change the answer. "Nine cells, one
 * character each" makes the model return nine digits; a six-cell date field
 * wants DDMMYY and an eight-cell one wants DDMMYYYY. It cannot know which
 * without being told, and the text layer does not contain it.
 *
 * ABSENCE IS NEVER ASSERTED. A line either carries a tag or carries nothing,
 * and nothing means UNKNOWN, not "no checkbox here". If geometry extraction
 * fails wholesale, every line is untagged and the model simply reasons from
 * the Hebrew — which it does well. Telling it "no checkbox on this line" when
 * the detector merely broke would have it confidently instruct the user to
 * write on a line that has a box.
 */

import type { ExtractedPage, Line, Run } from "./extract-text";
import type { CombField, DocumentGeometry, GeometryRect } from "./extract-geometry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AffordanceKind = "checkbox" | "cells" | "writeIn";

/**
 * One field found on a line.
 *
 * ⚠ A LINE CAN CARRY SEVERAL. Page 1's עמית table puts four column labels on a
 * single line — שם משפחה, שם פרטי, מס' הזהות, תאריך לידה — with a 6-cell comb
 * and a 9-cell comb beneath it. An earlier version keyed affordances by line
 * and silently kept only the first, dropping the ID number field entirely.
 * That bug was invisible until the pipeline was run end to end and the comb
 * tags were counted (4 emitted, 5 detected).
 */
export interface DetectedField {
    /** Stable id the model quotes back, e.g. "p1l3f0". Keys `geometry`. */
    ref: string;
    kind: AffordanceKind;
    /** Character count, `cells` only. */
    count?: number;
    /** The specific run labelling this field, when it's narrower than the line. */
    label?: string;
}

/** What the model is told about one line. Text and meaning only. */
export interface PayloadLine {
    id: string;
    page: number;
    text: string;
    /** Omitted when nothing was detected. Never present as a negative claim. */
    fields?: DetectedField[];
    /** True when part of this line's text failed the readability check (§6.7). */
    unreliableText?: true;
}

/** What the client keeps. Coordinates only; never serialised to a provider. */
export interface FieldGeometry {
    id: string;
    page: number;
    /** Where to place a mark if the model says to mark this line. */
    markRect: GeometryRect;
    /**
     * False when markRect was computed from the calibrated offset rather than
     * from a shape actually found on this line. The UI can say "no box printed
     * on the form" — a fact we hold, not a guess the model made.
     */
    fromDrawnShape: boolean;
    /** Per-cell rects, left to right, when this is a comb. See the RTL warning. */
    cells?: GeometryRect[];
}

export interface DetectionResult {
    payload: PayloadLine[];
    geometry: Map<string, FieldGeometry>;
    markOffset: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** A shape and a baseline within this many points are on the same line. */
const SAME_LINE_BAND = 6;

/**
 * How far above a comb its label may sit. Two line-heights: on this fixture
 * the label is 13.9–15.8pt up, with an intervening line in section ד.
 */
const LABEL_SEARCH_HEIGHT = 40;

/** Minimum horizontal overlap for a run to count as a comb's label. */
const LABEL_MIN_OVERLAP = 2;

/**
 * Fallback offset from a line's edge to its mark, used only when nothing was
 * calibrated. Measured at 2.44–2.75pt on the fixture, but the calibrated value
 * is always preferred — this exists so a total geometry failure still places
 * marks somewhere sane rather than on top of the text.
 */
const FALLBACK_MARK_OFFSET = 3;

/** A mark with no box to sit in gets this size, in points. */
const DEFAULT_MARK_SIZE = 9;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function detectFields(
    pages: ExtractedPage[],
    geometry: DocumentGeometry,
): DetectionResult {
    const payload: PayloadLine[] = [];
    const map = new Map<string, FieldGeometry>();

    // Calibrate first, across the whole document. See calibrateMarkOffset.
    const offset = calibrateMarkOffset(pages, geometry);
    const markSize = geometry.checkboxSize ?? DEFAULT_MARK_SIZE;

    for (const page of pages) {
        const shapes = geometry.pages.find((p) => p.pageNumber === page.pageNumber);

        const checkboxes = matchCheckboxes(page.lines, shapes?.checkboxes ?? []);
        const leaders = matchLeaders(page.lines, shapes?.leaders ?? []);
        const combs = matchCombs(page.lines, shapes?.combs ?? []);

        page.lines.forEach((line, index) => {
            const id = `p${page.pageNumber}l${index}`;
            const fields: DetectedField[] = [];

            // Combs first and possibly several — see DetectedField's comment.
            for (const { comb, label } of combs.get(line) ?? []) {
                const ref = `${id}f${fields.length}`;

                fields.push({ ref, kind: "cells", count: comb.cellCount, label });
                map.set(ref, {
                    id: ref,
                    page: page.pageNumber,
                    markRect: { x: comb.x, y: comb.y, width: comb.width, height: comb.height },
                    fromDrawnShape: true,
                    cells: cellRects(comb),
                });
            }

            const box = checkboxes.get(line);
            if (box) {
                const ref = `${id}f${fields.length}`;

                fields.push({ ref, kind: "checkbox" });
                map.set(ref, { id: ref, page: page.pageNumber, markRect: box, fromDrawnShape: true });
            }

            const leader = leaders.get(line);
            if (leader || hasWideGap(line)) {
                const ref = `${id}f${fields.length}`;

                fields.push({ ref, kind: "writeIn" });
                map.set(ref, {
                    id: ref,
                    page: page.pageNumber,
                    markRect: leaderMark(leader, markSize) ?? offsetMark(line, offset, markSize),
                    fromDrawnShape: leader !== undefined,
                });
            }

            payload.push({
                id,
                page: page.pageNumber,
                text: line.text,
                ...(fields.length > 0 ? { fields } : {}),
                ...(line.hasSuspectText ? { unreliableText: true as const } : {}),
            });

            // Every line also gets a fallback entry under its own id, so a line
            // the model calls a field with no shape detected on it — the
            // התחלתי לעבוד clause, which has no checkbox printed — still has
            // somewhere to put a mark. This is what calibration is for.
            if (!map.has(id)) {
                map.set(id, {
                    id,
                    page: page.pageNumber,
                    markRect: offsetMark(line, offset, markSize),
                    fromDrawnShape: false,
                });
            }
        });
    }

    return { payload, geometry: map, markOffset: offset };
}

// ---------------------------------------------------------------------------
// Matching shapes to lines
// ---------------------------------------------------------------------------

/**
 * Attach each checkbox to the line it belongs to.
 *
 * Nearest-baseline alone is NOT enough and gets a real case wrong. On page 1
 * the box beside `משיכה חלקית` (baseline 195.3) is 2.4pt from that line and
 * 2.3pt from the sidebar promo line `בקופת גמל לפרטים` at 196.5 — the promo
 * line wins on distance and the box attaches to an advert.
 *
 * The tiebreak is horizontal: a checkbox sits just outside its line's text
 * edge, 2.44–2.75pt on this document. The promo line's edge is 352pt away.
 * So among lines in the vertical band, pick the one whose edge is nearest.
 */
function matchCheckboxes(
    lines: Line[],
    boxes: GeometryRect[],
): Map<Line, GeometryRect> {
    const matched = new Map<Line, GeometryRect>();

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

        // Don't overwrite: array order is document order, and the first match
        // is the one drawn first. A second box on one line means the match is
        // wrong somewhere, and keeping the first is the less surprising failure.
        if (best && !matched.has(best)) matched.set(best, box);
    }

    return matched;
}

/**
 * Distance from a shape to the side of the line a mark would go on.
 *
 * On an RTL line that is the RIGHT edge, because Hebrew reads right to left
 * and the checkbox precedes its text. Using the wrong edge puts every mark on
 * the far side of the page — which looks like a coordinate bug and is not one.
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

/**
 * Attach each comb to the line carrying its label.
 *
 * A comb has no text of its own — it is an empty row of cells — so its label
 * is always on another line, and "nearest line above" is wrong. Section ד of
 * the fixture lays each row out as three lines: labels on top, signature text
 * in the middle, tick marks at the bottom. The nearest line above a comb is
 * therefore the SIGNATURE text, in a different column, horizontally disjoint.
 *
 * The rule that works on both layouts here: walk upward and take the first
 * line containing a run that horizontally OVERLAPS the comb. That gives
 *   page 1 — 6 cells → תאריך לידה, 9 cells → מס' הזהות   (dy 15.8)
 *   page 2 — 9 cells → מספר זהות, three times            (dy 13.9)
 * where nearest-line-above gives the wrong answer on page 2 every time.
 */
export interface CombMatch {
    comb: CombField;
    /** Text of the run that labels this comb, e.g. "מס' הזהות". */
    label: string;
}

function matchCombs(lines: Line[], combs: CombField[]): Map<Line, CombMatch[]> {
    const matched = new Map<Line, CombMatch[]>();

    for (const comb of combs) {
        const above = lines
            .filter((l) => l.y > comb.y && l.y - comb.y <= LABEL_SEARCH_HEIGHT)
            .sort((a, b) => a.y - b.y);

        for (const line of above) {
            const label = overlappingRun(line, comb);
            if (!label) continue;

            // Append, never replace. Page 1's header line labels BOTH combs,
            // and replacing here silently dropped the ID number field.
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
 * Returning the run rather than a boolean is what makes per-field labelling
 * possible: on page 1 both combs match the same line, and only the individual
 * run distinguishes תאריך לידה from מס' הזהות. BEST overlap, not first —
 * neighbouring column labels can both clip a comb's edge.
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

// ---------------------------------------------------------------------------
// Text gaps
// ---------------------------------------------------------------------------

/**
 * Does this line contain a gap wide enough to be a blank?
 *
 * Every blank on this form shows up as a whitespace run followed by a large
 * positional jump — 48 to 105pt, against sub-1pt between ordinary words. §7.1
 * proposed finding these by regex for underscore or dot runs; there are ZERO
 * of either in this document's text, on any page. The dotted leaders you can
 * see are vector strokes, which is extract-geometry.ts's business.
 *
 * The threshold is one em of the adjacent text rather than a constant, so it
 * scales with the type size instead of needing a number per document.
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
 * Learn this document's offset from a line's text edge to its checkbox.
 *
 * Measured across the fixture: 2.75, 2.44, 2.75 on the three pages — stable
 * enough that a document-wide median is meaningful. The median is used rather
 * than the mean so one mismatched box can't drag it.
 *
 * THIS IS THE POINT OF THE WHOLE CALIBRATION. It means a line the model says
 * to tick, but where no box was drawn, still gets a mark exactly where a box
 * would have been — because the document told us where that is. The
 * `התחלתי לעבוד` clause in section ב is precisely that case, and it stops
 * being a silent failure.
 */
function calibrateMarkOffset(
    pages: ExtractedPage[],
    geometry: DocumentGeometry,
): number {
    const offsets: number[] = [];

    for (const page of pages) {
        const shapes = geometry.pages.find((p) => p.pageNumber === page.pageNumber);
        if (!shapes) continue;

        for (const [line, box] of matchCheckboxes(page.lines, shapes.checkboxes)) {
            offsets.push(
                line.dir === "rtl" ? box.x - line.maxX : line.minX - (box.x + box.width),
            );
        }
    }

    if (offsets.length === 0) return FALLBACK_MARK_OFFSET;

    offsets.sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)];
}

/** A mark centred on a leader line — for write-in fields with a rule drawn. */
function leaderMark(leader: GeometryRect | undefined, size: number): GeometryRect | null {
    if (!leader) return null;

    return {
        x: leader.x,
        y: leader.y,
        width: leader.width,
        height: size,
    };
}

/** A mark placed by calibration, for lines with no shape of their own. */
function offsetMark(line: Line, offset: number, size: number): GeometryRect {
    const x = line.dir === "rtl" ? line.maxX + offset : line.minX - offset - size;

    // Baseline minus a fraction of the size, matching where drawn boxes sit
    // relative to their text (1.2pt below the baseline on this document).
    return { x, y: line.y - size * 0.15, width: size, height: size };
}

/**
 * Per-cell rects for a comb.
 *
 * ⚠ INDEXED LEFT TO RIGHT, GEOMETRICALLY. On an RTL form the first character
 * the user writes belongs in the RIGHTMOST cell, so a 9-digit ID fills index 8
 * down to 0. Filling 0 upward writes the number mirrored — and it looks
 * entirely plausible on screen. This is the single most likely place in Phase
 * 2 to produce a wrong value that nobody catches before printing.
 */
function cellRects(comb: CombField): GeometryRect[] {
    return Array.from({ length: comb.cellCount }, (_, i) => ({
        x: comb.x + i * comb.cellWidth,
        y: comb.y,
        width: comb.cellWidth,
        height: comb.height,
    }));
}