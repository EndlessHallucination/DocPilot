/**
 * viewer/pdf-setup.ts
 *
 * pdf.js worker and asset wiring, plus loadPdf().
 *
 * ⚠ THE THREE ASSET URLS ARE LOAD-BEARING FOR HEBREW. cmaps decode CID fonts;
 * get the path wrong and Hebrew text extracts as garbage or not at all — which
 * looks like an extraction bug rather than a 404. If §7.2's line counts ever
 * come back zero after a build change, check the network tab before the code.
 *
 * They go through assetUrl() rather than chrome.runtime.getURL() so the same
 * source builds as an extension and as a static site.
 */

import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { assetUrl } from '../copilot/storage'

// ?worker is a Vite feature, not an extension one — this line needs no change
// between builds.
pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker()

// vite-plugin-static-copy puts these under pdfjs/ in the output directory for
// both builds, so the path is identical and only the origin differs.
const CMAP_URL = assetUrl('pdfjs/cmaps/')
const STANDARD_FONT_URL = assetUrl('pdfjs/standard_fonts/')
const WASM_URL = assetUrl('pdfjs/wasm/')

export interface LoadedPdf {
    doc: PDFDocumentProxy
    originalBytes: Uint8Array
    name: string
}

export async function loadPdf(bytes: Uint8Array, name: string): Promise<LoadedPdf> {
    const originalBytes = bytes.slice()

    const doc = await pdfjs.getDocument({
        data: bytes,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONT_URL,
        wasmUrl: WASM_URL,
    }).promise

    return { doc, originalBytes, name }
}