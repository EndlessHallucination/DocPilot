/**
 * Annotation data model. PURE DATA — no imports, no DOM, no pdfjs.
 * Safe to import from the background worker and from viewer code alike.
 *
 * All geometry is in PDF POINTS (72/inch), origin BOTTOM-LEFT, y increasing
 * UPWARD — matching what pdf-lib expects at export. Conversion to screen
 * pixels happens only at render time, in viewer/coordinates.ts.
 *
 * Text is stored in LOGICAL order (as typed). Visual reordering happens only
 * at export. See plan section 14.3.
 */

/** Bottom-left origin, PDF points. */
export interface PdfRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Top-left origin, CSS pixels — for positioning DOM elements. */
export interface CssRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface AnnotationBase {
    id: string;
    /** 1-indexed, matching pdf.js. */
    page: number;
    rect: PdfRect;
}

export interface TextAnnotation extends AnnotationBase {
    kind: "text";
    /** Logical order, exactly as typed. Never visual order. */
    text: string;
    /** Points, not pixels. */
    fontSize: number;
}

export interface SignatureAnnotation extends AnnotationBase {
    kind: "signature";
    /** Data URL of the drawn signature. */
    imageDataUrl: string;
}

export interface SymbolAnnotation extends AnnotationBase {
    kind: "symbol";
    symbol: "check" | "cross" | "dot";
}

export type Annotation = TextAnnotation | SignatureAnnotation | SymbolAnnotation;

// Stored as a flat array; filter by page at render time.
// Record<page, Annotation[]> would save a filter but costs bucket
// bookkeeping, and export, undo, and the copilot's cross-page list all
// want the flat shape anyway.