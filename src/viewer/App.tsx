import { useState, useEffect } from "react";
import { loadPdf, type LoadedPdf } from "./pdf-setup";
import { PdfPage } from "./PdfPage";
import { Toolbar } from "./ToolBar";
import { useAnnotationStore } from "./useAnnotationStore";

const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const ZOOM_STEP = 10;

export function App() {
    const [pdf, setPdf] = useState<LoadedPdf | null>(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [zoomPercent, setZoomPercent] = useState(120);
    const [error, setError] = useState<string | null>(null);

    const scale = zoomPercent / 100;

    const dirty = useAnnotationStore((s) => s.dirty);
    const annotationCount = useAnnotationStore((s) => s.annotations.length);

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

        try {
            const buffer = await file.arrayBuffer();
            const loaded = await loadPdf(new Uint8Array(buffer), file.name);

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

            <section className="flex flex-1 justify-center overflow-auto p-8">
                <PdfPage doc={pdf.doc} pageNumber={pageNumber} scale={scale} />
            </section>
        </main>
    );
}
