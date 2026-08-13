/**
 *
 * Turns a pdf.js page into ordered lines of text in LOGICAL order, in PDF
 * points (origin bottom-left) — the same space state/annotations.ts stores in.
 *
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
    /** Character ranges within `text` that failed the readability check (§6.7). */
    suspectRanges: TextRange[];
}

export interface Line {
    /** LOGICAL order — runs[0] is what a reader sees first. */
    runs: Run[];
    /** Concatenation of runs in logical order. */
    text: string;
    /** Shared baseline. */
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
    /**
     * 'empty' = no text layer at all, i.e. a scanned page.
     */
    quality: "ok" | "empty";
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
/** Latin. Strong LTR. Digits and punctuation are deliberately absent — they're neutral. */
const STRONG_LTR = /[A-Za-z\u00C0-\u024F]/;

/** Anything bigger than float noise counts as rotated. */
const ROTATION_EPSILON = 0.01;



const CLUSTER_TOLERANCE_RATIO = 0.5;


const STRONG_RTL_GLOBAL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const STRONG_LTR_GLOBAL = /[A-Za-z\u00C0-\u024F]/g;

const MAX_LINE_SPAN_RATIO = 3;
const MAX_IMPLAUSIBLE_LINE_SHARE = 0.25;


// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract one page.
 *
 * CALL SITE MATTERS — read before wiring.
 *
 * Run this ONCE PER DOCUMENT AT LOAD, over every page. Not per render.
 * App renders one page at a time (§6.15), but the copilot panel is the
 * substitute for scrolling and must list fields on pages the user has never
 * opened. Extraction driven by PdfPage would fill the panel page by page as
 * the user navigates, which defeats the point of having a panel.
 *
 * THE HAZARD: doc.getPage(n) returns a CACHED proxy. PdfPage already calls
 * page.cleanup() on it after canvas render resolves, and PdfTextLayer streams
 * text from it separately. That was two consumers and one owner of cleanup
 * (§6.14); this makes three, and cleanup() can free font data out from under
 * an in-flight getTextContent().
 *
 * The cheapest fix is to run extraction before the first PdfPage mounts —
 * App already awaits loadPdf() before setting state, so there is a window
 * where nothing else holds a page proxy. Doing it there costs no new state
 * anywhere, which is the property to preserve: §6.14 warns that wanting to
 * coordinate render lifecycle through shared state is a signal something else
 * is wrong.
 */
export async function extractPageText(
    page: PDFPageProxy,
    pageNumber: number,
): Promise<ExtractedPage> {
    // Scale 1 = PDF points. This function must never accept the viewer's zoom;
    // its output feeds the store, and the store is zoom-independent (§6.9).
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
 * WHY hasEOL AND NOT y-CLUSTERING — this was measured, not assumed.
 *
 * pdf.js emits a zero-width item with str === "" carrying hasEOL at the end of
 * every line: 50 / 47 / 23 of them across the three pages, and they account for
 * every hasEOL in the document bar one (the two-line title, which ends on real
 * text). They ARE the line breaks. Filtering them out before grouping throws
 * away the line structure and forces you to rebuild it from geometry.
 *
 * Rebuilding it from geometry is strictly worse here:
 *   - Superscripts sit ~3pt off the baseline (`*תשומת לבך` and the `; קוד`
 *     line both do). Any tolerance tight enough to keep adjacent table cells
 *     apart splits those; the content stream keeps them together correctly.
 *   - On page 2 the rotated margin word סטודיו shares a baseline with the
 *     שליחת דבר פרסומת heading. Geometry cannot separate unrelated content
 *     that happens to land on the same y. The stream can.
 *
 * So: split on hasEOL, drop the empty delimiters, and there is no tolerance
 * constant anywhere in this file.
 *
 * NOTE the two different empty-ish strings, because the filter below turns on
 * the distinction. `str === ""` is a line break and gets dropped. `str === " "`
 * is a run of real whitespace on the page and MUST survive: every blank on
 * this form is a whitespace run followed by a large positional gap, and that
 * is the entire input to detect-blanks.ts. Widening this filter to
 * `!str.trim()` would silently delete Phase 2's only signal.
 */
function splitIntoLines(items: (TextItem | TextMarkedContent)[]): Run[][] {
    const lines: Run[][] = [];
    let current: Run[] = [];

    items.forEach((item, index) => {
        // TextMarkedContent has no transform. The fixture produces none, so a
        // wrong guard passes here and throws on the first document that has any.
        if (!("transform" in item)) return;

        // Rotated text: the vertical margin stamp (הראל / סטודיו / 51305.7 /
        // 03/2026) on every page. Normal text has transform [9,0,0,9,x,y];
        // rotated has [0,8.29,-8.29,0,x,y]. No heuristic needed.
        //
        // Dropped rather than flagged because on this document it's the print
        // ID stamp and worth nothing to the model. That is a decision about
        // THIS fixture: a rotated *field* would matter, and §7.2 notes vertical
        // margin text extracts fine. If a rotated form field ever shows up,
        // this is the line to revisit.
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
// Reading order
// ---------------------------------------------------------------------------

/**
 * Put one line's runs into logical order and record its direction.
 *
 * Raw pdf.js order is x-ascending, which for Hebrew is exactly backwards. The
 * עמית table header arrives as
 *     [תאריך לידה] [מס' הזהות] [שם פרטי] [שם משפחה]
 * and reads
 *     [שם משפחה] [שם פרטי] [מס' הזהות] [תאריך לידה]
 * Confirmed on both v4 and v6.
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
function isImplausibleLine(runs: Run[]): boolean {
    const ys = runs.map((r) => r.y);
    const span = Math.max(...ys) - Math.min(...ys);

    // 9pt fallback: some producers emit zero-height whitespace items, and
    // dividing by zero would condemn every line containing one.
    const tallest = Math.max(...runs.map((r) => r.height || 9), 1);

    return span > tallest * MAX_LINE_SPAN_RATIO;
}

function buildLines(
    items: (TextItem | TextMarkedContent)[],
    pageNumber: number,
): BuiltLines {
    const eolGroups = splitIntoLines(items);

    // Nothing on the page — blank, or image-only. Not a failure, and there is
    // nothing for clustering to do differently.
    if (eolGroups.length === 0) return { runGroups: [], source: "eol" };

    const implausible = eolGroups.filter(isImplausibleLine).length;
    const share = implausible / eolGroups.length;

    if (share <= MAX_IMPLAUSIBLE_LINE_SHARE) return { runGroups: eolGroups, source: "eol" };

    // Worst offender in the message: a document with no hasEOL at all shows a
    // ratio in the dozens, while a marginal case shows 3 or 4. That number is
    // the difference between "the guard is working" and "the threshold needs
    // looking at", and it costs one line to print.
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
        // Same distinction as the primary path: "" is a delimiter and is
        // dropped, " " is real whitespace on the page and must survive,
        // because a whitespace run followed by a large gap IS a blank (§8.8).
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
            // Fall back to 9pt when height is missing or zero — some producers
            // emit height 0 for whitespace-only items, and a zero tolerance
            // would put every one of them on its own line.
            tolerance = Math.max(run.height || 9, 1) * CLUSTER_TOLERANCE_RATIO;
            continue;
        }

        current.push(run);
    }

    if (current.length > 0) lines.push(current);

    return lines;
}
/**
 * A line is RTL if it contains any strong RTL character; otherwise LTR if it
 * contains any strong LTR one; otherwise fall back to pdf.js's own call.
 *
 * WHY THIS ISN'T "the first strong character", which is the textbook rule and
 * is what editor/export.ts uses (§6.2): the textbook rule needs the string in
 * logical order, and logical order is what this function is being asked to
 * produce. Circular. Export escapes the circle because by then the string
 * already exists in logical order — that's why the two rules differ, and why
 * they must not be "unified" without noticing they answer different questions.
 *
 * Digits and punctuation are excluded from both classes on purpose. Lines here
 * routinely start with a lone space, a stray ".", or the digits of a date, and
 * pdf.js reports dir "ltr" for all of them. None is evidence about the line.
 *
 * KNOWN LIMIT: a predominantly English line containing one Hebrew word comes
 * out RTL. It doesn't occur on this document. If it starts occurring, count
 * strong characters by class rather than testing for presence.
 */
function lineDirection(runs: Run[]): "ltr" | "rtl" {
    const joined = runs.map((r) => r.text).join("");

    if (STRONG_RTL.test(joined)) return "rtl";
    if (STRONG_LTR.test(joined)) return "ltr";

    return runs[0]?.dir ?? "ltr";
}

// ---------------------------------------------------------------------------
// Extraction quality (§6.7)
// ---------------------------------------------------------------------------

/**
 * Find character ranges whose text cannot be trusted.
 *
 * Measured, not assumed:
 *   - Every Hebrew character in this document extracts correctly, all 3 pages.
 *   - Only Latin is ever corrupted. Six words, all on page 2.
 *   - NOT per-font. g_d0_f2 gives 44 clean Hebrew runs and 3 broken Latin ones.
 *     g_d0_f1 gives "HSBC" correctly and "Qo" (truly "QR") wrongly — same font,
 *     same page. A partially-populated ToUnicode table.
 *   - The offset isn't consistent in sign: p→S is −29, R→o is +29. No repair is
 *     possible. Only disclosure.
 *
 * RANGES, NOT A BOOLEAN, and that's the v6 change: because v6 merges runs,
 * corrupted Latin now lives inside otherwise-perfect Hebrew items. Page 2 emits
 * `; קוד Qo:` as ONE item, and the bank line arrives as a full clean Hebrew
 * sentence with `HSBC` inside it. A per-run boolean would either condemn forty
 * good Hebrew words to flag two bad Latin ones, or clear the bad ones because
 * the run is mostly fine.
 *
 * THE RULE: an uppercase letter immediately after a lowercase one, inside a
 * single alphabetic word. Verified against every Latin word in the document —
 * flags httSs, harHl, grouS, uQsubscribH, iQs; passes HSBC, mfax, harel, ins,
 * www, co, il. Zero false positives, which is the number that matters: HSBC
 * sits in the bank-details section, the one place on this form where a wrong
 * value costs the user money.
 *
 * KNOWN MISSES, both acceptable and both worth knowing before demo day:
 *   - "Qo" (truly "QR") — uppercase-then-lowercase, which is also what every
 *     legitimately capitalised word looks like. Catching it means flagging
 *     "Harel". Two characters, a QR-code label, no financial meaning.
 *   - The short-link codes X69C7B and 408YB6 are corrupted (they should read
 *     XSVCTB and 4Q8YB6) but carry no case pattern to detect. Mixed
 *     alphanumeric codes are undetectable in principle here — worth saying out
 *     loud rather than trusting a clean flag to mean clean text.
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
 * DELIBERATELY ABSENT: a page-level "suspect" verdict.
 *
 * On this document the corruption is entirely in the fine print, while the
 * field labels — the only text blank detection reads — are clean. A page-level
 * flag would make the copilot disclaim a page it read perfectly well, which
 * demos worse than saying nothing.
 *
 * The question worth answering isn't "is this page suspect" but "is any text
 * the copilot RELIED ON suspect", and this file can't answer that because it
 * doesn't know which lines get used. It reports evidence; detect-blanks.ts
 * draws the conclusion.
 */