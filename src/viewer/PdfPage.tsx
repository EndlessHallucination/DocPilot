/**
 * given a document, a page number, and a zoom level, paint that page onto a canvas 
 * — and cope with the user changing their mind mid-paint. 
 * */

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { PdfTextLayer } from "./PdfTextLayer";

type RenderTask = ReturnType<PDFPageProxy["render"]>;

interface PdfPageProps {
    doc: PDFDocumentProxy;
    pageNumber: number;
    scale: number;
}

interface PageSize {
    cssWidth: number;
    cssHeight: number;
}

function isCancelled(err: unknown): boolean {
    return err instanceof Error && err.name === "RenderingCancelledException";
}

export function PdfPage({ doc, pageNumber, scale }: PdfPageProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const renderTaskRef = useRef<RenderTask | null>(null);

    const [size, setSize] = useState<PageSize | null>(null);
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

                const dpr = window.devicePixelRatio || 1;
                const viewport = page.getViewport({ scale: scale * dpr });

                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);


                setSize({
                    cssWidth: viewport.width / dpr,
                    cssHeight: viewport.height / dpr,
                });

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
                size
                    ? { width: size.cssWidth, height: size.cssHeight }
                    : { minWidth: 320, minHeight: 200 }
            }
        >
            <canvas ref={canvasRef} className="block h-full w-full" />
            <PdfTextLayer doc={doc} pageNumber={pageNumber} scale={scale} />

            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/90 p-8 text-center text-sm text-red-600">
                    {error}
                </div>
            )}
        </div>
    );
}