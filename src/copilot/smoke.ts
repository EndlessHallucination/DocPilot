/**
 * copilot/smoke.ts
 *
 * Open any PDF, read six numbers, know in ten seconds whether extraction
 * worked. Dev-only. Never imported by production code paths.
 *
 * ─── WHY THIS EXISTS ALONGSIDE verify.ts ─────────────────────────────────
 * verify.ts asserts hardcoded counts against the Harel fixture and is gated on
 * the filename, so on every OTHER document it is silent — which is exactly when
 * you most need to know what extraction concluded. This is its generic cousin:
 * no assertions, no expected values, no per-document baseline. It prints what
 * the pipeline decided and lets a human read it.
 *
 * The distinction matters when editing. If you find yourself adding an expected
 * number here, it belongs in verify.ts instead. Every value printed below is
 * derived from the document being opened, and this file must stay meaningful on
 * a document nobody has ever seen.
 *
 * ─── NOTHING HERE IS NEW DETECTION ───────────────────────────────────────
 * Every number is already computed by extract-text.ts, extract-geometry.ts or
 * detect-field.ts. This file only surfaces it. That is deliberate: a report
 * that measured things itself could disagree with the pipeline, and then you'd
 * be debugging the report. If a signal you want isn't here, expose it upstream
 * and read it — don't recompute it.
 *
 * ─── THE MARK-SOURCE HISTOGRAM IS THE POINT ──────────────────────────────
 * `literalBlanks` and `hasWideGap` both emit kind: "writeIn", so the panel
 * badge cannot tell them apart, and no panel observation ever will. That is why
 * §8.20 could not be closed by looking at the W-9: line 3b (nine dots, matches
 * the literal pattern) and the LLC line above it (four dots, doesn't match, but
 * has a genuine gap-blank for the C/S/P classification letter) BOTH show
 * writeIn, and both are correct. FieldGeometry.source records which detector
 * actually ran, and the histogram below is where you read it.
 */

import type { Extraction } from "./run-extraction";
import type { ExtractedPage } from "./extract-text";
import type { MarkSource } from "./detect-field";

/** How many lines of head and tail to print per page for the reading-order eyeball. */
const SAMPLE_LINES = 3;

/** Line text is truncated to this before printing, so one long line can't eat the console. */
const SAMPLE_WIDTH = 64;

/** Mirrors detect-field.ts's gate, for display only. Never used to decide anything. */
const LATIN_GATE = 0.15;

export function smokeReport(extraction: Extraction): void {
    const { pages, geometry, detection, geometryOk, readable } = extraction;

    console.groupCollapsed(
        `[smoke] ${pages.length} page(s) · ${countLines(pages)} lines · ` +
        `${detection.payload.filter((l) => l.fields).length} tagged`,
    );

    printPageTable(extraction);
    printMarkSources(extraction);
    printDocumentFacts(extraction);
    printReadingOrderSample(pages);
    printWarnings(extraction);

    // Kept last and always printed: the object is the escape hatch when a
    // number below looks wrong and you want to poke at it in the console
    // rather than add another line to this file.
    console.log("extraction:", { pages, geometry, detection, geometryOk, readable });

    console.groupEnd();
}

// ---------------------------------------------------------------------------
// Per-page table
// ---------------------------------------------------------------------------

/**
 * One row per page. Read it top to bottom in this order:
 *
 *   lines = 1        line splitting collapsed the page into one string (§8.15)
 *   tagged = 0       geometry found nothing on a form that clearly has fields
 *   source           "clustered" means the hasEOL guard fired — see §8.15
 *   quality          "empty" means a scan; the copilot is correctly off
 *   latin%           which side of the 15% corruption gate this page sits on
 *   boxes/combs/rules  raw shape counts, before any line matching
 *
 * `tagged` counts payload LINES carrying at least one field; `fields` counts
 * the fields themselves. They differ whenever a line carries several (§8.12),
 * and the gap between them is the quickest signal that multi-field lines exist
 * on this document at all.
 */
function printPageTable(extraction: Extraction): void {
    const rows = extraction.pages.map((page) => {
        const shapes = extraction.geometry.pages.find(
            (p) => p.pageNumber === page.pageNumber,
        );

        const onThisPage = extraction.detection.payload.filter(
            (l) => l.page === page.pageNumber,
        );

        return {
            page: page.pageNumber,
            lines: page.lines.length,
            tagged: onThisPage.filter((l) => l.fields).length,
            fields: onThisPage.reduce((n, l) => n + (l.fields?.length ?? 0), 0),
            unreliable: onThisPage.filter((l) => l.unreliableText).length,
            source: page.lineSource,
            quality: page.quality,
            "latin%": formatShare(latinShare(page)),
            boxes: shapes?.checkboxes.length ?? 0,
            combs: shapes?.combs.length ?? 0,
            rules: shapes?.leaders.length ?? 0,
        };
    });

    console.table(rows);
}

// ---------------------------------------------------------------------------
// Mark sources
// ---------------------------------------------------------------------------

/**
 * Which detector placed each mark.
 *
 * Split into two counts on purpose. TAGGED entries are keyed by field ref
 * (p1l3f0) and represent a real detection. FALLBACK entries are keyed by line
 * id (p1l3) and exist for EVERY line — detect-field.ts writes one
 * unconditionally so that a line the model calls a field, but where no shape
 * was drawn, still has somewhere to put a mark (§8.10, the התחלתי לעבוד
 * clause). Pooling them would bury the interesting counts under one number
 * equal to the line count.
 *
 * What to look for:
 *   literal > 0     §8.20 closed — literalBlanks fired on a real document
 *   gap  >> others  the document's blanks are positional, like Harel
 *   leader > 0      dashed rules present
 *   checkbox = 0 with boxes > 0 in the table above
 *                   shapes were found but none matched a line — §8.9's
 *                   matching is failing, not the geometry
 */
function printMarkSources(extraction: Extraction): void {
    const refs = new Set<string>();
    for (const line of extraction.detection.payload) {
        for (const field of line.fields ?? []) refs.add(field.ref);
    }

    const tagged = new Map<MarkSource, number>();
    let fallback = 0;

    for (const [key, entry] of extraction.detection.geometry) {
        if (refs.has(key)) tagged.set(entry.source, (tagged.get(entry.source) ?? 0) + 1);
        else fallback++;
    }

    console.log(
        "mark sources (tagged):",
        tagged.size === 0 ? "none — nothing detected anywhere" : Object.fromEntries(tagged),
    );
    console.log(`mark sources (per-line fallback): ${fallback}`);
}

// ---------------------------------------------------------------------------
// Document-level facts
// ---------------------------------------------------------------------------

/**
 * The things that are decided once for the whole document rather than per page.
 *
 * checkboxSize is null whenever no size repeated at least three times, which is
 * CORRECT behaviour on a form with one or two boxes, not a failure (§8.7). The
 * occurrence count beside it is the number of shapes that ended up matching
 * that size — if it is barely above three, the mode is weak and placement on
 * this document is worth eyeballing.
 *
 * markOffset is the calibrated distance from a line's text edge to its
 * checkbox. Harel measures 2.44–2.75. A value in the tens means calibration
 * latched onto something that isn't a checkbox, and every fallback mark on the
 * document will be that far out.
 */
function printDocumentFacts(extraction: Extraction): void {
    const { geometry, detection, geometryOk, readable } = extraction;

    const boxes = geometry.pages.reduce((n, p) => n + p.checkboxes.length, 0);
    const latin = extraction.pages.reduce((n, p) => n + p.letters.latin, 0);
    const rtl = extraction.pages.reduce((n, p) => n + p.letters.rtl, 0);

    console.log("checkbox size:", geometry.checkboxSize === null
        ? "null — no size repeated 3+ times, marks use the default"
        : `${geometry.checkboxSize.toFixed(1)}pt × ${boxes} matched`);

    console.log(`mark offset: ${detection.markOffset.toFixed(2)}pt (calibrated)`);

    console.log(
        `corruption check: ${detection.corruptionCheckApplied ? "APPLIED" : "suppressed"} ` +
        `· latin ${formatShare(latin / Math.max(latin + rtl, 1))} of letters ` +
        `(gate ${formatShare(LATIN_GATE)})`,
    );

    console.log(`geometryOk: ${geometryOk} · readable: ${readable}`);
}

// ---------------------------------------------------------------------------
// Reading order
// ---------------------------------------------------------------------------

/**
 * First and last few lines of each page, in the order the model will see them.
 *
 * This is an eyeball check, not a test — but it is the one that catches the
 * failures no count can. §8.14's block shuffling (א → ג → ב) and §8.21's
 * two-column interleaving on W-9 page 1 are both visible here in about two
 * seconds, and neither changes a single number in the table above.
 *
 * Whitespace is collapsed for display only. Do NOT collapse it upstream: a
 * whitespace run followed by a large gap IS a blank, and it is the entire input
 * to hasWideGap (§8.1).
 */
function printReadingOrderSample(pages: ExtractedPage[]): void {
    for (const page of pages) {
        if (page.lines.length === 0) {
            console.log(`page ${page.pageNumber}: no lines`);
            continue;
        }

        const head = page.lines.slice(0, SAMPLE_LINES);
        const tail = page.lines.slice(-SAMPLE_LINES);
        const elided = page.lines.length - head.length - tail.length;

        console.groupCollapsed(`page ${page.pageNumber} reading order`);
        head.forEach((line, i) => console.log(`  ${i}: ${sample(line.text)}`));
        if (elided > 0) console.log(`  … ${elided} more …`);
        tail.forEach((line, i) =>
            console.log(`  ${page.lines.length - tail.length + i}: ${sample(line.text)}`),
        );
        console.groupEnd();
    }
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Only prints when something is actually off, so a silent block means a clean
 * document. Each entry names the section that explains it, because the useful
 * next step is almost always reading that section rather than changing code
 * (§13.5).
 */
function printWarnings(extraction: Extraction): void {
    const { pages, geometry, detection, geometryOk, readable } = extraction;
    const warnings: string[] = [];

    for (const page of pages) {
        if (page.quality === "ok" && page.lines.length <= 1) {
            warnings.push(
                `page ${page.pageNumber}: ${page.lines.length} line(s) — line splitting ` +
                `collapsed the page. §8.15`,
            );
        }

        if (page.lineSource === "clustered") {
            warnings.push(
                `page ${page.pageNumber}: lineSource "clustered" — the hasEOL guard FIRED. ` +
                `This has never happened on a real document. Record the producer. §8.15`,
            );
        }

        if (page.quality === "empty") {
            warnings.push(
                `page ${page.pageNumber}: no text layer — scan or image-only. Copilot off ` +
                `is correct behaviour here. §6.12`,
            );
        }
    }

    if (readable && detection.payload.every((l) => !l.fields)) {
        warnings.push(
            "nothing tagged on any page. If this form visibly has fields, it is a third " +
            "form idiom, not a bug — record it. §8.17",
        );
    }

    if (geometry.checkboxSize === null && geometry.pages.some((p) => p.combs.length > 0)) {
        warnings.push(
            "no confident checkbox size, but combs were found — geometry works, the " +
            "document just has fewer than 3 boxes. §8.7",
        );
    }

    if (!geometryOk) {
        warnings.push(
            "geometryOk false — extraction threw. Most likely a pdf.js upgrade changing " +
            "the operator-list shape. Placement degrades; discovery does not. §8.5",
        );
    }

    if (warnings.length === 0) return;

    console.group("warnings");
    warnings.forEach((w) => console.warn(w));
    console.groupEnd();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function countLines(pages: ExtractedPage[]): number {
    return pages.reduce((n, p) => n + p.lines.length, 0);
}

function latinShare(page: ExtractedPage): number {
    const total = page.letters.latin + page.letters.rtl;
    return total === 0 ? 0 : page.letters.latin / total;
}

function formatShare(share: number): string {
    return `${(share * 100).toFixed(1)}%`;
}

function sample(text: string): string {
    const collapsed = text.replace(/\s+/g, " ").trim();

    return collapsed.length <= SAMPLE_WIDTH
        ? collapsed
        : `${collapsed.slice(0, SAMPLE_WIDTH - 1)}…`;
}