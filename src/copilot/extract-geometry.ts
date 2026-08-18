/**
 * copilot/extract-geometry.ts
 *
 * Finds the parts of a form that are DRAWN rather than written: checkbox squares,
 * comb fields (rows of little cells for an ID or a date), and dashed leader
 * lines. Returns PDF points, origin bottom-left.
 *
 * ⚠ IT DOES NOT DECIDE WHAT THE FIELDS ARE. That is the model's job, working from
 * the text. This answers only "given that a field exists on this line, WHERE does
 * a mark go and HOW MUCH ROOM is there". Nothing here gates anything: if this
 * whole file returns empty, every field still appears with the model's reasoning
 * intact and marks just land less precisely. Preserve that. EXPLAINER §4.1.
 *
 * ⚠ NOTHING HERE THROWS, and no size is hardcoded — checkbox size and cell width
 * are derived from the document by looking for repetition, because repeating its
 * furniture is the one thing a form reliably does. EXPLAINER §4.2.
 *
 * ⚠⚠ PRIVATE, VERSION-UNSTABLE pdf.js API. getOperatorList() is public; the SHAPE
 * of what it returns is not, and it changed substantially v4 → v6. Both changes
 * yielded ZERO results rather than an error — which is why a wrong assumption
 * here must degrade placement, never break the copilot. If an upgrade turns the
 * counts to zero, this file is the cause and it is safe to delete while fixing.
 * EXPLAINER §4.7.
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
 * cellCount is why this detector exists: "nine characters, one per cell" is a
 * different instruction to the model than "write your ID here", and it is
 * information the text layer does not contain. Text extraction sees only a gap.
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
     * The checkbox size this document uses, or null when no size repeated often
     * enough. ⚠ Null is a NORMAL outcome, not an error — a form with two
     * checkboxes has no mode to find, and one whose boxes are text glyphs has no
     * shapes at all.
     */
    checkboxSize: number | null;
    /** False when extraction failed. Callers degrade placement; they don't fail. */
    ok: boolean;
}

// ---------------------------------------------------------------------------
// Tuning
//
// ⚠ These are all SHAPE qualifiers, not size assumptions. None encodes how big a
// checkbox is or how wide a cell is — those are measured. Read any change here as
// a change to what counts as "square" or "thin", never as retuning for a document.
// ---------------------------------------------------------------------------

/** How far from square a checkbox may be, as a fraction of its longer side. */
const SQUARENESS_RATIO = 0.25;
/** Absolute sanity bounds. Wide on purpose — the mode does the real work. */
const CANDIDATE_MIN_SIZE = 3;
const CANDIDATE_MAX_SIZE = 30;
/** A rectangle is 5 commands. A letterform is dozens. */
const MAX_BOX_COMMANDS = 10;
/** A size must repeat this often before it's believed to be the checkbox. */
const MIN_CHECKBOX_REPEATS = 3;
/** How far an individual box may sit from the derived size. */
const CHECKBOX_SIZE_TOLERANCE = 0.75;

/** Comb separators: thin vertical ticks. */
const TICK_MAX_WIDTH = 1.5;
const TICK_MIN_HEIGHT = 3;
const TICK_MAX_HEIGHT = 25;
/** Ticks within this vertical distance are treated as one row. */
const BAND_TOLERANCE = 2;
/** Cell widths must match to within the larger of these two. See findCombs. */
const GAP_TOLERANCE_ABS = 0.4;
const GAP_TOLERANCE_RATIO = 0.06;
/** Fewer than this many equal gaps is a coincidence, not a comb. */
const MIN_COMB_CELLS = 3;

/** A leader is a dashed rule: essentially no height, meaningfully long. */
const LEADER_MAX_HEIGHT = 2;
const LEADER_MIN_WIDTH = 20;

/**
 * ⚠ Path command codes INSIDE constructPath's coordinate array. LOCAL to the path
 * encoding, NOT the OPS constants — OPS.moveTo is 13, but a moveTo inside this
 * array is 0. Confusing the two is the easiest mistake in this file.
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
 * ⚠ Document-level, not per page: checkbox size is found by repetition, and a
 * single page may not repeat it enough. A page with one checkbox has no mode in
 * isolation but classifies correctly when pooled. EXPLAINER §4.2.
 *
 * ⚠ NEVER THROWS. `ok: false` means "place marks by fallback offset", not "give
 * up". Call once at load, before the first PdfPage mounts, so nothing races
 * page.cleanup(). EXPLAINER §7.4.
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

        // ⚠ The graphics state stack. Every shape's position depends on this being
        // exactly right — an unbalanced restore relocates everything afterwards to
        // somewhere plausible rather than raising an error.
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

        // ⚠ The dash pattern is the ONLY thing separating a dotted leader from a
        // solid table rule — otherwise the same shape, and forms are full of rules.
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
 * Decode one constructPath call. v6 argument layout, none of it documented:
 *   args[0] — paint operation, an OPS constant
 *   args[1] — array whose [0] is a Float32Array of interleaved commands and
 *             coordinates: [cmd, x, y, …]; curves carry six, close carries none
 *   args[2] — Float32Array bbox [minX, minY, maxX, maxY], in path space
 *
 * args[2] is why this file is short: coordinates are never walked to find a
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
 * Count subpaths and commands. Coordinates are irrelevant; only the stride
 * matters, and the stride depends on the command.
 */
function summarise(commands: ArrayLike<number>): PathSummary | null {
    let subpaths = 0;
    let commandCount = 0;

    for (let i = 0; i < commands.length;) {
        // ⚠ EVERY BRANCH SPELLED OUT, AND AN UNKNOWN OPCODE BAILS. The tempting
        // shorthand is `else i += 3`, correct for both opcodes that exist today —
        // but if pdf.js adds a third, that consumes it at the wrong stride and from
        // then on every opcode is read out of the middle of a coordinate pair. The
        // walk completes without error and returns numbers that are simply wrong,
        // so shapes quietly stop matching. Returning null drops ONE shape instead
        // of corrupting all of them. EXPLAINER §4.7.
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
 * Complexity separates a box from a letterform: a checkbox is one subpath of five
 * commands, a glyph is dozens across several. ⚠ Squareness is PROPORTIONAL so it
 * behaves the same at any scale — the absolute version produced a false positive.
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
 * Find the size this document uses for checkboxes, by mode. Nothing else on a
 * page repeats a size at the same scale. Returns null when nothing repeats
 * enough — a normal outcome the caller must handle. EXPLAINER §4.2.
 *
 * ⚠ Stroked and filled candidates are POOLED deliberately, so a form using filled
 * boxes works without a flag. The risk is a document whose bullet markers are
 * small filled squares out-voting the real checkboxes. If that ever trips,
 * preferring the stroked cluster when both exist is the fix — an empty checkbox
 * is virtually always an outline.
 */
function deriveCheckboxSize(shapes: Shape[]): number | null {
    const histogram = new Map<number, number>();

    for (const shape of shapes) {
        if (!isBoxCandidate(shape)) continue;

        // Half-point buckets: fine enough to separate real sizes, coarse enough
        // that float noise doesn't split one size across two buckets.
        const bucket = Math.round(shape.rect.width * 2) / 2;
        histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    }

    let bestSize: number | null = null;
    let bestCount = 0;

    for (const [size, count] of histogram) {
        // Ties break toward the smaller size: decorative repeated shapes tend to
        // be larger than checkboxes, not smaller.
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
 * Find rows of equal cells: group thin vertical strokes into horizontal bands,
 * then look for runs of three or more consecutive EQUAL gaps. Equal spacing
 * repeated four times is not something a layout does by accident, which makes
 * this the most specific detector here — and the cell width falls out of the data.
 *
 * ⚠ THE TOLERANCE IS PROPORTIONAL for a measured reason: a real comb's first cell
 * can be 0.49pt narrower than the rest (15.31 against 15.80). A flat 0.4pt
 * tolerance rejects it and reports 8 cells for a 9-digit number — an off-by-one
 * that would have the model suggest eight digits for a national ID.
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

            // ⚠ ADVANCE BY ONE on a rejected run, not to `end`. Jumping to `end`
            // consumes the tick that failed to match, and that tick is very often
            // the first boundary of the NEXT comb — two fields side by side share a
            // divider. Skipping it costs the next comb its first cell.
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
 * A dotted leader — the "................" a value gets written on. Its width is
 * the useful part: it says how much room the user actually has.
 *
 * These are dashed STROKES, not text — a form can contain zero dot-runs in its
 * text layer and still show leaders on every page.
 *
 * ⚠ KNOWN LIMIT: a form using solid underlines gets nothing here. Loosening to
 * "thin, long, horizontal" would catch those and also every table rule on the
 * page — and on some forms those same solid rules ARE the field boundaries.
 * Identical geometry, opposite meaning; there is no adaptive trick as clean as
 * the ones above. EXPLAINER §4.6.
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
 * ⚠ ALL FOUR CORNERS, not two. Under a rotation or a flip the "min" corner stops
 * being the min, and the two-corner shortcut yields negative widths that silently
 * fail every size test downstream instead of announcing themselves.
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