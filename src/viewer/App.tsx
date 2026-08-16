import { useState, useEffect } from "react";
import { loadPdf, type LoadedPdf } from "./pdf-setup";
import { PdfPage } from "./PdfPage";
import { Toolbar } from "./ToolBar";
import { useAnnotationStore } from "./useAnnotationStore";
import { runExtraction, type Extraction } from "../copilot/run-extraction";
import { verifyExtraction } from "../copilot/verify";
import { CopilotPanel } from "../copilot/CopilotPanel";
import { copilotStore, useCopilotStore } from "../copilot/copilotStore";


const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const ZOOM_STEP = 10;

export function App() {
    const [pdf, setPdf] = useState<LoadedPdf | null>(null);
    const [pageNumber, setPageNumber] = useState(1);
    /**
     * Which line the panel last pointed at, or null.
     *
     * A LINE id (`p1l14`), never a ref — a panel row is a line. Lives here
     * rather than in copilotStore because it is view state about where the
     * user is looking, not a result: it must survive a failed classification
     * and must NOT be reset by resetResults, which clears answers.
     *
     * ⚠ Line ids are array positions and shift on every re-extraction (§8.14),
     * so this is cleared in openFile alongside the extraction itself. A stale
     * id would band a completely unrelated line on the new document.
     */
    const [focusedLineId, setFocusedLineId] = useState<string | null>(null);
    const [zoomPercent, setZoomPercent] = useState(120);
    const [error, setError] = useState<string | null>(null);
    const [extraction, setExtraction] = useState<Extraction | null>(null);

    const scale = zoomPercent / 100;

    const dirty = useAnnotationStore((s) => s.dirty);
    const annotationCount = useAnnotationStore((s) => s.annotations.length);
    const classifications = useCopilotStore((s) => s.classifications);

    /**
 * Warn before losing work. Nothing persists — annotations are in-memory for
 * the tab's lifetime (§8) — so a refresh or tab close is unrecoverable.
 *
 * The count guard matters: a stray click places a box and the empty-commit
 * removes it, and both set dirty. Without it you get a warning over a
 * document with nothing in it.
 */
    useEffect(() => {
        if (!dirty || annotationCount === 0) return;

        const handler = (e: BeforeUnloadEvent) => {
            // Chrome shows its own generic text — it can't be customised, and
            // returning a string no longer does anything.
            e.preventDefault();
        };

        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [dirty, annotationCount]);


    async function openFile(file: File) {
        setError(null);
        setExtraction(null);          // clear before, so a failed open can't leave stale fields on screen
        setFocusedLineId(null);       // §8.14 — ids are array positions and do not survive a re-extraction
        copilotStore.getState().resetResults();
        try {
            const buffer = await file.arrayBuffer();
            const loaded = await loadPdf(new Uint8Array(buffer), file.name);

            // The safe window: loadPdf has resolved, setPdf hasn't run, so PdfPage
            // has not mounted and nothing else holds a page proxy (§8.6).
            const result = await runExtraction(loaded.doc);
            if (import.meta.env.DEV) verifyExtraction(result);

            setExtraction(result);
            setPdf(loaded);
            setPageNumber(1);
        } catch (err) {
            setPdf(null);
            setError(err instanceof Error ? err.message : "Failed to open PDF");
        }
    }

    function handleDragOver(e: React.DragEvent<HTMLElement>) {
        e.preventDefault();
    }

    function handleDragLeave() {
        //hover style
    }

    function handleDrop(e: React.DragEvent<HTMLElement>) {
        e.preventDefault();

        const file = e.dataTransfer.files[0];

        if (file) {
            openFile(file);
        }
    }

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];

        if (file) {
            openFile(file);
        }

        // Allows selecting the same file again.
        e.target.value = "";
    }

    function previousPage() {
        setPageNumber((current) => Math.max(1, current - 1));
    }

    function nextPage() {
        if (!pdf) return;

        setPageNumber((current) => Math.min(pdf.doc.numPages, current + 1));
    }

    function zoomOut() {
        setZoomPercent((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP));
    }

    function zoomIn() {
        setZoomPercent((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP));
    }

    if (!pdf) {
        return (
            <main
                className="flex h-screen items-center justify-center bg-gray-100 p-8"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <div className="w-full max-w-xl rounded-xl border-2 border-dashed border-gray-400 bg-white p-12 text-center">
                    <h1 className="mb-3 text-2xl font-semibold">PDF Copilot</h1>

                    <p className="mb-6 text-gray-600">
                        Drop a PDF here or choose a file from your computer.
                        Your file stays on your machine.
                    </p>

                    <label className="inline-block cursor-pointer rounded-lg bg-black px-5 py-3 text-white hover:bg-gray-800">
                        Choose PDF
                        <input
                            type="file"
                            accept="application/pdf"
                            className="hidden"
                            onChange={handleFileChange}
                        />
                    </label>

                    {error && (
                        <p className="mt-5 text-sm text-red-600">{error}</p>
                    )}
                </div>
            </main>
        );
    }

    return (

        <main className="flex h-screen flex-col bg-gray-100">
            <header data-editor-chrome className="flex shrink-0 items-center gap-4 border-b bg-white px-6 py-3">

                <p className="mr-auto truncate font-medium">{pdf.name}</p>

                <button
                    type="button"
                    onClick={previousPage}
                    disabled={pageNumber === 1}
                    className="rounded border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    ←
                </button>

                <span className="text-sm whitespace-nowrap">
                    Page {pageNumber} of {pdf.doc.numPages}
                </span>
                {extraction && (
                    <span data-editor-chrome className="text-sm text-gray-500">
                        {!extraction.readable
                            ? "No text layer"
                            : `${extraction.detection.payload.filter((l) => l.fields).length} tagged / ${extraction.detection.payload.length} lines`}
                    </span>
                )}
                <button
                    type="button"
                    onClick={nextPage}
                    disabled={pageNumber === pdf.doc.numPages}
                    className="rounded border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    →
                </button>

                <button
                    type="button"
                    onClick={zoomOut}
                    disabled={zoomPercent === MIN_ZOOM}
                    className="rounded border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    −
                </button>

                <span className="min-w-14 text-center text-sm">
                    {zoomPercent}%
                </span>

                <button
                    type="button"
                    onClick={zoomIn}
                    disabled={zoomPercent === MAX_ZOOM}
                    className="rounded border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    +
                </button>
            </header>

            <Toolbar pdf={pdf} />

            {/* ⚠ THE PANEL IS A SIBLING OF THE SCROLL AREA, NOT A CHILD OF IT.
                It used to sit inside the scrolling <section>, which made it a
                flex item alongside the canvas — and with align-items: stretch
                the flex line grows to the TALLEST item, so the aside stretched
                toward the PDF page's height rather than the viewport's. At
                120% zoom that squeezed the list to a couple of rows; past
                ~150% the question box scrolls off the bottom of the document
                and is unreachable.

                overflow-hidden on the wrapper is what gives the aside a
                definite height, which is what makes its own flex-1 + auto
                list actually scroll. Removing it silently restores the bug. */}
            <div className="flex flex-1 overflow-hidden">
                <section className="flex flex-1 justify-center overflow-auto p-8">
                    <PdfPage
                        doc={pdf.doc}
                        pageNumber={pageNumber}
                        scale={scale}
                        detection={extraction?.detection ?? null}
                        classifications={classifications}
                        focusedLineId={focusedLineId}
                    />
                </section>

                <CopilotPanel
                    extraction={extraction}
                    pageNumber={pageNumber}
                    onSelectPage={setPageNumber}
                    onFocusLine={setFocusedLineId}
                    focusedLineId={focusedLineId}
                />
            </div>
        </main>
    );
}
