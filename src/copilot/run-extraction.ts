/**
 * copilot/run-extraction.ts
 *
 * Runs the three extraction stages once per document and hands back one
 * object. Exists so App doesn't have to know the ordering, the page loop, or
 * the failure policy.
 *
 * ─── WHERE THIS MUST BE CALLED ───────────────────────────────────────────
 * Inside App.openFile, AFTER `await loadPdf(...)` resolves and BEFORE
 * `setPdf(...)`. Not in an effect, not in PdfPage, not on demand.
 *
 * WHY: doc.getPage(n) returns a CACHED page proxy — every caller gets the
 * same object. PdfPage calls page.cleanup() on it once canvas render resolves,
 * which frees parsed font data. PdfTextLayer streams text from the same proxy.
 * This file is a third consumer, and cleanup() firing during an in-flight
 * getTextContent() reads freed data.
 *
 * The window between loadPdf() resolving and setPdf() is the one moment where
 * nothing else holds a page proxy, because PdfPage hasn't mounted yet. Running
 * here needs no locks, no shared state, and no coordination — which is the
 * property worth protecting. §6.9 warns that wanting to coordinate render
 * lifecycle through shared state means something else is wrong.
 *
 * ─── WHY ONCE PER DOCUMENT, NOT PER PAGE ─────────────────────────────────
 * The panel is the substitute for continuous scrolling (§6.12): it must list
 * fields on pages the user has never opened. Extraction driven by render would
 * fill the panel page by page as the user navigates, which defeats it.
 *
 * Geometry is document-level for a second reason: checkbox size is found by
 * repetition, and page 2 of the fixture has exactly ONE checkbox. In isolation
 * there is no mode to find; pooled with pages 1 and 3 it classifies correctly.
 *
 * ─── FAILURE POLICY: NEVER THROW ─────────────────────────────────────────
 * The editor never needed text. Canvas rendering works on a scan, and placing
 * a box is pure coordinate work. So "editor works, copilot doesn't" already
 * falls out of the architecture — this file's job is not to break that.
 * Returning null means the copilot panel says it can't read this document; it
 * does NOT mean the file failed to open.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractPageText, type ExtractedPage } from "./extract-text";
import { extractDocumentGeometry, type DocumentGeometry } from "./extract-geometry";
import { detectFields, type DetectionResult } from "./detect-field";
import { smokeReport } from "./smoke";
import { COPILOT_DEV } from "./dev";

export interface Extraction {
    pages: ExtractedPage[];
    geometry: DocumentGeometry;
    detection: DetectionResult;
    /**
     * False when geometry extraction failed wholesale — most likely a pdf.js
     * upgrade changing the operator-list shape (§8.5). Fields are still all
     * found; only mark placement degrades to the calibrated fallback.
     */
    geometryOk: boolean;
    /**
     * False when no page produced any text: a scanned or image-only PDF. The
     * panel must SAY this rather than render an empty list, or it reads as a
     * bug rather than a property of the file.
     */
    readable: boolean;
}

export async function runExtraction(
    doc: PDFDocumentProxy,
): Promise<Extraction | null> {
    try {
        // Geometry first, and it owns its own page loop — it needs every page
        // before it can derive the checkbox size, so there is nothing to gain
        // from interleaving. It never throws on its own; a catch here is for
        // getPage() itself failing.
        const geometry = await extractDocumentGeometry(doc);

        // Sequential, not Promise.all. Parallel getPage/getTextContent across
        // every page at once is exactly the contention this file exists to
        // avoid, and on a 50-page document it would spike memory for no gain —
        // pdf.js parses on one worker regardless.
        const pages: ExtractedPage[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
            pages.push(await extractPageText(await doc.getPage(pageNumber), pageNumber));
        }

        // NOTE: no page.cleanup() here on purpose. Ownership of cleanup() stays
        // with PdfPage (§6.9) — calling it from two places is how the race in
        // §8.6 gets recreated in a new form. Leaving the parsed fonts cached
        // also means the first render is faster, not slower.

        const result: Extraction = {
            pages,
            geometry,
            detection: detectFields(pages, geometry),
            geometryOk: geometry.ok,
            readable: pages.some((p) => p.quality === "ok"),
        };

        // ⚠ COPILOT_DEV, not import.meta.env.DEV. Vite strips the latter at
        // compile time, so in the unpacked build this call simply did not
        // exist — which is indistinguishable from smokeReport being broken,
        // and cost a session to work out (§8.38).
        if (COPILOT_DEV) smokeReport(result);

        return result;
    } catch (error) {
        // Deliberately swallowed. A copilot that can't read the document is a
        // degraded feature; a viewer that won't open the document is a broken
        // product. Never let the first become the second.
        console.warn("[copilot] extraction failed; editor unaffected:", error);
        return null;
    }
}