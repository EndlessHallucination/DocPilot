/**
 * copilot/run-extraction.ts
 *
 * Runs the three extraction stages once per document and hands back one object.
 * Exists so App doesn't have to know the ordering, the page loop or the failure
 * policy.
 *
 * ⚠⚠ WHERE THIS MUST BE CALLED: inside App.openFile, AFTER `await loadPdf(...)`
 * resolves and BEFORE `setPdf(...)`. Not in an effect, not in PdfPage, not on
 * demand. doc.getPage(n) returns a CACHED proxy; PdfPage calls cleanup() on it,
 * which frees parsed font data, and PdfTextLayer streams from the same object.
 * That window is the one moment nothing else holds a page proxy, so running there
 * needs no locks and no shared state. EXPLAINER §7.4.
 *
 * ⚠ FAILURE POLICY: NEVER THROW. Returning null means the copilot panel says it
 * can't read this document; it does NOT mean the file failed to open. "Editor
 * works, copilot doesn't" already falls out of the architecture — this file's job
 * is not to break that.
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
     * upgrade changing the operator-list shape. Fields are still all found; only
     * mark placement degrades to the calibrated fallback. EXPLAINER §4.7.
     */
    geometryOk: boolean;
    /**
     * False when no page produced any text: a scan or image-only PDF. The panel
     * must SAY this rather than render an empty list, or it reads as a bug rather
     * than a property of the file.
     */
    readable: boolean;
}

export async function runExtraction(
    doc: PDFDocumentProxy,
): Promise<Extraction | null> {
    try {
        // Geometry first, and it owns its own page loop — it needs every page before
        // it can derive the checkbox size, so there is nothing to gain from
        // interleaving. It never throws on its own; this catch is for getPage().
        const geometry = await extractDocumentGeometry(doc);

        // ⚠ Sequential, not Promise.all. Parallel getPage/getTextContent across
        // every page is exactly the contention this file exists to avoid, and on a
        // long document it spikes memory for no gain — pdf.js parses on one worker
        // regardless.
        const pages: ExtractedPage[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
            pages.push(await extractPageText(await doc.getPage(pageNumber), pageNumber));
        }

        // ⚠ No page.cleanup() here, on purpose. Ownership stays with PdfPage —
        // calling it from two places recreates the race this file avoids. Leaving
        // the parsed fonts cached also makes the first render faster.

        const result: Extraction = {
            pages,
            geometry,
            detection: detectFields(pages, geometry),
            geometryOk: geometry.ok,
            readable: pages.some((p) => p.quality === "ok"),
        };

        // ⚠ COPILOT_DEV, not import.meta.env.DEV — Vite strips the latter at compile
        // time, so in a built extension this call would simply not exist, which is
        // indistinguishable from smokeReport being broken. EXPLAINER §8.3.
        if (COPILOT_DEV) smokeReport(result);

        return result;
    } catch (error) {
        // Deliberately swallowed. A copilot that can't read the document is a
        // degraded feature; a viewer that won't open it is a broken product.
        console.warn("[copilot] extraction failed; editor unaffected:", error);
        return null;
    }
}