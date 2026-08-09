import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'


pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker()

const CMAP_URL = chrome.runtime.getURL('pdfjs/cmaps/')
const STANDARD_FONT_URL = chrome.runtime.getURL('pdfjs/standard_fonts/')
const WASM_URL = chrome.runtime.getURL('pdfjs/wasm/')

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