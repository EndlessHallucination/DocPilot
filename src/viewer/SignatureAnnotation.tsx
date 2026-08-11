/**
 * A placed signature — a PNG data URL drawn in SignaturePad, positioned like
 * any other annotation.
 *
 */

import { useRef, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import type { CssRect, SignatureAnnotation } from "../state/annotations";
import { useAnnotationStore } from "./useAnnotationStore";
import { pdfRectToCss, cssRectToPdf } from "./coordinates";

interface Props {
    annotation: SignatureAnnotation;
    viewport: PageViewport;
    isSelected: boolean;
}

interface Gesture {
    mode: "drag" | "resize";
    startClientX: number;
    startClientY: number;
    startRect: CssRect;
}

/** CSS px. Below this the handle is unusable. */
const MIN_WIDTH_CSS = 32;

export function SignatureAnnotationView({
    annotation,
    viewport,
    isSelected,
}: Props) {
    const gestureRef = useRef<Gesture | null>(null);
    const [gestureRect, setGestureRect] = useState<CssRect | null>(null);

    const select = useAnnotationStore((s) => s.select);
    const setRect = useAnnotationStore((s) => s.setRect);

    const css = pdfRectToCss(viewport, annotation.rect);
    const rendered = gestureRect ?? css;

    const endGesture = () => {
        gestureRef.current = null;
        setGestureRect(null);
    };

    const beginGesture = (e: React.PointerEvent, mode: Gesture["mode"]) => {
        e.preventDefault();
        (e.target as Element).setPointerCapture(e.pointerId);

        gestureRef.current = {
            mode,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startRect: css,
        };

        setGestureRect(css);
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        select(annotation.id);
        beginGesture(e, "drag");
    };

    const handleResizePointerDown = (e: React.PointerEvent) => {
        e.stopPropagation(); // or the drag handler fires too
        beginGesture(e, "resize");
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;

        const dx = e.clientX - g.startClientX;
        const dy = e.clientY - g.startClientY;

        if (g.mode === "drag") {
            setGestureRect({
                ...g.startRect,
                left: g.startRect.left + dx,
                top: g.startRect.top + dy,
            });
            return;
        }

        // Proportional: width follows the cursor, height follows the
        // original ratio. Driving height from dy independently would let
        // the signature stretch.
        const ratio = g.startRect.height / g.startRect.width;
        const width = Math.max(MIN_WIDTH_CSS, g.startRect.width + dx);

        setGestureRect({
            ...g.startRect,
            width,
            height: width * ratio,
        });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        // Release BEFORE the guard — bailing first holds pointer capture
        // forever on a half-started gesture.
        (e.target as Element).releasePointerCapture(e.pointerId);

        if (!gestureRef.current || !gestureRect) return;

        setRect(annotation.id, cssRectToPdf(viewport, gestureRect));
        endGesture();
    };

    return (
        <div
            // Required by AnnotationLayer's deselect listener.
            data-annotation-id={annotation.id}
            className="absolute"
            style={{
                left: rendered.left,
                top: rendered.top,
                width: rendered.width,
                height: rendered.height,
                pointerEvents: "auto",
                cursor: "move",
                outline: isSelected ? "1px dashed #2563eb" : "none",
                outlineOffset: 1,
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={endGesture}
        >
            <img
                src={annotation.imageDataUrl}
                alt=""
                // Native image drag-and-drop hijacks the pointer gesture —
                // without this the drag silently does nothing.
                draggable={false}
                style={{
                    display: "block",
                    width: "100%",
                    height: "100%",
                    // The wrapper handles all input.
                    pointerEvents: "none",
                }}
            />

            {isSelected && (
                <div
                    onPointerDown={handleResizePointerDown}
                    className="absolute -bottom-1 -right-1 h-2 w-2 bg-blue-600"
                    style={{ cursor: "nwse-resize" }}
                />
            )}
        </div>
    );
}