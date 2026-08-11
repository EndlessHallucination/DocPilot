/**
 * given a document, a page number, and a zoom level, paint that page onto a canvas 
 * — and cope with the user changing their mind mid-paint. 
 *
 * Owns the page wrapper that every overlay positions against: `relative`, and
 * sized in CSS pixels to match the canvas.
 * */

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import { PdfTextLayer } from "./PdfTextLayer";
import { AnnotationLayer } from "./AnnotationLayer";

type RenderTask = ReturnType<PDFPageProxy["render"]>;

interface PdfPageProps {
    doc: PDFDocumentProxy;
    pageNumber: number;
    scale: number;
}

function isCancelled(err: unknown): boolean {
    return err instanceof Error && err.name === "RenderingCancelledException";
}

export function PdfPage({ doc, pageNumber, scale }: PdfPageProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const renderTaskRef = useRef<RenderTask | null>(null);

    /**
     * CSS-pixel-space viewport. Doubles as the page's rendered size, and is
     * the coordinate system every DOM overlay works in (§12.3).
     */
    const [cssViewport, setCssViewport] = useState<PageViewport | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function renderPage() {
            const previousTask = renderTaskRef.current;
            const canvas = canvasRef.current;
            if (!canvas) return

            if (previousTask) {
                previousTask.cancel();
                await previousTask.promise.catch(() => { });
                renderTaskRef.current = null;
            }

            if (cancelled) return;
            try {
                const page = await doc.getPage(pageNumber);
                if (cancelled) return;

                // TWO viewports from the same page, deliberately (§12.3).
                // The canvas backing store is built at scale * dpr so it's
                // sharp on retina; everything in the DOM is built at plain
                // scale. Mixing them puts overlays at double offset.
                const dpr = window.devicePixelRatio || 1;
                const viewport = page.getViewport({ scale: scale * dpr });

                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);

                // Plain scale. A PageViewport is plain data (transform,
                // width, height), so it stays valid after page.cleanup().
                setCssViewport(page.getViewport({ scale }));

                const ctx = canvas.getContext("2d");
                if (!ctx) return;


                const task = page.render({ canvas, canvasContext: ctx, viewport });
                renderTaskRef.current = task;

                await task.promise;
                page.cleanup()

                if (cancelled) return;

                renderTaskRef.current = null;
                setError(null);


            } catch (err) {
                if (isCancelled(err) || cancelled) return;

                setError(err instanceof Error ? err.message : "Failed to render page");
            }
        }

        renderPage();

        return () => {
            cancelled = true;

            renderTaskRef.current?.cancel()

        };
    }, [doc, pageNumber, scale]);

    return (
        <div
            className="relative self-start bg-white shadow"
            style={
                cssViewport
                    ? { width: cssViewport.width, height: cssViewport.height }
                    : { minWidth: 320, minHeight: 200 }
            }
        >
            <canvas ref={canvasRef} className="block h-full w-full" />
            <PdfTextLayer doc={doc} pageNumber={pageNumber} scale={scale} />

            {/* Last child = on top. Guarded rather than made null-tolerant:
                there's nothing sensible to render without a viewport, and
                every coordinate call downstream would need its own check. */}
            {cssViewport && (
                <AnnotationLayer pageNumber={pageNumber} viewport={cssViewport} />
            )}

            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/90 p-8 text-center text-sm text-red-600">
                    {error}
                </div>
            )}
        </div>
    );
}