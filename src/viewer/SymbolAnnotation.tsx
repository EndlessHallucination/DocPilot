/**
 * A single symbol annotation — checkmark, cross, or dot.
 */

import { useRef, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import type { CssRect, SymbolAnnotation } from "../state/annotations";
import { useAnnotationStore } from "./useAnnotationStore";
import { pdfRectToCss, cssRectToPdf } from "./coordinates";

interface Props {
    annotation: SymbolAnnotation;
    viewport: PageViewport;
    isSelected: boolean;
}

interface Gesture {
    startClientX: number;
    startClientY: number;
    startRect: CssRect;
}

/**
 * Paths are drawn in a 0-100 viewBox, so these constants never change with
 * zoom or symbol size — the element's width/height do all the scaling, and
 * stroke-width scales with them because it's in user units.
 */
const PATHS: Record<SymbolAnnotation["symbol"], string> = {
    check: "M 20 52 L 42 74 L 80 26",
    cross: "M 24 24 L 76 76 M 76 24 L 24 76",
    dot: "", // rendered as a <circle>, not a path
};

export function SymbolAnnotationView({
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

    const handlePointerDown = (e: React.PointerEvent) => {
        select(annotation.id);

        e.preventDefault();
        (e.target as Element).setPointerCapture(e.pointerId)
        gestureRef.current = {
            startClientX: e.clientX,
            startClientY: e.clientY,
            startRect: css
        }
        setGestureRect(css)
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;

        const dx = e.clientX - g.startClientX;
        const dy = e.clientY - g.startClientY;
        setGestureRect({
            ...g.startRect,
            left: g.startRect.left + dx,
            top: g.startRect.top + dy,
        });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        // Release BEFORE the guard — bailing first leaves a half-started
        // gesture holding pointer capture forever.
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
                // Parent is pointerEvents: none in select mode.
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
            <svg
                viewBox="0 0 100 100"
                width="100%"
                height="100%"
                // The mark is decoration; the wrapper handles all input.
                style={{ display: "block", pointerEvents: "none" }}
            >
                {annotation.symbol === "dot" ? (
                    <circle cx="50" cy="50" r="30" fill="#000" />
                ) : (
                    <path
                        d={PATHS[annotation.symbol]}
                        stroke="#000"
                        strokeWidth={12}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                    />
                )}
            </svg>
        </div>
    );
}