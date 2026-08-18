/**
 * copilot/extract-text.ts
 *
 * Turns a pdf.js page into ordered lines of text in LOGICAL order, in PDF points
 * (origin bottom-left) — the same space state/annotations.ts stores in.
 *
 * A PDF has no concept of a line, so most of this file is reconstructing one.
 * EXPLAINER §3.1–§3.5.
 */

import type { PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextRange {
    start: number;
    /** Exclusive. */
    end: number;
}

/** One pdf.js text item, cleaned up. Often a whole line under v6 — never assume it. */
export interface Run {
    text: string;
    /** Left edge, PDF points. Left-most, NOT logical-first. For Hebrew these differ. */
    x: number;
    /** Baseline, PDF points, from the bottom of the page. */
    y: number;
    width: number;
    height: number;
    /** pdf.js's own per-item call. */
    dir: "ltr" | "rtl";
    /** pdf.js style id (e.g. "g_d0_f2"). Diagnostics only, never layout. */
    fontId: string;
    /** Index into the original getTextContent().items array. */
    sourceIndex: number;
    /** Character ranges within `text` that failed the readability check. */
    suspectRanges: TextRange[];
}

export interface Line {
    /** LOGICAL order — runs[0] is what a reader sees first. */
    runs: Run[];
    /** Concatenation of runs in logical order. */
    text: string;
    /** Shared baseline. NOT the top of the line — see detect-field's lineBounds. */
    y: number;
    /** Extents in points, regardless of direction. */
    minX: number;
    maxX: number;
    dir: "ltr" | "rtl";
    hasSuspectText: boolean;
}

export interface ExtractedPage {
    pageNumber: number;
    /** Page size at scale 1, points. */
    width: number;
    height: number;
    lines: Line[];
    /** 'empty' = no text layer at all, i.e. a scanned page. */
    quality: "ok" | "empty";
    /** "clustered" means the hasEOL guard fired — see buildLines. */
    lineSource: "eol" | "clustered";
    letters: { latin: number; rtl: number };
}

interface BuiltLines {
    runGroups: Run[][];
    source: "eol" | "clustered";
}

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

/** Hebrew, Arabic, and friends. Strong RTL. */
const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Latin. Strong LTR. ⚠ Digits and punctuation absent on purpose — neutral. */
const STRONG_LTR = /[A-Za-z\u00C0-\u024F]/;

const STRONG_RTL_GLOBAL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const STRONG_LTR_GLOBAL = /[A-Za-z\u00C0-\u024F]/g;

/** Anything bigger than float noise counts as rotated. */
const ROTATION_EPSILON = 0.01;

/** Fallback clustering: share of a glyph's height that still counts as one line. */
const CLUSTER_TOLERANCE_RATIO = 0.5;

/** A group spanning more than this × its tallest glyph isn't one line. */
const MAX_LINE_SPAN_RATIO = 3;
/** Fall back to clustering only past this share of implausible groups. */
const MAX_IMPLAUSIBLE_LINE_SHARE = 0.25;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract one page.
 *
 * ⚠ CALL SITE MATTERS. Run this ONCE PER DOCUMENT AT LOAD, over every page —
 * never per render. doc.getPage(n) returns a CACHED proxy that PdfPage calls
 * cleanup() on, and cleanup() can free font data out from under an in-flight
 * getTextContent(). run-extraction.ts calls this in the one window where nothing
 * else holds a page proxy. EXPLAINER §7.4.
 *
 * ⚠ Scale 1 = PDF points. This must never accept the viewer's zoom; its output
 * feeds the store, and the store is zoom-independent.
 */
export async function extractPageText(
    page: PDFPageProxy,
    pageNumber: number,
): Promise<ExtractedPage> {
    const viewport = page.getViewport({ scale: 1 });

    const { items } = await page.getTextContent();
    const built = buildLines(items, pageNumber);
    const lines = sortIntoReadingOrder(built.runGroups.map(orderLine));

    return {
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        lines,
        lineSource: built.source,
        quality: lines.length > 0 ? "ok" : "empty",
        letters: countLetters(lines),
    };
}

// ---------------------------------------------------------------------------
// Line splitting
// ---------------------------------------------------------------------------

/**
 * Split the item stream into visual lines.
 *
 * pdf.js emits a zero-width item with str === "" carrying hasEOL at the end of
 * every line. Those items ARE the line breaks, and splitting on them beats
 * y-clustering for measured reasons — so there is no tolerance constant on this
 * path at all. EXPLAINER §3.1.
 *
 * ⚠⚠ TWO DIFFERENT EMPTY-ISH STRINGS, and the distinction is load-bearing.
 * `str === ""` is a delimiter and gets dropped. `str === " "` is REAL whitespace
 * printed on the page and MUST survive: a whitespace run followed by a large
 * positional gap is how a write-in blank is detected. Widening this filter to
 * `!str.trim()` looks tidier and silently deletes that signal.
 */
function splitIntoLines(items: (TextItem | TextMarkedContent)[]): Run[][] {
    const lines: Run[][] = [];
    let current: Run[] = [];

    items.forEach((item, index) => {
        // TextMarkedContent has no transform, so this guard must come first.
        if (!("transform" in item)) return;

        // Rotated text: on these documents it's the printer's margin stamp, worth
        // nothing to the model. Normal text is [9,0,0,9,x,y]; rotated is
        // [0,8.29,-8.29,0,x,y], so no heuristic is needed.
        //
        // ⚠ Dropped rather than flagged, which is a decision about THESE
        // documents — a rotated FIELD would matter. This is the line to revisit.
        if (isRotated(item.transform)) return;

        if (item.str !== "") current.push(toRun(item, index));

        if (item.hasEOL) {
            if (current.length > 0) lines.push(current);
            current = [];
        }
    });

    // Content after the last EOL, if the page doesn't end on one.
    if (current.length > 0) lines.push(current);

    return lines;
}

/**
 * The content stream is NOT in reading order — producers write one text frame at
 * a time, in creation order. y-descending fixes it; a stable sort keeps lines
 * sharing a baseline in stream order for free.
 *
 * ⚠ Frame grouping was tried and fails — don't re-attempt. Known limit:
 * two-column pages interleave. EXPLAINER §3.3.
 */
function sortIntoReadingOrder(lines: Line[]): Line[] {
    return [...lines].sort((a, b) => b.y - a.y);
}

function countLetters(lines: Line[]): { latin: number; rtl: number } {
    const text = lines.map((line) => line.text).join("");

    return {
        latin: (text.match(STRONG_LTR_GLOBAL) ?? []).length,
        rtl: (text.match(STRONG_RTL_GLOBAL) ?? []).length,
    };
}

function isRotated(transform: number[]): boolean {
    return (
        Math.abs(transform[1]) > ROTATION_EPSILON ||
        Math.abs(transform[2]) > ROTATION_EPSILON
    );
}

function toRun(item: TextItem, sourceIndex: number): Run {
    return {
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
        dir: item.dir === "rtl" ? "rtl" : "ltr",
        fontId: item.fontName,
        sourceIndex,
        suspectRanges: findSuspectRanges(item.str),
    };
}

// ---------------------------------------------------------------------------
// Reading order within a line
// ---------------------------------------------------------------------------

/**
 * Put one line's runs into logical order and record its direction.
 *
 * Raw pdf.js order is x-ascending, which for Hebrew is exactly backwards — a
 * table header arrives with its last column first. EXPLAINER §3.3.
 */
function orderLine(runs: Run[]): Line {
    const dir = lineDirection(runs);

    const ordered = [...runs].sort((a, b) => (dir === "rtl" ? b.x - a.x : a.x - b.x));

    return {
        runs: ordered,
        text: ordered.map((r) => r.text).join(""),
        y: runs[0].y,
        minX: Math.min(...runs.map((r) => r.x)),
        maxX: Math.max(...runs.map((r) => r.x + r.width)),
        dir,
        hasSuspectText: runs.some((r) => r.suspectRanges.length > 0),
    };
}

/**
 * A line is RTL if it contains ANY strong RTL character.
 *
 * ⚠⚠ NOT "the first strong character", which is the textbook rule and is what
 * editor/export.ts uses. The textbook rule needs the string already in logical
 * order, and logical order is what this function is being asked to produce —
 * circular. Export escapes the circle because by then the string IS in logical
 * order. The two rules answer different questions; don't unify them.
 * EXPLAINER §3.4.
 *
 * ⚠ Digits and punctuation count as neither: lines routinely start with a lone
 * space, a stray ".", or a date, and pdf.js calls all of them "ltr".
 *
 * Known limit: a mostly-English line with one Hebrew word comes out RTL. If that
 * starts occurring, count strong characters by class rather than testing presence.
 */
function lineDirection(runs: Run[]): "ltr" | "rtl" {
    const joined = runs.map((r) => r.text).join("");

    if (STRONG_RTL.test(joined)) return "rtl";
    if (STRONG_LTR.test(joined)) return "ltr";

    return runs[0]?.dir ?? "ltr";
}

// ---------------------------------------------------------------------------
// The hasEOL guard
// ---------------------------------------------------------------------------

/**
 * A line is text sharing a baseline, so measure that: a group's vertical spread
 * against its own tallest glyph.
 *
 * ⚠ An items-per-line ratio was tried first and is WRONG — do not restore it. It
 * measures how aggressively the producer merged runs, not whether splitting
 * worked, and false-positived on ordinary documents. EXPLAINER §3.2.
 *
 * The 9pt fallback guards zero-height whitespace items; dividing by zero would
 * condemn every line containing one.
 */
function isImplausibleLine(runs: Run[]): boolean {
    const ys = runs.map((r) => r.y);
    const span = Math.max(...ys) - Math.min(...ys);
    const tallest = Math.max(...runs.map((r) => r.height || 9), 1);

    return span > tallest * MAX_LINE_SPAN_RATIO;
}

/**
 * Split on hasEOL, and fall back to y-clustering only when the result is
 * implausible.
 *
 * ⚠ THE FAILURE THIS GUARDS AGAINST IS SILENT: a PDF from Word, LaTeX or a
 * scanner may emit no hasEOL at all, and then splitIntoLines returns ONE LINE PER
 * PAGE with no error — the payload becomes a few enormous strings and nothing
 * looks broken. On the fallback path text degrades slightly and PLACEMENT
 * DEGRADES BADLY, because merged lines have wildly wrong extents. If marks look
 * hundreds of points out on an unfamiliar PDF, check lineSource first.
 * EXPLAINER §3.2.
 */
function buildLines(
    items: (TextItem | TextMarkedContent)[],
    pageNumber: number,
): BuiltLines {
    const eolGroups = splitIntoLines(items);

    // Nothing on the page — blank or image-only. Not a failure, and clustering
    // would do nothing differently.
    if (eolGroups.length === 0) return { runGroups: [], source: "eol" };

    const implausible = eolGroups.filter(isImplausibleLine).length;
    const share = implausible / eolGroups.length;

    if (share <= MAX_IMPLAUSIBLE_LINE_SHARE) return { runGroups: eolGroups, source: "eol" };

    // The worst ratio distinguishes "the guard is working" (dozens) from "the
    // threshold needs looking at" (3 or 4), and costs one line to print.
    const worst = Math.max(
        ...eolGroups.map((runs) => {
            const ys = runs.map((r) => r.y);
            const tallest = Math.max(...runs.map((r) => r.height || 9), 1);
            return (Math.max(...ys) - Math.min(...ys)) / tallest;
        }),
    );

    console.warn(
        `[copilot] page ${pageNumber}: ${implausible} of ${eolGroups.length} lines ` +
        `span more than ${MAX_LINE_SPAN_RATIO}× their glyph height ` +
        `(worst ${worst.toFixed(1)}×). hasEOL markers look unreliable; ` +
        `rebuilding from baselines.`,
    );

    return { runGroups: clusterIntoLines(items), source: "clustered" };
}

function clusterIntoLines(items: (TextItem | TextMarkedContent)[]): Run[][] {
    const runs: Run[] = [];

    items.forEach((item, index) => {
        if (!("transform" in item)) return;
        if (isRotated(item.transform)) return;
        // ⚠ Same distinction as the primary path: "" is a delimiter, " " is real
        // whitespace and must survive.
        if (item.str === "") return;

        runs.push(toRun(item, index));
    });

    // Descending — PDF y grows upward, so this walks down the page.
    const byBaseline = [...runs].sort((a, b) => b.y - a.y);

    const lines: Run[][] = [];
    let current: Run[] = [];
    let baseline = Infinity;
    let tolerance = 0;

    for (const run of byBaseline) {
        if (current.length === 0 || Math.abs(run.y - baseline) > tolerance) {
            if (current.length > 0) lines.push(current);

            current = [run];
            baseline = run.y;
            // 9pt fallback: a zero tolerance would put every zero-height
            // whitespace item on its own line.
            tolerance = Math.max(run.height || 9, 1) * CLUSTER_TOLERANCE_RATIO;
            continue;
        }

        current.push(run);
    }

    if (current.length > 0) lines.push(current);

    return lines;
}

// ---------------------------------------------------------------------------
// Extraction quality
// ---------------------------------------------------------------------------

/**
 * Find character ranges whose text cannot be trusted — a partially-populated
 * ToUnicode table makes some glyphs extract as the wrong character. The offset
 * isn't consistent in sign, so no repair is possible; only disclosure.
 * EXPLAINER §3.5.
 *
 * ⚠ RANGES, NOT A BOOLEAN. pdf.js v6 merges runs, so corrupted Latin sits inside
 * otherwise-perfect Hebrew items. A per-run boolean would either condemn forty
 * good words to flag two bad ones, or clear the bad ones because the run is
 * mostly fine.
 *
 * ⚠ THE TOKENIZER MUST BE /[A-Za-z]+/g, NOT \b-ANCHORED. Corrupted text like
 * `il.co.iQs-harHl@1uQsubscribH` has no word boundary before `u` because a digit
 * precedes it, and the \b version silently finds one word fewer.
 *
 * ⚠ This rule CANNOT run on an English document — it flags SaaS, macOS, iPhone.
 * detect-field.ts gates it on the document's Latin share; this function is
 * unconditional and only reports evidence.
 *
 * Known misses, both accepted: uppercase-then-lowercase corruption is
 * indistinguishable from ordinary capitalisation, and mixed alphanumeric codes
 * carry no case pattern at all. A clean flag does not mean clean text.
 */
function findSuspectRanges(text: string): TextRange[] {
    const ranges: TextRange[] = [];

    for (const match of text.matchAll(/[A-Za-z]+/g)) {
        if (match.index === undefined) continue;
        if (!/[a-z][A-Z]/.test(match[0])) continue;

        ranges.push({ start: match.index, end: match.index + match[0].length });
    }

    return ranges;
}

/**
 * ⚠ DELIBERATELY ABSENT: a page-level "suspect" verdict.
 *
 * The useful question isn't "is this page suspect" but "is any text the copilot
 * RELIED ON suspect", and this file cannot answer that — it doesn't know which
 * lines get used. It reports evidence; detect-field.ts draws the conclusion.
 */