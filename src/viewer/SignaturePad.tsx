/**
 * Modal for drawing a signature. The result becomes a PNG data URL in
 * pendingSignature; the next click on the page places it.
 *
 * Drawing comes BEFORE placement, unlike text and symbols — you need a
 * surface to draw on, and it can't be the form itself.
 *
 * The canvas backing store is sized at devicePixelRatio and the context
 * scaled once to match, so every drawing coordinate below stays in CSS
 * pixels (same approach as PdfPage, §12.3). Without it the signature is
 * visibly fuzzy, and it gets embedded into the PDF that way.
 *
 * The canvas is never filled — toDataURL("image/png") preserves alpha, so
 * the signature sits transparently over the form's signature line. Filling
 * it white would cover the line.
 */

import { useEffect, useRef, useState } from "react";
import { useAnnotationStore } from "./useAnnotationStore";

interface Props {
    onClose: () => void;
}

/** CSS px. Ratio here decides the placed signature's aspect ratio. */
const PAD_WIDTH = 480;
const PAD_HEIGHT = 180;
const STROKE_WIDTH = 2.5;

export function SignaturePad({ onClose }: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const drawingRef = useRef(false);

    /** An empty canvas saves as an invisible annotation — gate on this. */
    const hasStrokeRef = useRef(false);

    const [hasStroke, setHasStroke] = useState(false);

    const setPendingSignature = useAnnotationStore(
        (s) => s.setPendingSignature,
    );
    const setActiveTool = useAnnotationStore((s) => s.setActiveTool);

    // Size the backing store and configure the context once.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;

        canvas.width = PAD_WIDTH * dpr;
        canvas.height = PAD_HEIGHT * dpr;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // setTransform, not scale — React runs effects twice in dev, and
        // scale() multiplies onto whatever transform is already there.
        // Drawing coordinates below stay in CSS pixels either way.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.lineWidth = STROKE_WIDTH;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#000";

        ctxRef.current = ctx;

        // Deliberately no fill — transparency is the point.
    }, []);

    // Escape closes, matching every other dismissal in the editor.
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    /** Cursor position in CSS px, relative to the canvas. */
    const positionOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };

        const rect = canvas.getBoundingClientRect();

        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        const ctx = ctxRef.current;
        if (!canvas || !ctx) return;

        // Keeps the stroke alive if the cursor leaves the canvas mid-draw.
        canvas.setPointerCapture(e.pointerId);

        drawingRef.current = true;

        const pos = positionOf(e);

        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current) return;

        const ctx = ctxRef.current;
        if (!ctx) return;

        const pos = positionOf(e);

        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();

        // Ref for the handlers, state for the button.
        if (!hasStrokeRef.current) {
            hasStrokeRef.current = true;
            setHasStroke(true);
        }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;

        // Checked because pointercancel can arrive after capture is gone.
        if (canvas?.hasPointerCapture(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId);
        }

        drawingRef.current = false;
    };

    const handleClear = () => {
        const ctx = ctxRef.current;
        if (!ctx) return;

        // clearRect, not fillRect — fillRect would destroy transparency.
        // Coordinates are CSS px because the context is already scaled.
        ctx.clearRect(0, 0, PAD_WIDTH, PAD_HEIGHT);

        hasStrokeRef.current = false;
        setHasStroke(false);
    };

    const handleSave = () => {
        const canvas = canvasRef.current;
        if (!canvas || !hasStrokeRef.current) return;

        setPendingSignature(canvas.toDataURL("image/png"));
        setActiveTool("signature");
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div
                // Editor chrome: without this, clicking inside the modal
                // reads as a background click and deselects.
                data-editor-chrome
                className="rounded-lg bg-white p-4 shadow-xl"
            >
                <p className="mb-3 text-sm font-medium">Draw your signature</p>

                <canvas
                    ref={canvasRef}
                    style={{
                        width: PAD_WIDTH,
                        height: PAD_HEIGHT,
                        // Without this the browser treats the drag as a
                        // scroll and nothing is drawn on trackpads/touch.
                        touchAction: "none",
                        cursor: "crosshair",
                    }}
                    className="rounded border border-neutral-300"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                />

                <div className="mt-3 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleClear}
                        className="rounded px-3 py-1 text-sm hover:bg-neutral-100"
                    >
                        Clear
                    </button>

                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-auto rounded px-3 py-1 text-sm hover:bg-neutral-100"
                    >
                        Cancel
                    </button>

                    <button
                        type="button"
                        disabled={!hasStroke}
                        onClick={handleSave}
                        className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-40"
                    >
                        Use signature
                    </button>
                </div>
            </div>
        </div>
    );
}