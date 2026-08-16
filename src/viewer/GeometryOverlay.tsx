/**
 * viewer/GeometryOverlay.tsx
 *
 * Dev-only. Draws every rect in detect-field.ts's geometry map on top of the
 * page, colour-coded by which detector produced it.
 *
 * ─── WHY THIS EXISTS BEFORE VERDICT MARKERS ──────────────────────────────
 * §14 step 1 is "render markers read-only", to validate edgeDistance's and
 * offsetMark's LTR branches against a rendered position for the first time
 * (§7.3). Verdict markers can do that — but only on the handful of lines the
 * model happened to answer on, and only after an API call with a real key.
 *
 * This shows all of them, for free, on any document. It is the visual
 * counterpart of smoke.ts: smoke prints what extraction concluded, this draws
 * where it concluded it. `mark offset: 5.60pt` is unfalsifiable as a number
 * and obvious as a picture — either the five boxes on W-9 line 3a land on the
 * five drawn boxes, or they stack on the first one.
 *
 * Verdict markers are then the same geometry with different colours, built
 * once placement is known good rather than debugged alongside it.
 *
 * ─── ⚠ POINTER-EVENTS: NONE, ALWAYS, WITH NO EXCEPTIONS ──────────────────
 * This sits between PdfTextLayer and AnnotationLayer. AnnotationLayer is
 * deliberately transparent to the mouse in select mode so the text layer keeps
 * its selection (§6.10), and an overlay that swallowed clicks would break both
 * — text selection AND annotation placement — in a way that looks like a bug
 * in those files rather than in this one.
 *
 * So: `pointerEvents: "none"` on the container and nothing inside re-enables
 * it. That is the difference from AnnotationLayer, where individual
 * annotations set `pointerEvents: auto` on themselves. Nothing here is
 * clickable, which is also why it needs no `data-editor-chrome`.
 *
 * ─── COORDINATES ─────────────────────────────────────────────────────────
 * Every rect goes through coordinates.ts's pdfRectToCss. No arithmetic on
 * viewport.scale in this file, and no second conversion — §5.1 makes
 * coordinates.ts the only place the two systems meet, and a debug tool that
 * did its own maths could agree with itself while disagreeing with the editor,
 * which is the one failure that would make it worse than useless.
 */

import { useEffect, useMemo, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import type { DetectionResult, FieldGeometry, MarkSource } from "../copilot/detect-field";
import { pdfRectToCss } from "./coordinates";

interface Props {
    /** 1-indexed, matching pdf.js. */
    pageNumber: number;
    /** CSS-space viewport — the same object AnnotationLayer uses. */
    viewport: PageViewport;
    /** Null when the document couldn't be read. Nothing renders. */
    detection: DetectionResult | null;
}

/**
 * What is drawn.
 *
 * "fields" is refs only: rects a detector actually produced. "all" adds the
 * per-line calibrated fallbacks, of which there is one for EVERY line — 228 on
 * the W-9 — so they carpet the page and are off by default. They matter when
 * checking a line that has no box drawn beside it, which on the Harel fixture
 * is the whole point of calibration (§8.10).
 */
type Mode = "off" | "fields" | "all";

const MODES: Mode[] = ["off", "fields", "all"];

/** Cycles the overlay. Guarded against firing while typing — see the effect. */
const TOGGLE_KEY = "g";

const SOURCE_COLOURS: Record<MarkSource, string> = {
    checkbox: "#2563eb",   // blue
    comb: "#7c3aed",       // violet
    literal: "#059669",    // green — has never appeared; see §8.24
    leader: "#d97706",     // amber
    gap: "#dc2626",        // red
    calibrated: "#94a3b8", // slate, deliberately faint
};

export function GeometryOverlay({ pageNumber, viewport, detection }: Props) {
    const [mode, setMode] = useState<Mode>("off");

    // Which entries are real detections rather than per-line fallbacks.
    // Ref ids are "p1l3f0" and line ids are "p1l3", so they cannot collide —
    // but deriving membership from the payload rather than parsing the string
    // means a change to the id format can't silently reclassify everything.
    const refs = useMemo(() => {
        const set = new Set<string>();
        for (const line of detection?.payload ?? []) {
            for (const field of line.fields ?? []) set.add(field.ref);
        }
        return set;
    }, [detection]);

    const entries = useMemo(() => {
        if (!detection || mode === "off") return [];

        return [...detection.geometry.values()].filter(
            (entry) =>
                entry.page === pageNumber && (mode === "all" || refs.has(entry.id)),
        );
    }, [detection, mode, pageNumber, refs]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() !== TOGGLE_KEY) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            // ⚠ Same guard AnnotationLayer uses, for the same reason (§6.10).
            // Without it, typing the letter g in the API key field or the
            // question box toggles a debug overlay. That guard is why this is
            // a keydown listener rather than something cleverer.
            const target = e.target as HTMLElement | null;
            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target?.isContentEditable
            ) {
                return;
            }

            setMode((current) => MODES[(MODES.indexOf(current) + 1) % MODES.length]);
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    if (!detection || mode === "off") return null;

    return (
        <div
            className="absolute left-0 top-0"
            style={{
                width: viewport.width,
                height: viewport.height,
                // ⚠ NEVER "auto". See the header.
                pointerEvents: "none",
            }}
        >
            {entries.map((entry) => (
                <EntryView key={entry.id} entry={entry} viewport={viewport} />
            ))}

            <Legend count={entries.length} mode={mode} />
        </div>
    );
}

/**
 * One geometry entry: its mark rect, plus its cells when it is a comb.
 *
 * Cells are drawn individually and NUMBERED, which is the only reason this
 * component is more than a coloured box. §8.11 warns that cellRects indexes
 * left to right geometrically, so on an RTL form a 9-digit ID must fill index
 * 8 down to 0 — and filling 0 upward writes it mirrored while looking entirely
 * plausible. Numbering the cells makes the indexing visible BEFORE anything
 * writes into them, which is the only cheap moment to catch it.
 */
function EntryView({ entry, viewport }: { entry: FieldGeometry; viewport: PageViewport }) {
    const colour = SOURCE_COLOURS[entry.source];
    const rect = pdfRectToCss(viewport, entry.markRect);

    return (
        <>
            <div
                className="absolute"
                style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    border: `1px solid ${colour}`,
                    // Dashed when the rect was calculated rather than measured
                    // from a shape on the page — the same distinction
                    // fromDrawnShape carries, made visible.
                    borderStyle: entry.fromDrawnShape ? "solid" : "dashed",
                    background: `${colour}22`,
                }}
            />

            {entry.cells?.map((cell, index) => {
                const cellRect = pdfRectToCss(viewport, cell);

                return (
                    <div
                        key={index}
                        className="absolute flex items-center justify-center"
                        style={{
                            left: cellRect.left,
                            top: cellRect.top,
                            width: cellRect.width,
                            height: cellRect.height,
                            border: `1px solid ${colour}`,
                            fontSize: Math.min(cellRect.height * 0.6, 10),
                            lineHeight: 1,
                            color: colour,
                        }}
                    >
                        {index}
                    </div>
                );
            })}
        </>
    );
}

/**
 * Fixed to the page's top-left rather than the window, so it scrolls and zooms
 * with the page it describes and can't overlap the copilot panel.
 */
function Legend({ count, mode }: { count: number; mode: Mode }) {
    return (
        <div
            className="absolute left-1 top-1 rounded bg-white/90 p-1 text-[10px] leading-tight shadow"
            style={{ pointerEvents: "none" }}
        >
            <div className="font-medium">
                geometry · {mode} · {count}
            </div>
            {Object.entries(SOURCE_COLOURS).map(([source, colour]) => (
                <div key={source} className="flex items-center gap-1">
                    <span
                        className="inline-block h-2 w-2"
                        style={{ background: colour }}
                    />
                    {source}
                </div>
            ))}
            <div className="mt-1 text-slate-500">dashed = calculated</div>
        </div>
    );
}