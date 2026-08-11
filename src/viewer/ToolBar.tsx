/**
 * Tool selection and per-selection actions.
 *
 * data-editor-chrome is required: AnnotationLayer's deselect listener treats
 * any click outside [data-annotation-id] or [data-editor-chrome] as a
 * background click and clears the selection — which would fire before a
 * button's own handler could read selectedId.
 *
 * Every button preventDefaults on mousedown, so clicking one doesn't blur an
 * open textarea. That matters most for Export: a blur-commit would update the
 * store after handleExport already closed over the annotations array.
 */

import { useState } from "react";
import { useAnnotationStore } from "./useAnnotationStore";
import type { ToolId } from "../state/annotationStore";
import type { LoadedPdf } from "./pdf-setup";
import { exportPdf, downloadPdf } from "../editor/export";
import { SymbolAnnotation } from "../state/annotations";
import { SignaturePad } from "./SignaturePad";

interface Props {
    pdf: LoadedPdf;
}

const TOOLS: { id: ToolId; label: string }[] = [
    { id: "select", label: "Select" },
    { id: "text", label: "Text" },
    { id: "symbol", label: "Check" },
    // TODO: { id: "signature", label: "Sign" } — step 5
];

const SYMBOLS: { id: SymbolAnnotation["symbol"]; label: string }[] = [
    { id: "check", label: "✓" },
    { id: "cross", label: "✗" },
    { id: "dot", label: "●" },
];

export function Toolbar({ pdf }: Props) {
    const activeTool = useAnnotationStore((s) => s.activeTool);
    const setActiveTool = useAnnotationStore((s) => s.setActiveTool);
    const selectedId = useAnnotationStore((s) => s.selectedId);
    const annotations = useAnnotationStore((s) => s.annotations);
    const remove = useAnnotationStore((s) => s.remove);
    const markSaved = useAnnotationStore((s) => s.markSaved);
    const dirty = useAnnotationStore((s) => s.dirty);
    const activeSymbol = useAnnotationStore((s) => s.activeSymbol);
    const setActiveSymbol = useAnnotationStore((s) => s.setActiveSymbol);

    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState<string | null>(null);

    const [padOpen, setPadOpen] = useState(false);
    const pendingSignature = useAnnotationStore((s) => s.pendingSignature);

    const handleExport = async () => {
        setExporting(true);
        setExportError(null);

        try {
            const bytes = await exportPdf(pdf.originalBytes, annotations);
            downloadPdf(bytes, `filled-${pdf.name}`);

            // Only on success — clearing dirty after a failed export means
            // the step-8 warning won't fire and the user loses work.
            markSaved();
        } catch (err) {
            // Never fail silently. A dead Export button on demo day reads as
            // the whole app being broken.
            setExportError(err instanceof Error ? err.message : "Export failed");
        } finally {
            setExporting(false);
        }
    };

    return (
        <div
            data-editor-chrome
            className="flex shrink-0 items-center gap-2 border-b bg-white px-3 py-2"
        >
            {TOOLS.map((tool) => (
                <button
                    key={tool.id}
                    type="button"
                    // Keeps focus in an open textarea, so clicking a tool
                    // doesn't blur-commit before the tool changes.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setActiveTool(tool.id)}
                    className={
                        activeTool === tool.id
                            ? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
                            : "rounded px-3 py-1 text-sm hover:bg-neutral-100"
                    }
                >
                    {tool.label}
                </button>
            ))}

            {/* Only while the symbol tool is active — the choice belongs to that
                tool, and showing it always clutters the bar. */}
            {activeTool === "symbol" &&
                SYMBOLS.map((symbol) => (
                    <button
                        key={symbol.id}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setActiveSymbol(symbol.id)}
                        className={
                            activeSymbol === symbol.id
                                ? "rounded bg-blue-100 px-2 py-1 text-sm ring-1 ring-blue-600"
                                : "rounded px-2 py-1 text-sm hover:bg-neutral-100"
                        }
                    >
                        {symbol.label}
                    </button>
                ))}
            <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPadOpen(true)}
                className={
                    activeTool === "signature" || padOpen
                        ? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
                        : "rounded px-3 py-1 text-sm hover:bg-neutral-100"
                }
            >
                {pendingSignature ? "Redraw signature" : "Sign"}
            </button>

            <div className="mx-1 h-5 w-px bg-neutral-300" />

            <button
                type="button"
                disabled={selectedId === null}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectedId && remove(selectedId)}
                className="rounded px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-40"
            >
                Delete
            </button>

            {/* Deliberately enabled with zero annotations — exporting an
                unmodified PDF is valid, and a greyed-out button invites
                "is it broken?" on demo day. */}
            <button
                type="button"
                disabled={exporting}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleExport}
                className="rounded bg-black px-3 py-1 text-sm text-white hover:bg-neutral-800 disabled:opacity-40"
            >
                {exporting ? "Exporting…" : "Export PDF"}
            </button>

            {exportError && (
                <span className="text-xs text-red-600">{exportError}</span>
            )}

            {dirty && (
                <span className="ml-auto text-xs text-neutral-500">
                    Unsaved changes
                </span>
            )}
            {padOpen && <SignaturePad onClose={() => setPadOpen(false)} />}
        </div>
    );
}