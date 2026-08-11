/**
 * Interactive annotation overlay for a single page. Stacks above the canvas
 * and the text layer: canvas (bottom) -> PdfTextLayer -> AnnotationLayer.
 *
 * Three jobs: render this page's annotations, turn a click on empty space
 * into a new annotation, own the editor's keyboard shortcuts. It knows
 * nothing about how any individual annotation draws itself.
 *
 * CSS PIXEL SPACE. The viewport must be built at plain `scale`, never
 * scale * devicePixelRatio (§12.3) — that's the canvas's business. Mixing
 * them puts every annotation at double offset on a retina display, and it's
 * the same bug the text layer already had.
 *
 * The container's pointerEvents toggle is load-bearing: transparent to the
 * mouse in select mode so PdfTextLayer keeps its selection, opaque in a
 * placement tool so clicks land here. Annotations re-enable pointer events
 * on themselves, so they stay grabbable in both modes.
 *
 * Everything is `click`, never `pointerdown`. Pointerdown fires before an
 * open textarea's blur, so acting on it would unmount the textarea before
 * it commits and silently drop the user's draft.
 */

import { useEffect, useMemo, useRef } from "react";
import type { PageViewport } from "pdfjs-dist";
import { useAnnotationStore } from "./useAnnotationStore";
import { cssPointToPdf } from "./coordinates";
import { TextAnnotationView } from "./TextAnnotation";
import { SymbolAnnotationView } from "./SymbolAnnotation";
import { SignatureAnnotationView } from "./SignatureAnnotation";


interface Props {
    /** 1-indexed, matching pdf.js. */
    pageNumber: number;
    /** CSS-space viewport — the same object PdfTextLayer uses. */
    viewport: PageViewport;
}

/** Points. A new box is one line tall and this wide until dragged. */
const DEFAULT_FONT_SIZE = 12;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_WIDTH = 160;
/** Points. Roughly a form checkbox on the Harel fixture. */
const SYMBOL_SIZE = 10;
const SIGNATURE_WIDTH = 120;
const SIGNATURE_RATIO = 180 / 480;

export function AnnotationLayer({ pageNumber, viewport }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);

    const activeTool = useAnnotationStore((s) => s.activeTool);
    const annotations = useAnnotationStore((s) => s.annotations);
    const selectedId = useAnnotationStore((s) => s.selectedId);
    const editingId = useAnnotationStore((s) => s.editingId);

    const addText = useAnnotationStore((s) => s.addText);
    const addSymbol = useAnnotationStore((s) => s.addSymbol);
    const setActiveTool = useAnnotationStore((s) => s.setActiveTool);
    const select = useAnnotationStore((s) => s.select);
    const remove = useAnnotationStore((s) => s.remove);
    const activeSymbol = useAnnotationStore((s) => s.activeSymbol);



    const addSignature = useAnnotationStore((s) => s.addSignature);
    const pendingSignature = useAnnotationStore((s) => s.pendingSignature);


    // Filter here, never inside a selector — a selector returning a fresh
    // array re-renders on every store read.
    const pageAnnotations = useMemo(
        () => annotations.filter((a) => a.page === pageNumber),
        [annotations, pageNumber],
    );

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Only react to clicks on the empty background.
        if (e.target !== e.currentTarget) return;

        // Deselection is handled by the document listener below. In select
        // mode this container is transparent to the mouse, so background
        // clicks never arrive here at all.
        if (activeTool === "select") return;

        // Text tool: create a new text annotation at the click position.
        if (activeTool === "text") {
            const container = containerRef.current;
            if (!container) return;

            const rect = container.getBoundingClientRect();

            const cssX = e.clientX - rect.left;
            const cssY = e.clientY - rect.top;

            const { x, y: pdfY } = cssPointToPdf(viewport, cssX, cssY);

            const height = DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT;

            // The click is the TOP edge of the box the user is imagining;
            // PdfRect.y is the BOTTOM edge (§14.4). Boxes landing one line
            // too high means this subtraction went missing.
            addText(
                pageNumber,
                {
                    x,
                    y: pdfY - height,
                    width: DEFAULT_WIDTH,
                    height,
                },
                DEFAULT_FONT_SIZE,
            );

            // Text placement is one-shot; addText already selects the new
            // annotation and opens it for editing.
            setActiveTool("select");
            e.stopPropagation();
            return;
        }

        if (activeTool === "symbol") {
            const container = containerRef.current;
            if (!container) return;

            const rect = container.getBoundingClientRect();
            const { x, y } = cssPointToPdf(
                viewport,
                e.clientX - rect.left,
                e.clientY - rect.top,
            );

            // Centred on the cursor, not anchored top-left like text — you're
            // aiming at a small box and the mark should land where you pointed.
            addSymbol(
                pageNumber,
                {
                    x: x - SYMBOL_SIZE / 2,
                    y: y - SYMBOL_SIZE / 2,
                    width: SYMBOL_SIZE,
                    height: SYMBOL_SIZE,
                },
                activeSymbol,
            )

            // Deliberately STICKY — no setActiveTool("select") here. The
            // Harel form is a column of checkboxes; you want to place several
            // without going back to the toolbar between each.
            e.stopPropagation();
            return;
        }

        if (activeTool === "signature") {
            // Nothing drawn yet — the toolbar button opens the pad.
            if (!pendingSignature) return;

            const container = containerRef.current;
            if (!container) return;

            const rect = container.getBoundingClientRect();
            const { x, y } = cssPointToPdf(
                viewport,
                e.clientX - rect.left,
                e.clientY - rect.top,
            );

            const height = SIGNATURE_WIDTH * SIGNATURE_RATIO;

            // Centred on the cursor, like symbols — you're aiming at a signature
            // line, not setting a text box's top-left corner.
            addSignature(
                pageNumber,
                {
                    x: x - SIGNATURE_WIDTH / 2,
                    y: y - height / 2,
                    width: SIGNATURE_WIDTH,
                    height,
                },
                pendingSignature,
            );

            // Sticky, and pendingSignature is NOT cleared — the Harel form has
            // signature fields on pages 2 and 3, so the same signature gets placed
            // more than once.
            e.stopPropagation();
            return;
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't handle global shortcuts while editing an annotation.
            if (editingId !== null) return;

            const target = e.target as HTMLElement | null;

            // Don't interfere with normal text editing/navigation.
            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target?.isContentEditable
            ) {
                return;
            }

            if (
                (e.key === "Delete" || e.key === "Backspace") &&
                selectedId !== null
            ) {
                remove(selectedId);
                // Without this, Backspace navigates the page back.
                e.preventDefault();
                return;
            }

            if (e.key === "Escape") {
                select(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [editingId, selectedId, remove, select]);

    // Deselect when clicking outside any annotation.
    //
    // Identifies "background" by exclusion rather than by enumerating what
    // counts as background — the click may land on a text-layer span, the
    // canvas, or the page margin. Editor chrome is excluded too, otherwise
    // a toolbar button would deselect before its own handler reads
    // selectedId; give the toolbar wrapper data-editor-chrome.
    useEffect(() => {
        if (selectedId === null) return;

        const handleDocumentClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (
                target?.closest("[data-annotation-id], [data-editor-chrome]")
            ) {
                return;
            }
            select(null);
        };

        document.addEventListener("click", handleDocumentClick);

        return () => {
            document.removeEventListener("click", handleDocumentClick);
        };
    }, [selectedId, select]);

    return (
        <div
            ref={containerRef}
            className="absolute left-0 top-0"
            style={{
                width: viewport.width,
                height: viewport.height,
                pointerEvents:
                    activeTool === "select" && editingId === null
                        ? "none"
                        : "auto",
                cursor:
                    activeTool === "text"
                        ? "text"
                        : activeTool === "symbol" || activeTool === "signature"
                            ? "crosshair"
                            : "default",
            }}
            onClick={handleClick}
        >
            {pageAnnotations.map((a) => {
                switch (a.kind) {
                    case "text":
                        return (
                            <TextAnnotationView
                                key={a.id}
                                annotation={a}
                                viewport={viewport}
                                isSelected={a.id === selectedId}
                                isEditing={a.id === editingId}
                            />
                        );

                    case "symbol":
                        return (
                            <SymbolAnnotationView
                                key={a.id}
                                annotation={a}
                                viewport={viewport}
                                isSelected={a.id === selectedId}
                            />
                        );

                    case "signature":
                        return (
                            <SignatureAnnotationView
                                key={a.id}
                                annotation={a}
                                viewport={viewport}
                                isSelected={a.id === selectedId}
                            />
                        );
                }

            })}
        </div>
    );
}