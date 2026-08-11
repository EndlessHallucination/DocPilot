/**
 * The ONLY place PDF points and CSS pixels are converted.
 *
 * PDF:  origin bottom-left, y increases UPWARD,   unit = points (72/inch)
 * CSS:  origin top-left,    y increases DOWNWARD, unit = pixels at zoom
 *
 * Always pass the CSS-space viewport — page.getViewport({ scale }) — NOT the
 * canvas one built at scale * devicePixelRatio. Annotations are DOM elements;
 * the dpr trick applies to the canvas backing store only.
 */

import type { PageViewport } from "pdfjs-dist";
import type { CssRect, PdfRect } from "../state/annotations";

/**
 * Where the user clicked (CSS px, relative to the page wrapper) -> PDF point.
 * Use when placing a new annotation.
 */
export function cssPointToPdf(
    viewport: PageViewport,
    left: number,
    top: number,
): { x: number; y: number } {
    const [x, y] = viewport.convertToPdfPoint(left, top);

    return { x, y };
}
export const cssLengthToPdf = (viewport: PageViewport, length: number): number =>
    length / viewport.scale;
/**
 * Stored annotation rect -> where to position the DOM element.
 *
 * THE TRAP: rect.y is the BOTTOM edge (PDF convention, what pdf-lib wants).
 * CSS needs the TOP edge. So the point to convert is (rect.x, rect.y + height)
 * — the top-left corner in PDF space. Converting (rect.x, rect.y) puts every
 * annotation exactly one box-height too low.
 */
export function pdfRectToCss(viewport: PageViewport, rect: PdfRect): CssRect {
    const [left, top] = viewport.convertToViewportPoint(
        rect.x,
        rect.y + rect.height,
    );

    // Fine while pages are unrotated. On a rotated page, convert both corners
    // and take min/max — rotation swaps the axes and this shortcut breaks.
    const width = rect.width * viewport.scale;
    const height = rect.height * viewport.scale;

    return { left, top, width, height };
}

export function cssRectToPdf(viewport: PageViewport, rect: CssRect): PdfRect {
    const [x, y] = viewport.convertToPdfPoint(rect.left, rect.top + rect.height);

    return {
        x,
        y,
        width: cssLengthToPdf(viewport, rect.width),
        height: cssLengthToPdf(viewport, rect.height),
    };
}

/**
 * Font size in points -> CSS pixels at the current zoom.
 * Easy to forget: without this, text stays 14px while the page grows to 300%.
 */
export function fontSizeToCss(viewport: PageViewport, points: number): number {
    return points * viewport.scale;
}

/**
 * Sanity check while wiring this up: round-tripping a point should return
 * roughly what you started with (floating point, so don't test equality).
 *
 *   const p = cssPointToPdf(viewport, 100, 200);
 *   const back = viewport.convertToViewportPoint(p.x, p.y);  // ~[100, 200]
 *
 * If it doesn't round-trip, you're mixing viewports — almost certainly the
 * canvas one (scale * dpr) has crept in somewhere.
 */

/**
 * NOTE FOR EXPORT (not this file's job, but decide it once and write it down):
 * pdf-lib's drawText takes y as the TEXT BASELINE, not the bottom of the box.
 * Exporting rect.y directly puts text slightly higher than the editor showed.
 * You'll subtract the font descent — font.heightAtSize() and the font metrics
 * give you what you need.
 */