/**
 * copilot/extract-geometry.ts
 *
 * Finds the parts of a form that are DRAWN rather than written: checkbox
 * squares, comb fields (the rows of little cells for an ID number or a date),
 * and dashed leader lines. Returns them in PDF points, origin bottom-left —
 * the same space extract-text.ts and state/annotations.ts use.
 *
 * ─── WHAT THIS FILE IS *NOT* FOR ─────────────────────────────────────────
 * It does NOT decide what the form's fields are. That is the model's job,
 * working from the text, and it is strictly better at it: a heading that says
 * "mark the relevant options below" creates fields that no geometric rule
 * could ever find. Discovery is text-driven, always.
 *
 * Geometry answers a narrower question: given that a field exists on a line,
 * WHERE exactly does a mark go, and HOW MUCH ROOM is there? So nothing here
 * gates anything. If this whole file returns empty, every field still appears
 * in the panel with the model's reasoning intact; marks just land less
 * precisely. That is the property to preserve when editing it.
 *
 * The fixture proves why this matters: section ב has nine eligibility clauses
 * and only EIGHT checkboxes — the clause beginning התחלתי לעבוד במקום חדש has
 * no box drawn beside it (confirmed by rasterising, not just by this code).
 * A geometry-gated design silently drops that option. A text-driven one
 * reports it normally and notes that no box was printed.
 *
 * ─── NO HARDCODED SIZES ──────────────────────────────────────────────────
 * Checkbox size and comb cell width are DERIVED from the document by looking
 * for repetition, because that is the one thing form furniture reliably does:
 * a form repeats its checkbox twenty times and its cell width nine times in a
 * row. Nothing else on a page does that by accident. A form typeset at any
 * other scale works without retuning.
 *
 * ─── ⚠ PRIVATE, VERSION-UNSTABLE pdf.js API ──────────────────────────────
 * getOperatorList() is public; the SHAPE of what it returns is not, and it
 * changed substantially between v4 and v6:
 *   - v4 emitted separate `stroke` / `fill` ops. v6 emits NONE — the paint
 *     operation moved into constructPath's first argument.
 *   - v4 had a `rectangle` opcode carrying [x, y, w, h] directly. v6 emits
 *     rectangles as moveTo + 3×lineTo + close in a flat coordinate array.
 * Both changes yield ZERO results rather than an error. That is why nothing
 * here throws: a wrong assumption must degrade placement, never break the
 * copilot. If an upgrade turns the counts below to zero, this file is the
 * cause, and it is safe to delete while you fix it.
 *
 * VERIFIED on pdfjs-dist 6.2.108 against the Harel fixture:
 *   derived checkbox size 8.0pt from 20 occurrences
 *   page 1 — 12 checkboxes, 4 leaders, combs of 6 and 9 cells
 *   page 2 —  1 checkbox,   8 leaders, three 9-cell combs
 *   page 3 —  7 checkboxes, 0 leaders, 0 combs
 * The 6- and 9-cell counts are the point: 6 = DDMMYY, 9 = an Israeli ID.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { OPS } from "pdfjs-dist";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** PDF points, origin bottom-left. Same convention as state/annotations.ts. */
export interface GeometryRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * A row of equal cells — an ID number, a date, a phone number.
 *
 * cellCount is the valuable part and the reason this detector exists. "This
 * field holds nine characters, one per cell" is a different instruction to the
 * model than "write your ID here", and it is information the text layer simply
 * does not contain: text extraction sees only a wide gap.
 */
export interface CombField extends GeometryRect {
    cellCount: number;
    /** Width of one cell, in points. Derived, never assumed. */
    cellWidth: number;
}

export interface PageGeometry {
    pageNumber: number;
    checkboxes: GeometryRect[];
    combs: CombField[];
    /** Dashed horizontal rules — the "write here" lines. */
    leaders: GeometryRect[];
}

export interface DocumentGeometry {
    pages: PageGeometry[];
    /**
     * The checkbox size this document uses, in points, or null when no size
     * repeated often enough to be confident. Null is a normal outcome, not an
     * error — a form with two checkboxes has no mode to find.
     */
    checkboxSize: number | null;
    /** False when extraction failed. Callers degrade placement; they do not fail. */
    ok: boolean;
}

// ---------------------------------------------------------------------------
// Tuning
//
// These are all SHAPE qualifiers, not size assumptions. None of them encodes
// how big a checkbox is or how wide a cell is — those are measured. Read any
// change to this block as a change to what counts as "square" or "thin",
// never as retuning for a particular document.
// ---------------------------------------------------------------------------

/** How far from square a checkbox may be, as a fraction of its longer side. */
const SQUARENESS_RATIO = 0.25;
/** Absolute sanity bounds. Wide on purpose — the mode does the real work. */
const CANDIDATE_MIN_SIZE = 3;
const CANDIDATE_MAX_SIZE = 30;
/** A rectangle is 5 commands. A letterform is dozens. */
const MAX_BOX_COMMANDS = 10;
/** A size must repeat at least this often before it's believed to be the checkbox. */
const MIN_CHECKBOX_REPEATS = 3;
/** How far an individual box may sit from the derived size. */
const CHECKBOX_SIZE_TOLERANCE = 0.75;

/** Comb separators: thin vertical ticks. */
const TICK_MAX_WIDTH = 1.5;
const TICK_MIN_HEIGHT = 3;
const TICK_MAX_HEIGHT = 25;
/** Ticks within this vertical distance are treated as one row. */
const BAND_TOLERANCE = 2;
/** Cell widths must match to within the larger of these two. */
const GAP_TOLERANCE_ABS = 0.4;
const GAP_TOLERANCE_RATIO = 0.06;
/** Fewer than this many equal gaps is a coincidence, not a comb. */
const MIN_COMB_CELLS = 3;

/** A leader is a dashed rule: essentially no height, meaningfully long. */
const LEADER_MAX_HEIGHT = 2;
const LEADER_MIN_WIDTH = 20;

/**
 * Path command codes INSIDE constructPath's coordinate array. Local to the
 * path encoding, NOT the OPS constants — OPS.moveTo is 13, but a moveTo inside
 * this array is 0. Confusing the two is the easiest mistake in this file.
 */
const PATH_MOVE_TO = 0;
const PATH_LINE_TO = 1;
const PATH_CURVE_TO = 2;
const PATH_CLOSE = 4;

/** constructPath's first argument is the paint op, as an OPS constant. */
const STROKING_PAINT_OPS = new Set<number>([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
]);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract drawn geometry for the WHOLE DOCUMENT.
 *
 * Document-level rather than page-level on purpose: the checkbox size is found
 * by repetition, and a single page may not repeat it enough to be sure. Page 2
 * of the fixture has exactly one checkbox — in isolation there is no mode to
 * find, but pooled with pages 1 and 3 the size is obvious and page 2's single
 * box is classified correctly.
 *
 * NEVER THROWS. `ok: false` means "place marks by fallback offset", not
 * "give up".
 *
 * Call once at load, before the first PdfPage mounts, so nothing races
 * page.cleanup() (§6.14) — same rule as extractPageText.
 */
export async function extractDocumentGeometry(
    doc: PDFDocumentProxy,
): Promise<DocumentGeometry> {
    try {
        const perPage: Shape[][] = [];

        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
            perPage.push(await collectShapes(await doc.getPage(pageNumber)));
        }

        const checkboxSize = deriveCheckboxSize(perPage.flat());

        return {
            pages: perPage.map((shapes, index) => ({
                pageNumber: index + 1,
                checkboxes:
                    checkboxSize === null
                        ? []
                        : shapes.filter((s) => isCheckbox(s, checkboxSize)).map((s) => s.rect),
                combs: findCombs(shapes),
                leaders: shapes.filter(isLeader).map((s) => s.rect),
            })),
            checkboxSize,
            ok: true,
        };
    } catch (error) {
        console.warn("Geometry extraction failed:", error);

        return {
            pages: Array.from({ length: doc.numPages }, (_, i) => ({
                pageNumber: i + 1,
                checkboxes: [],
                combs: [],
                leaders: [],
            })),
            checkboxSize: null,
            ok: false,
        };
    }
}

/**
 * The rect of one cell in a comb, for dropping a single character into it.
 *
 * Cells are indexed left to right — GEOMETRICALLY, not logically. On an RTL
 * form the first character the user writes goes in the RIGHTMOST cell, so a
 * Hebrew ID number fills index cellCount-1 downward to 0. Getting this
 * backwards writes the number mirrored, and it will look plausible enough on
 * screen that nobody notices until it is printed.
 */
export function combCellRect(comb: CombField, index: number): GeometryRect {
    return {
        x: comb.x + index * comb.cellWidth,
        y: comb.y,
        width: comb.cellWidth,
        height: comb.height,
    };
}

// ---------------------------------------------------------------------------
// Walking the operator list
// ---------------------------------------------------------------------------

interface Shape {
    rect: GeometryRect;
    /** True if a dash pattern was active when this was painted. */
    dashed: boolean;
    stroked: boolean;
    /** Count of moveTo commands. >1 means disconnected subpaths. */
    subpaths: number;
    /** Total drawing commands. A rectangle is 5; a glyph outline is dozens. */
    commands: number;
}

/** [a, b, c, d, e, f] — the standard 2D affine matrix. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

async function collectShapes(page: PDFPageProxy): Promise<Shape[]> {
    const { fnArray, argsArray } = await page.getOperatorList();

    const shapes: Shape[] = [];
    const stack: Matrix[] = [];

    let ctm: Matrix = [...IDENTITY];
    let dashed = false;

    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];

        // The graphics state stack. Every shape's position depends on this
        // being exactly right — an unbalanced restore relocates everything
        // afterwards to somewhere plausible rather than raising an error.
        if (fn === OPS.save) {
            stack.push([...ctm]);
            continue;
        }

        if (fn === OPS.restore) {
            ctm = stack.pop() ?? [...IDENTITY];
            continue;
        }

        if (fn === OPS.transform) {
            ctm = multiply(ctm, args as Matrix);
            continue;
        }

        // setDash([], 0) clears the pattern, setDash([2, 2], 0) sets one. This
        // is the only thing separating a dotted leader from a solid table rule,
        // which are otherwise the same shape — and this form is full of rules.
        if (fn === OPS.setDash) {
            dashed = Array.isArray(args[0]) && args[0].length > 0;
            continue;
        }

        if (fn !== OPS.constructPath) continue;

        const shape = readPath(args, ctm, dashed);
        if (shape) shapes.push(shape);
    }

    return shapes;
}

/**
 * Decode one constructPath call.
 *
 * v6 argument layout, none of it documented:
 *   args[0] — paint operation, an OPS constant (OPS.stroke, OPS.fill, …)
 *   args[1] — array whose [0] is a Float32Array of interleaved commands and
 *             coordinates: [cmd, x, y, cmd, x, y, …]; curves carry six
 *             coordinates, close carries none
 *   args[2] — Float32Array bounding box [minX, minY, maxX, maxY], already
 *             computed, in path space
 *
 * args[2] is why this file is short: we never walk coordinates to find a
 * shape's extent, only to measure its complexity.
 */
function readPath(args: unknown[], ctm: Matrix, dashed: boolean): Shape | null {
    const paintOp = args[0] as number;

    // These construct a path that is never painted. Including them floods the
    // results with invisible geometry — the clip rect alone is page-sized.
    if (paintOp === OPS.endPath || paintOp === OPS.clip || paintOp === OPS.eoClip) {
        return null;
    }

    const commands = (args[1] as ArrayLike<number>[] | undefined)?.[0];
    const bbox = args[2] as ArrayLike<number> | undefined;
    if (!commands || !bbox || bbox.length < 4) return null;

    const summary = summarise(commands);
    if (!summary) return null;

    return {
        rect: transformBox(bbox, ctm),
        dashed,
        stroked: STROKING_PAINT_OPS.has(paintOp),
        subpaths: summary.subpaths,
        commands: summary.commandCount,
    };
}

interface PathSummary {
    subpaths: number;
    commandCount: number;
}

/**
 * Count subpaths and commands. Coordinates are irrelevant here; only the
 * stride matters, and the stride depends on the command.
 */
function summarise(commands: ArrayLike<number>): PathSummary | null {
    let subpaths = 0;
    let commandCount = 0;

    for (let i = 0; i < commands.length; ) {
        // Every branch spelled out, and an unknown opcode bails.
        //
        // The tempting shorthand is `else i += 3` for anything that isn't a
        // curve or a close. It is correct for both opcodes that exist today.
        // But if pdf.js adds a third, the shorthand consumes it at the wrong
        // stride and from there every opcode is read out of the middle of a
        // coordinate pair — the walk completes without error and returns
        // numbers that are simply wrong, so shapes quietly stop matching.
        // Returning null drops one shape instead of corrupting all of them.
        switch (commands[i]) {
            case PATH_MOVE_TO:
                subpaths++;
                i += 3;
                break;

            case PATH_LINE_TO:
                i += 3;
                break;

            case PATH_CURVE_TO:
                i += 7;
                break;

            case PATH_CLOSE:
                i += 1;
                break;

            default:
                return null;
        }

        commandCount++;
    }

    return { subpaths, commandCount };
}

// ---------------------------------------------------------------------------
// Checkboxes — size derived, not assumed
// ---------------------------------------------------------------------------

/**
 * Could this shape be a checkbox at all, ignoring size?
 *
 * Complexity is what separates a box from a letterform: a checkbox is one
 * subpath of five commands, a glyph is dozens across several. Squareness is
 * proportional rather than absolute so it behaves the same at any scale — and
 * the proportional form is what removes the one false positive the previous
 * absolute version produced (a 6.0 × 8.1 rectangle on page 2).
 */
function isBoxCandidate(shape: Shape): boolean {
    if (shape.subpaths !== 1) return false;
    if (shape.commands > MAX_BOX_COMMANDS) return false;

    const { width, height } = shape.rect;

    if (width < CANDIDATE_MIN_SIZE || width > CANDIDATE_MAX_SIZE) return false;
    if (height < CANDIDATE_MIN_SIZE || height > CANDIDATE_MAX_SIZE) return false;

    return Math.abs(width - height) / Math.max(width, height) <= SQUARENESS_RATIO;
}

/**
 * Find the size this document uses for checkboxes, by mode.
 *
 * A form repeats its checkbox. Nothing else repeats a size at the same scale:
 * on the fixture, 8.0pt occurs 20 times, the runner-up 5 times, and every
 * other size exactly once.
 *
 * Returns null when nothing repeats enough — a normal outcome for a form with
 * one or two boxes, and the caller must handle it rather than treat it as an
 * error.
 *
 * NOTE: stroked and filled candidates are pooled deliberately, so a form using
 * filled boxes works without a flag. The risk is a document whose bullet
 * markers are small filled squares out-voting the real checkboxes. This
 * fixture dodges that because its ■ bullets are ZapfDingbats *text*, not
 * paths. If a document ever trips it, preferring the stroked cluster when both
 * exist is the fix — an empty checkbox is virtually always an outline.
 */
function deriveCheckboxSize(shapes: Shape[]): number | null {
    const histogram = new Map<number, number>();

    for (const shape of shapes) {
        if (!isBoxCandidate(shape)) continue;

        // Half-point buckets: fine enough to separate real sizes, coarse
        // enough that float noise doesn't split one size across two buckets.
        const bucket = Math.round(shape.rect.width * 2) / 2;
        histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    }

    let bestSize: number | null = null;
    let bestCount = 0;

    for (const [size, count] of histogram) {
        // Ties break toward the smaller size: decorative repeated shapes tend
        // to be larger than checkboxes, not smaller.
        if (count > bestCount || (count === bestCount && bestSize !== null && size < bestSize)) {
            bestSize = size;
            bestCount = count;
        }
    }

    return bestCount >= MIN_CHECKBOX_REPEATS ? bestSize : null;
}

function isCheckbox(shape: Shape, size: number): boolean {
    if (!isBoxCandidate(shape)) return false;

    return (
        Math.abs(shape.rect.width - size) <= CHECKBOX_SIZE_TOLERANCE &&
        Math.abs(shape.rect.height - size) <= CHECKBOX_SIZE_TOLERANCE
    );
}

// ---------------------------------------------------------------------------
// Comb fields — cell width derived, not assumed
// ---------------------------------------------------------------------------

/**
 * Find rows of equal cells.
 *
 * The signal is evenly spaced vertical ticks: group thin vertical strokes into
 * horizontal bands, then look for runs of three or more consecutive EQUAL
 * gaps. Equal spacing repeated four times is not something a page layout does
 * by accident, which makes this the most specific detector in the file — and
 * the cell width falls out of the data rather than being configured.
 *
 * On the fixture this yields exactly the semantically right numbers: 6 cells
 * for the date of birth (DDMMYY) and 9 for the ID number, plus three more
 * 9-cell ID fields on page 2 for the parent and guardian rows.
 *
 * WHY THE TOLERANCE IS PROPORTIONAL: the ID field's first cell is genuinely
 * 0.49pt narrower than the rest (15.31 against 15.80). A flat 0.4pt tolerance
 * rejects it and reports 8 cells for a 9-digit number — an off-by-one that
 * would have the model suggest eight digits for an Israeli ID. Six percent of
 * the cell width accepts it while staying nowhere near the 100pt-plus gaps
 * that separate one field from the next.
 */
function findCombs(shapes: Shape[]): CombField[] {
    const ticks = shapes.filter(
        (s) =>
            s.rect.width <= TICK_MAX_WIDTH &&
            s.rect.height >= TICK_MIN_HEIGHT &&
            s.rect.height <= TICK_MAX_HEIGHT,
    );

    const bands = groupIntoBands(ticks);
    const combs: CombField[] = [];

    for (const band of bands) {
        const xs = band.ticks.map((t) => t.rect.x).sort((a, b) => a - b);
        const height = Math.max(...band.ticks.map((t) => t.rect.height));

        let start = 0;

        while (start < xs.length - 1) {
            const cellWidth = xs[start + 1] - xs[start];
            const tolerance = Math.max(GAP_TOLERANCE_ABS, cellWidth * GAP_TOLERANCE_RATIO);

            let end = start + 1;
            while (end < xs.length - 1 && Math.abs(xs[end + 1] - xs[end] - cellWidth) <= tolerance) {
                end++;
            }

            const cellCount = end - start;

            if (cellCount >= MIN_COMB_CELLS) {
                combs.push({
                    x: xs[start],
                    y: band.y,
                    width: xs[end] - xs[start],
                    height,
                    cellCount,
                    cellWidth,
                });
            }

            // Advance by ONE on a rejected run, not to `end`.
            //
            // Jumping to `end` consumes the tick that failed to match, and
            // that tick is very often the first boundary of the NEXT comb —
            // two fields sitting side by side share a divider. Skipping it
            // costs the next comb its first cell, which is exactly how the ID
            // field came out one digit short.
            start = cellCount >= MIN_COMB_CELLS ? end : start + 1;
        }
    }

    return combs;
}

interface Band {
    y: number;
    ticks: Shape[];
}

function groupIntoBands(ticks: Shape[]): Band[] {
    const bands: Band[] = [];

    for (const tick of [...ticks].sort((a, b) => b.rect.y - a.rect.y)) {
        const band = bands.find((b) => Math.abs(b.y - tick.rect.y) <= BAND_TOLERANCE);

        if (band) band.ticks.push(tick);
        else bands.push({ y: tick.rect.y, ticks: [tick] });
    }

    return bands;
}

// ---------------------------------------------------------------------------
// Leaders
// ---------------------------------------------------------------------------

/**
 * A dotted leader — the "................" a value gets written on. Its width
 * is the useful part: it tells you how much room the user actually has.
 *
 * These are dashed strokes, not text. §7.1's plan to find them by regex over
 * the text layer finds nothing: this document contains zero dot-runs, zero
 * underscore-runs and zero dash-runs in its text, on any page.
 *
 * CROSS-CHECK: page 1's four leaders sit at y = 613, 450, 181 and 139, exactly
 * the baselines where text-gap analysis independently finds blanks. Two
 * unrelated methods agreeing is the strongest evidence available that both
 * work. Where they disagree is signal for detect-blanks.ts, not noise.
 *
 * KNOWN LIMIT: a form using solid underlines instead of dashes gets nothing
 * here. Loosening to "thin, long, horizontal" would catch those and also catch
 * every table rule on the page — and this form is mostly table rules. There is
 * no adaptive trick here as clean as the ones above; dashed is right for this
 * document and wrong for some others.
 */
function isLeader(shape: Shape): boolean {
    if (!shape.dashed) return false;
    if (!shape.stroked) return false;

    return (
        shape.rect.height <= LEADER_MAX_HEIGHT && shape.rect.width >= LEADER_MIN_WIDTH
    );
}

// ---------------------------------------------------------------------------
// Matrix maths
// ---------------------------------------------------------------------------

function multiply(m: Matrix, n: Matrix): Matrix {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

/**
 * Map a path-space bounding box into page space.
 *
 * All four corners are transformed, not two. Under a rotation or a flip the
 * "min" corner stops being the min, and the shortcut yields negative widths
 * that silently fail every size test downstream instead of announcing
 * themselves.
 */
function transformBox(bbox: ArrayLike<number>, ctm: Matrix): GeometryRect {
    const corners: Array<[number, number]> = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[2], bbox[3]],
        [bbox[0], bbox[3]],
    ];

    const points = corners.map(([x, y]) => ({
        x: ctm[0] * x + ctm[2] * y + ctm[4],
        y: ctm[1] * x + ctm[3] * y + ctm[5],
    }));

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);

    const minX = Math.min(...xs);
    const minY = Math.min(...ys);

    return {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
    };
}