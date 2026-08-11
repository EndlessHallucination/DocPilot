/**
 * Editor session store — every annotation the user has placed, plus the
 * editor's current mode.
 *
 * PURE STATE: no DOM, no React, no pdfjs (§12.5), so it stays importable from
 * background/. React binding is the thin wrapper in
 * viewer/useAnnotationStore.ts.
 *
 * Nothing here persists. Annotations live in memory for the tab's lifetime
 * and are gone on refresh (§8) — `dirty` exists so the user gets warned
 * before that happens (step 8), not so anything gets saved.
 *
 * Two invariants this module is responsible for:
 *
 *   Geometry is PDF points, y = bottom edge, origin bottom-left (§14.4).
 *   Nothing here converts anything; callers hand over points already
 *   converted through viewer/coordinates.ts. Screen pixels must never
 *   reach this file.
 *
 *   Text is logical order, exactly as typed (§14.3). Visual reordering
 *   happens once, in the export path. Storing visual order would corrupt
 *   editing, search, and the copilot payload in week 2.
 *
 * Selection is two fields, not one. `selectedId` means the box has handles
 * and Delete removes it; `editingId` means the caret is inside it and Delete
 * types a character. Collapsing them makes Backspace delete the box you're
 * typing in.
 */

import { createStore } from "zustand/vanilla";
import type { Annotation, PdfRect, SymbolAnnotation } from "./annotations";

export type ToolId = "select" | "text" | "signature" | "symbol";

export interface AnnotationState {
    /**
     * Flat across all pages. Array order IS z-order: later = drawn on top.
     * The export path must iterate in this same order (step 7).
     */
    annotations: Annotation[];
    activeTool: ToolId;
    /** Which mark the symbol tool places. Only meaningful when activeTool is "symbol". */
    activeSymbol: SymbolAnnotation["symbol"];
    /**
    * A drawn signature waiting to be placed. Unlike text and symbols, the
    * drawing happens BEFORE the click that positions it — you need somewhere to
    * draw, so the pad opens first and the next page click places the result.
    */
    pendingSignature: string | null;
    setPendingSignature: (dataUrl: string | null) => void;
    /** Has handles. Delete removes it, arrows nudge it. */
    selectedId: string | null;
    /** Caret is inside it. Delete types a character. Subset of selected. */
    editingId: string | null;
    /** Drives the beforeunload guard (step 8). */
    dirty: boolean;

    setActiveTool: (tool: ToolId) => void;
    setActiveSymbol: (symbol: SymbolAnnotation["symbol"]) => void;
    /** Clears edit mode, unless the id selected is the one already editing. */
    select: (id: string | null) => void;
    beginEdit: (id: string) => void;

    /** Returns the new id; the annotation is left selected and in edit mode. */
    addText: (page: number, rect: PdfRect, fontSize: number) => string;

    /**
     * Returns the new id. Unlike addText, does NOT set editingId — a symbol
     * has nothing to edit.
     */
    addSymbol: (
        page: number,
        rect: PdfRect,
        symbol: SymbolAnnotation["symbol"],
    ) => string;

    /** Returns the new id. Nothing to edit, so no editingId. */
    addSignature: (page: number, rect: PdfRect, imageDataUrl: string) => string;
    /** Commit the draft. Empty/whitespace -> the annotation is removed. */
    commitText: (id: string, text: string) => void;
    /** Leave edit mode. An annotation that was never committed is discarded. */
    cancelEdit: (id: string) => void;

    /** Call on drag/resize END, not on every pointermove. */
    setRect: (id: string, rect: PdfRect) => void;
    remove: (id: string) => void;

    /** Call after a successful export. */
    markSaved: () => void;
}

const newId = (): string => crypto.randomUUID();

export const annotationStore = createStore<AnnotationState>((set, get) => ({
    annotations: [],
    activeTool: "select",
    activeSymbol: "check",
    pendingSignature: null,
    selectedId: null,
    editingId: null,
    dirty: false,

    setActiveTool: (tool) => set({ activeTool: tool }),
    setActiveSymbol: (symbol) => set({ activeSymbol: symbol }),
    setPendingSignature: (dataUrl) => set({ pendingSignature: dataUrl }),

    addSignature: (page, rect, imageDataUrl) => {
        const id = newId();

        const annotation: Annotation = {
            id,
            kind: "signature",
            page,
            rect,
            imageDataUrl,
        };

        set((state) => ({
            annotations: [...state.annotations, annotation],
            selectedId: id,
            dirty: true,
        }));

        return id;
    },
    select: (id) =>
        set((state) => ({
            selectedId: id,
            // Don't drop out of edit mode when reselecting the box being
            // edited.
            editingId: state.editingId === id ? state.editingId : null,
        })),

    beginEdit: (id) => set({ selectedId: id, editingId: id }),

    addText: (page, rect, fontSize) => {
        const id = newId();

        const annotation: Annotation = {
            id,
            kind: "text",
            page,
            rect,
            text: "",
            fontSize,
        };

        set((state) => ({
            annotations: [...state.annotations, annotation],
            selectedId: id,
            editingId: id,
            dirty: true,
        }));

        return id;
    },

    addSymbol: (page, rect, symbol) => {
        const id = newId();

        const annotation: Annotation = {
            id,
            kind: "symbol",
            page,
            rect,
            symbol,
        };

        set((state) => ({
            annotations: [...state.annotations, annotation],
            selectedId: id,
            // No editingId — nothing to edit.
            dirty: true,
        }));

        return id;
    },

    commitText: (id, text) => {
        const trimmed = text.trim();

        if (!trimmed) {
            get().remove(id);
            return;
        }

        set((state) => ({
            annotations: state.annotations.map((annotation) => {
                if (annotation.id !== id || annotation.kind !== "text") {
                    return annotation;
                }

                return {
                    ...annotation,
                    text: trimmed,
                };
            }),
            editingId: state.editingId === id ? null : state.editingId,
            dirty: true,
        }));
    },

    cancelEdit: (id: string) => {
        const annotation = get().annotations.find((a) => a.id === id);

        // Never committed anything — it was never really created.
        if (annotation?.kind === "text" && !annotation.text) {
            get().remove(id);
            return;
        }

        set((state) => ({
            editingId: state.editingId === id ? null : state.editingId,
        }));
    },

    setRect: (id, rect) => {
        set((state) => ({
            annotations: state.annotations.map((annotation) =>
                annotation.id === id
                    ? {
                        ...annotation,
                        rect,
                    }
                    : annotation,
            ),
            dirty: true,
        }));
    },

    remove: (id) => {
        set((state) => ({
            annotations: state.annotations.filter(
                (annotation) => annotation.id !== id,
            ),
            selectedId:
                state.selectedId === id ? null : state.selectedId,
            editingId:
                state.editingId === id ? null : state.editingId,
            dirty: true,
        }));
    },

    markSaved: () => set({ dirty: false }),
}));