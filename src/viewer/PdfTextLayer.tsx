/**
 * An invisible, selectable copy of the page's text, positioned over the canvas.
 * Lives in CSS pixel space — viewport is built at `scale`, NOT `scale * dpr`.
 */

import { useEffect, useRef } from "react";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

interface PdfTextLayerProps {
    doc: PDFDocumentProxy;
    pageNumber: number;
    scale: number;
}

export function PdfTextLayer({ doc, pageNumber, scale }: PdfTextLayerProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    // Shared across effect runs, so the next run can tear down the previous layer.
    const layerRef = useRef<TextLayer | null>(null);
    const renderPromiseRef = useRef<Promise<void> | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function buildTextLayer() {
            const container = containerRef.current;
            if (!container) return;

            if (layerRef.current) {
                layerRef.current.cancel();
                await renderPromiseRef.current?.catch(() => { });
                layerRef.current = null;
                renderPromiseRef.current = null;
            }

            if (cancelled) return;

            try {
                const page = await doc.getPage(pageNumber)
                if (cancelled) return
                const viewport = page.getViewport({ scale })

                container.style.setProperty("--scale-factor", String(scale));
                container.style.setProperty("--total-scale-factor", String(scale));

                container.replaceChildren()

                const layer = new TextLayer({
                    textContentSource: page.streamTextContent(),
                    container,
                    viewport
                })
                layerRef.current = layer
                renderPromiseRef.current = layer.render()

                await renderPromiseRef.current
                if (cancelled) return

            } catch (err) {
                if (cancelled) return;

                console.error("Text layer failed:", err);
            }
        }

        buildTextLayer();

        return () => {
            cancelled = true;
            layerRef.current?.cancel();
        };
    }, [doc, pageNumber, scale]);

    return <div ref={containerRef} className="textLayer" />;
}