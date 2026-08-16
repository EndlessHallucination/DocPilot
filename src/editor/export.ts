/**
 * Flatten annotations into a real, downloadable PDF. The only place pdf-lib
 * is used, and the only place text is converted from logical to visual order.
 *
 * Runs entirely client-side — the document never leaves the browser (§8).
 *
 * Iterates `annotations` in array order, which is z-order (later = on top),
 * matching what the editor showed. Don't sort.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";
import type {
    Annotation,
    TextAnnotation,
    SymbolAnnotation,
    SignatureAnnotation,
} from "../state/annotations";
import { assetUrl } from "../copilot/storage";
const bidi = bidiFactory();

/** Logical order (as typed) -> visual order (as drawn). */
const toVisualOrder = (text: string) =>
    bidi.getReorderedString(text, bidi.getEmbeddingLevels(text));

/**
 * DO NOT REMOVE. pdf-lib delegates glyph layout to fontkit, which reverses
 * RTL strings naively — reversing digits and Latin runs along with the
 * Hebrew. We already ordered the string correctly with bidi-js above, so
 * fontkit must be told not to reorder again. Without this, account numbers
 * silently export backwards and nobody notices.
 */
const ltrFontkit = {
    create(bytes: Uint8Array, postscriptName?: string) {
        const font = fontkit.create(bytes, postscriptName);

        // The published types declare layout(str, features?) — the real
        // fontkit takes (str, features, script, language, direction), and
        // that last argument is the entire point of this patch (§14.3).
        const originalLayout = font.layout.bind(font) as (
            str: string,
            features?: unknown,
            script?: string,
            language?: string,
            direction?: string,
        ) => unknown;

        font.layout = ((
            str: string,
            features?: unknown,
            script?: string,
            language?: string,
            direction?: string,
        ) =>
            originalLayout(
                str,
                features,
                script,
                language,
                direction || "ltr",
            )) as typeof font.layout;

        return font;
    },
};

/** Must match LINE_HEIGHT in TextAnnotation, or exported lines drift apart. */
const LINE_HEIGHT = 1.2;
const SYMBOL_PATHS: Record<Exclude<SymbolAnnotation["symbol"], "dot">, string> = {
    check: "M 20 52 L 42 74 L 80 26",
    cross: "M 24 24 L 76 76 M 76 24 L 24 76",
};
const SYMBOL_STROKE = 12;
const FONT_URL = "fonts/NotoSansHebrew-Regular.ttf";

async function loadFontBytes(): Promise<ArrayBuffer> {
    const url = assetUrl(FONT_URL);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load export font (${response.status})`);
    }
    return response.arrayBuffer();
}

function isRtl(text: string): boolean {
    for (const char of text) {
        if (/\p{Script=Hebrew}|\p{Script=Arabic}/u.test(char)) return true;
        if (/\p{Script=Latin}/u.test(char)) return false;
    }
    return false;
}

function drawTextAnnotation(
    page: PDFPage,
    annotation: TextAnnotation,
    font: PDFFont,
) {
    const { rect, fontSize } = annotation;
    const lines = annotation.text.split("\n");

    // pdf-lib's y is the BASELINE, rect.y is the box BOTTOM. Work downward
    // from the top edge — the first line's baseline sits near the top.
    const ascent = font.heightAtSize(fontSize, { descender: false });
    let y = rect.y + rect.height - ascent;

    for (const line of lines) {
        const visual = toVisualOrder(line);

        // dir="auto" right-aligns RTL text in the editor; drawText always
        // starts at x and runs right. Mirror the editor by starting from the
        // box's right edge instead.
        const width = font.widthOfTextAtSize(visual, fontSize);
        const x = isRtl(line) ? rect.x + rect.width - width : rect.x;

        page.drawText(visual, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
        y -= fontSize * LINE_HEIGHT;
    }
}

function drawSymbolAnnotation(page: PDFPage, annotation: SymbolAnnotation) {
    const { rect, symbol } = annotation;

    if (symbol === "dot") {
        // Radius 30 in a 0-100 box, matching the SVG's <circle r="30">.
        page.drawCircle({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            size: (rect.width * 30) / 100,
            color: rgb(0, 0, 0),
        });
        return;
    }

    // drawSvgPath anchors at the path's TOP-LEFT and treats SVG y as growing
    // downward — so the anchor is the box's TOP edge and pdf-lib handles the
    // flip. Passing rect.y draws it a full box-height too low.
    page.drawSvgPath(SYMBOL_PATHS[symbol], {
        x: rect.x,
        y: rect.y + rect.height,
        scale: rect.width / 100,
        borderColor: rgb(0, 0, 0),
        borderWidth: SYMBOL_STROKE,
        borderLineCap: 1, // round, matching strokeLinecap="round"
    });
}
/** Async because embedPng is — the other draw functions are pure sync. */
async function drawSignatureAnnotation(
    pdfDoc: PDFDocument,
    page: PDFPage,
    annotation: SignatureAnnotation,
) {
    // embedPng accepts the data URL directly.
    const png = await pdfDoc.embedPng(annotation.imageDataUrl);

    // drawImage anchors BOTTOM-LEFT, the same convention as PdfRect — so
    // unlike text and symbols there's no flip here.
    page.drawImage(png, {
        x: annotation.rect.x,
        y: annotation.rect.y,
        width: annotation.rect.width,
        height: annotation.rect.height,
    });
}

export async function exportPdf(
    originalBytes: Uint8Array,
    annotations: Annotation[],
): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.load(originalBytes);
    pdfDoc.registerFontkit(ltrFontkit);

    // Once for the whole document. Per-annotation embedding adds a font
    // program on every call — N copies, several MB.
    const font = await pdfDoc.embedFont(await loadFontBytes(), { subset: true });

    const pages = pdfDoc.getPages();

    for (const annotation of annotations) {
        // Annotations are 1-indexed (pdf.js); getPages() is 0-indexed.
        const page = pages[annotation.page - 1];
        if (!page) continue;

        switch (annotation.kind) {
            case "text":
                drawTextAnnotation(page, annotation, font);
                break;
            case "signature":
                await drawSignatureAnnotation(pdfDoc, page, annotation);
                break;
            case "symbol":
                drawSymbolAnnotation(page, annotation);
                break;
        }
    }

    return pdfDoc.save();
}

export function downloadPdf(bytes: Uint8Array, filename: string) {
    const blob = new Blob([bytes.buffer as ArrayBuffer], {
        type: "application/pdf",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Without this the blob is held for the lifetime of the tab.
    URL.revokeObjectURL(url);
}