/**
 * A single text annotation.
 *
 * Display and edit are the same <textarea> with readOnly toggled — a separate
 * display <div> computes metrics slightly differently, and the text would
 * visibly shift on entering edit mode.
 *
 * Geometry is stored in PDF points and converted at render through
 * coordinates.ts (§14.4). The box's CSS geometry must EQUAL its stored
 * geometry, so padding is 0 and the selection affordance is an `outline`,
 * which doesn't participate in layout.
 *
 * Text is stored in logical order, exactly as typed (§14.3). dir="auto" makes
 * the browser display RTL correctly; the visual flip happens once, in export.
 *
 * The draft lives in local state while editing and is committed on blur —
 * routing every keystroke through the store would re-render every annotation
 * on the page.
 *
 * THE BOX GROWS, IT NEVER WRAPS. white-space: pre plus wrap="off" means the
 * only line breaks in the string are ones the user typed. A browser soft-wrap
 * inserts no "\n", so the export — which splits on "\n" — would draw a
 * wrapped box as one long line. Growing instead makes editor and export agree
 * by construction. Both dimensions are content-derived, which is why there's
 * no resize handle.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import type { CssRect, TextAnnotation } from "../state/annotations";
import { useAnnotationStore } from "./useAnnotationStore";
import { pdfRectToCss, fontSizeToCss, cssRectToPdf } from "./coordinates";

interface Props {
    annotation: TextAnnotation;
    viewport: PageViewport;
    isSelected: boolean;
    isEditing: boolean;
}

/** Must match DEFAULT_LINE_HEIGHT in AnnotationLayer, and the export path. */
const LINE_HEIGHT = 1.2;

interface Size {
    width: number;
    height: number;
}

/**
 * One press-move-release sequence. Positions are DELTAS from the grab point
 * applied to startRect — re-measuring the element each frame would subtract a
 * left edge that itself moves, and the box accelerates away from the cursor.
 */
interface Gesture {
    startClientX: number;
    startClientY: number;
    startRect: CssRect;
}

export function TextAnnotationView({
    annotation,
    viewport,
    isSelected,
    isEditing,
}: Props) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const gestureRef = useRef<Gesture | null>(null);
    /** Set by Escape so handleBlur knows to throw the draft away. */
    const discardingRef = useRef(false);
    /**
     * Last measured size. A ref as well as state because blur fires AFTER the
     * layout effect has cleared the state — reading state there returns null
     * and the box commits at its creation height, clipping every line but the
     * first.
     */
    const editSizeRef = useRef<Size | null>(null);

    const select = useAnnotationStore((s) => s.select);
    const beginEdit = useAnnotationStore((s) => s.beginEdit);
    const commitText = useAnnotationStore((s) => s.commitText);
    const cancelEdit = useAnnotationStore((s) => s.cancelEdit);
    const setRect = useAnnotationStore((s) => s.setRect);

    /** Uncommitted text. Committed values live in the store. */
    const [draft, setDraft] = useState(annotation.text);

    /** Non-null only during a drag, so the store is written once on pointerup. */
    const [gestureRect, setGestureRect] = useState<CssRect | null>(null);

    /** Measured content size while editing. Null outside edit mode. */
    const [editSize, setEditSize] = useState<Size | null>(null);

    const css = pdfRectToCss(viewport, annotation.rect);
    const fontSizeCss = fontSizeToCss(viewport, annotation.fontSize);

    /** What's actually on screen right now. */
    const rendered = gestureRect ?? css;

    // ---- effects ----------------------------------------------------------

    // Resync the draft when edit mode opens, so Escape (which discards) leaves
    // the next edit starting from the committed value.
    useEffect(() => {
        if (isEditing) setDraft(annotation.text);
    }, [isEditing, annotation.text]);

    useEffect(() => {
        if (!isEditing) return;

        const el = textareaRef.current;
        if (!el) return;

        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
    }, [isEditing]);

    // Auto-grow, both axes. Layout effect so the resize lands before paint.
    useLayoutEffect(() => {
        const el = textareaRef.current;
        if (!el) return;

        if (!isEditing) {
            // Deliberately does NOT clear el.style. React writes height and
            // width from the style prop in this same commit; clearing after
            // wipes them while React still believes it applied them, and the
            // box renders with no height at all.
            setEditSize(null);
            return;
        }

        // BOTH writes before BOTH reads. "auto" is required or scroll* is
        // clamped by the current size and the box can only ever grow;
        // interleaving write/read/write/read measures the second axis against
        // a box the first write already resized, and comes out a line short.
        el.style.height = "auto";
        el.style.width = "auto";

        const width = el.scrollWidth;
        const height = el.scrollHeight;

        el.style.height = `${height}px`;
        el.style.width = `${width}px`;

        editSizeRef.current = { width, height };
        setEditSize({ width, height });
    }, [draft, isEditing, fontSizeCss]);

    // ---- editing ----------------------------------------------------------

    const handleBlur = () => {
        if (discardingRef.current) {
            // Reset here rather than after blur() in the keydown handler —
            // clearing it earlier reintroduces the race.
            discardingRef.current = false;
            return;
        }

        // From the ref, not state and not the DOM — both are already torn
        // down by the time blur resolves.
        const size = editSizeRef.current;

        if (size) {
            setRect(annotation.id, cssRectToPdf(viewport, { ...css, ...size }));
        }

        // Must run last: commitText DELETES the annotation when the draft is
        // empty, and setRect on a dead id is a silent no-op.
        commitText(annotation.id, draft);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // AnnotationLayer's window keydown would otherwise see typing — its
        // Backspace handler deletes the selected annotation.
        e.stopPropagation();

        if (e.key === "Escape") {
            // blur() fires handleBlur, which commits. Escape means discard,
            // so flag it first.
            discardingRef.current = true;
            cancelEdit(annotation.id);
            textareaRef.current?.blur();
        }
        // Enter inserts a newline: default behaviour, deliberately not
        // intercepted. It's the only way a "\n" enters the string.
    };

    // ---- gestures ---------------------------------------------------------

    const endGesture = () => {
        gestureRef.current = null;
        setGestureRect(null);
    };

    const handlePointerDownDrag = (e: React.PointerEvent) => {
        // While editing, pointerdown places the caret. select() would clear
        // editingId and flip the textarea to readOnly mid-sentence.
        if (isEditing) return;

        // On pointerdown, not click — click also fires at the end of a drag,
        // which would reselect on every drop.
        select(annotation.id);

        e.preventDefault();
        (e.target as Element).setPointerCapture(e.pointerId);

        gestureRef.current = {
            startClientX: e.clientX,
            startClientY: e.clientY,
            startRect: css,
        };

        setGestureRect(css);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;

        setGestureRect({
            ...g.startRect,
            left: g.startRect.left + (e.clientX - g.startClientX),
            top: g.startRect.top + (e.clientY - g.startClientY),
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

    // Without this, an interrupted gesture leaves gestureRef populated and the
    // next pointermove over the box resumes a phantom drag.
    const handlePointerCancel = () => {
        endGesture();
    };

    // ---- render -----------------------------------------------------------

    return (
        <div
            // Required by AnnotationLayer's deselect listener.
            data-annotation-id={annotation.id}
            className="absolute"
            style={{
                left: rendered.left,
                top: rendered.top,
                width: editSize?.width ?? rendered.width,
                height: editSize?.height ?? rendered.height,
                // The parent is pointerEvents: none in select mode;
                // annotations stay interactive regardless.
                pointerEvents: "auto",
                cursor: isEditing ? "text" : "move",
            }}
            onPointerDown={handlePointerDownDrag}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onDoubleClick={() => beginEdit(annotation.id)}
        >
            <textarea
                ref={textareaRef}
                dir="auto"
                // Default is 2, which gives a minimum height that fights the
                // auto measurement.
                rows={1}
                wrap="off"
                value={isEditing ? draft : annotation.text}
                readOnly={!isEditing}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                style={{
                    display: "block",
                    width: editSize?.width ?? "100%",
                    height: editSize?.height ?? rendered.height,
                    // CSS geometry must equal stored geometry.
                    margin: 0,
                    padding: 0,
                    border: "none",
                    outline: isEditing
                        ? "1px solid #2563eb"
                        : isSelected
                            ? "1px dashed #2563eb"
                            : "none",
                    outlineOffset: 1,
                    background: isEditing
                        ? "rgba(37, 99, 235, 0.06)"
                        : "transparent",
                    resize: "none",
                    whiteSpace: "pre",
                    overflow: "hidden",
                    color: "#000",
                    fontSize: fontSizeCss,
                    lineHeight: LINE_HEIGHT,
                    // TODO: must match the EXPORT font or on-screen widths lie
                    // and text that fits here won't fit in the PDF. Add an
                    // @font-face for the Noto TTF in public/fonts/.
                    fontFamily: "sans-serif",
                    cursor: "inherit",
                }}
            />
        </div>
    );
}