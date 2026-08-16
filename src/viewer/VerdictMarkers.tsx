/**
 * viewer/VerdictMarkers.tsx
 *
 * §9.4 — draws a marker on every line the copilot said to FILL IN, at the
 * coordinates detect-field.ts already computed.
 *
 * ─── READ-ONLY, AND THAT IS THE FINAL ANSWER ─────────────────────────────
 * Click-to-prefill is CUT, on product grounds, not time (§9.4). The user
 * places the value with the existing text / symbol / signature tools. The AI's
 * answer and the place you act on it are still the same interface, which is
 * the product claim — it does not require the tool to type for you.
 *
 * Two hazards die with that decision and should stay dead: §6.4's "a text box
 * mounts with content already in it" path, which has never executed, and
 * §8.11's mirrored-ID risk, which needed something to write into comb cells
 * programmatically. If prefill is ever revived, both come back first.
 *
 * ─── ONLY "fill" IS DRAWN ────────────────────────────────────────────────
 * Not skip, not unclear. On a bureaucratic form most lines are skips, and
 * drawing them buries the two or three things the user actually has to do
 * under a page of grey boxes. Nothing is lost: the panel lists every verdict
 * with its reason, including every skip, and that list is the discoverability
 * mechanism (§6.12). This layer answers a narrower question — "where do I put
 * my pen" — and answering it quietly is the point.
 *
 * ─── ⚠ WHICH RECT, WHEN A LINE HAS SIX ───────────────────────────────────
 * Classifications key by ref where the model gave one and by LINE where it
 * didn't, and a line can carry many fields. W-9 line 3a is one line with six:
 * five checkboxes and a gap writeIn (§8.26). Three rules, in order, and the
 * last one is the important one:
 *
 *   1. If the verdict names a ref, use that rect. classify.ts has already
 *      validated the ref against that line's own refs (§8.27).
 *   2. Otherwise take the highest-priority source present — measured ink
 *      before calculated position, which is what fromDrawnShape already
 *      encodes.
 *   3. UNLESS rule 2 is ambiguous: several rects of the winning source and no
 *      ref to choose between them. Then draw NOTHING. A mark on the wrong one
 *      of five identical checkboxes is invisible to the user and wrong on
 *      their form (§8.22); an absent mark is merely unhelpful, and the panel
 *      row still carries the advice.
 *
 * ─── ⚠ POINTER-EVENTS: NONE ──────────────────────────────────────────────
 * Same rule as GeometryOverlay, same reason (§6.10): AnnotationLayer is
 * transparent to the mouse in select mode so PdfTextLayer keeps its selection,
 * and anything clickable underneath it breaks both. Since prefill is cut,
 * nothing here will ever become clickable — which is also why this layer needs
 * no `data-editor-chrome`.
 */

import { useMemo } from "react";
import type { PageViewport } from "pdfjs-dist";
import type { DetectionResult, FieldGeometry, MarkSource } from "../copilot/detect-field";
import type { GeometryRect } from "../copilot/extract-geometry";
import type { FieldClassification } from "../copilot/classify";
import { pdfRectToCss } from "./coordinates";

interface Props {
    /** 1-indexed, matching pdf.js. */
    pageNumber: number;
    /** CSS-space viewport — the same object AnnotationLayer uses. */
    viewport: PageViewport;
    /** Null when the document couldn't be read. */
    detection: DetectionResult | null;
    /**
     * Keyed by `ref ?? id` — per FIELD where the model named one, per LINE
     * where it didn't (§8.36). It was keyed by line id until the store was
     * fixed, which silently collapsed the three verdicts on Harel's עמית row
     * into one.
     */
    classifications: Map<string, FieldClassification>;
    /**
     * The LINE id of the panel row the user last clicked, or null.
     *
     * A line id (`p1l14`), never a ref — a row is a line, and the highlight
     * answers "which line is this row about", not "which field". See
     * FocusBand for why this lives here rather than in its own overlay.
     */
    focusedLineId?: string | null;
}

/**
 * Measured ink first, calculated position last.
 *
 * A checkbox rect came from a shape on the page; a calibrated rect is where a
 * box WOULD have been if one had been drawn (§8.10). When a line offers both,
 * the drawn one is the better answer, and this ordering is the same judgement
 * `fromDrawnShape` already records — kept as an explicit list because the
 * boolean can't express the ordering WITHIN measured sources.
 */
const SOURCE_PRIORITY: MarkSource[] = [
    "checkbox",
    "comb",
    "literal",
    "leader",
    "gap",
    "calibrated",
];

/**
 * ─── CAPTION GEOMETRY (§8.37) ────────────────────────────────────────────
 * All four are CSS pixels and all four are about the PAGE's edges, not the
 * document's content — so unlike everything in detect-field.ts they are
 * legitimately constants. They tune where a label sits relative to a box the
 * browser has already positioned; nothing here is derived from, or should be
 * derived from, the PDF.
 */
const CAPTION_MAX_WIDTH = 220;
const CAPTION_MIN_WIDTH = 44;
const CAPTION_GAP = 4;
/** Roughly the caption's own rendered height at text-[10px] + py-0.5. */
const CAPTION_HEIGHT = 14;

export function VerdictMarkers({
    pageNumber,
    viewport,
    detection,
    classifications,
    focusedLineId = null,
}: Props) {
    const markers = useMemo(() => {
        if (!detection) return [];

        const results: Array<{ key: string; rect: FieldGeometry; label: string }> = [];

        for (const verdict of classifications.values()) {
            // Only "fill". See the header — skips and unclears live in the
            // panel, which is where a list belongs.
            if (verdict.fill !== "fill") continue;

            const entry = resolveRect(detection, verdict);
            if (!entry || entry.page !== pageNumber) continue;

            results.push({
                // ⚠ NOT verdict.id. Three verdicts on the עמית row share one
                // line id, and duplicate React keys there silently drop two of
                // the three markers — the same §8.12 line-vs-run bug, arriving
                // for a fourth time through the rendering layer.
                key: verdict.ref ?? verdict.id,
                rect: entry,
                label: markerLabel(detection, verdict),
            });
        }

        return results;
    }, [detection, classifications, pageNumber]);

    /**
     * ─── THE FOCUS BAND (§9.4, second half) ──────────────────────────────
     * Markers only draw on `fill` verdicts, and resolveRect deliberately draws
     * NOTHING when a line offers several identical rects and the model named
     * no ref. So there are lines the copilot has a real answer for that carry
     * no mark at all: every skip, every unclear, and the ambiguous fills.
     *
     * For those the panel says "this line" and leaves the user to find it,
     * which is the problem §2 says this product exists to solve, surviving in
     * miniature. Clicking the row now says where.
     *
     * Keyed by LINE id, so it reads the per-line fallback entry — the one
     * detect-field guarantees exists for every line, including the
     * התחלתי לעבוד clause that no detector tagged.
     */
    const focus = focusedLineId ? detection?.geometry.get(focusedLineId) : undefined;
    const focusBand = focus && focus.page === pageNumber ? focus.lineRect : null;

    if (markers.length === 0 && !focusBand) return null;

    return (
        <div
            className="absolute left-0 top-0 overflow-hidden"
            style={{
                width: viewport.width,
                height: viewport.height,
                // ⚠ NEVER "auto". See the header.
                pointerEvents: "none",
            }}
        >
            {/* FIRST, so a marker on the focused line still draws over it.
                The band is a wash rather than an outline: an outline around a
                whole line of Hebrew competes with the marker boxes, and the
                thing being communicated here is "over here", not "exactly
                this rectangle". */}
            {focusBand && <FocusBand rect={focusBand} viewport={viewport} />}

            {markers.map(({ key, rect, label }) => (
                <Marker key={key} entry={rect} label={label} viewport={viewport} />
            ))}
        </div>
    );
}

/**
 * Which rect this verdict points at, or null when the answer is ambiguous.
 *
 * Returning null is a real answer here, not a failure — see rule 3 in the
 * header. The caller draws nothing, and the panel row still carries the
 * advice, so an ambiguous line degrades to exactly the behaviour before
 * markers existed.
 */
function resolveRect(
    detection: DetectionResult,
    verdict: FieldClassification,
): FieldGeometry | null {
    // 1. The model named a field. classify.ts validated it against this line's
    //    own refs, so a ref that survives to here is trustworthy (§8.27).
    if (verdict.ref) {
        return detection.geometry.get(verdict.ref) ?? null;
    }

    const line = detection.payload.find((l) => l.id === verdict.id);

    // A line with no detected fields still has its per-line calibrated
    // fallback, which is the entry keyed by the line id itself. This is the
    // התחלתי לעבוד case: an option with no box printed beside it, which the
    // model finds from the text and calibration places (§8.10, §3.1).
    if (!line?.fields?.length) {
        return detection.geometry.get(verdict.id) ?? null;
    }

    // 2. Highest-priority source present on this line.
    for (const source of SOURCE_PRIORITY) {
        const matching = line.fields
            .map((f) => detection.geometry.get(f.ref))
            .filter((entry): entry is FieldGeometry => entry?.source === source);

        if (matching.length === 0) continue;

        // 3. Ambiguous: several rects of the winning source and nothing to
        //    choose between them. Five identical checkboxes and no ref is
        //    exactly §8.22, and a wrong mark there is invisible.
        return matching.length === 1 ? matching[0] : null;
    }

    return detection.geometry.get(verdict.id) ?? null;
}

/**
 * What the marker says beside itself.
 *
 * ⚠ THE CAPTION MUST NOT DEPEND ON THE MODEL ALONE (§8.37). Prompt rule 9 —
 * "never leave value_or_instruction empty on a fill" — does not hold run to
 * run: one run returned a value on every marker, the next returned empty
 * strings throughout, same prompt and same context. The field's own `label` is
 * deterministic, comes from the document, and has been verified (§8.22), so it
 * is the thing to fall back to.
 *
 * ─── WHICH ONE WINS DEPENDS ON THE FIELD KIND, AND THAT IS DELIBERATE ────
 * The caption's job is to answer the question the field poses:
 *
 *   checkbox — "which of these do I tick?" The action is a tick; the content
 *     is worthless. The label ("C corporation", "משיכה מלאה") identifies the
 *     option, so the label wins.
 *
 *   cells / writeIn — "what do I write here?" The label is the question, not
 *     the answer. Captioning Harel's ID comb "מס' הזהות" tells the user what
 *     they already read on the form; captioning it `039274865` is the entire
 *     point of §8.32. So the value wins.
 *
 * Either way the other one is the fallback, so an empty value never produces
 * an empty caption and a missing label never loses the value.
 */
function markerLabel(detection: DetectionResult, verdict: FieldClassification): string {
    const line = detection.payload.find((l) => l.id === verdict.id);
    const field = verdict.ref
        ? line?.fields?.find((f) => f.ref === verdict.ref)
        : undefined;

    const label = field?.label?.trim() ?? "";
    const value = verdict.value_or_instruction.trim();

    if (field?.kind === "checkbox") return label || value;

    return value || label;
}

/**
 * A soft wash over the line a panel row refers to.
 *
 * Amber rather than the markers' green, deliberately: green means "the copilot
 * says do something here", and reusing it for "you clicked a row" would make
 * a skip look like an action. Different question, different colour.
 *
 * No animation. A pulse would draw the eye on a projector, but it also draws
 * it away from whatever is being said at the time, and this fires on every row
 * click — including the fifteen skips someone scrolls past.
 */
function FocusBand({
    rect,
    viewport,
}: {
    rect: GeometryRect;
    viewport: PageViewport;
}) {
    const css = pdfRectToCss(viewport, rect);

    return (
        <div
            className="absolute rounded-sm"
            style={{
                left: css.left,
                top: css.top,
                width: css.width,
                height: css.height,
                background: "#f59e0b33",
                outline: "1px solid #f59e0b66",
            }}
        />
    );
}

/**
 * One marker: an outline on the rect, and a caption beside it.
 *
 * The caption is positioned in CSS pixels from the rect's own converted
 * position rather than given its own coordinate conversion — coordinates.ts
 * stays the only place points and pixels meet (§5.1), and a caption that did
 * its own arithmetic could drift from the box it describes at some zoom levels
 * only, which is the worst kind of bug to find. Everything below is CSS-space
 * arithmetic on values pdfRectToCss has already produced.
 *
 * ─── ⚠ THE CAPTION USED TO RUN OFF THE PAGE (§8.37) ──────────────────────
 * It was `whitespace-nowrap` at `left: rect.left` with no width limit. On an
 * RTL form the rect sits near the page's RIGHT edge, so a long Hebrew caption
 * — `כספי פיצויים – מבקש למשוך את סך כל הכספים ששולמו לרכיב פיצויים` — ran off
 * the page, across the copilot panel and over the ask box. It looked broken at
 * the exact moment the best feature fired.
 *
 * Three things fix it, and all three are needed:
 *
 *   1. ANCHOR ON THE SIDE THE TEXT COMES FROM. RTL captions are pinned by
 *      their right edge to the rect's right edge, so they grow leftward into
 *      the page instead of rightward off it.
 *
 *      ⚠ The direction comes from `entry.dir`, which detect-field.ts copies
 *      off the LINE the field was matched to — the same value edgeDistance and
 *      offsetMark already use to decide which side a mark goes on (§8.9). It
 *      is NOT derived from the coordinate. `markRect.x > viewport.width / 2`
 *      was the cheap proxy on offer and it is wrong on exactly the row that
 *      matters: Harel's 9-cell מס' הזהות comb spans a wide band, so its
 *      left-hand cells sit below the midpoint and would anchor the opposite
 *      way from the rest of the same comb.
 *
 *   2. A WIDTH LIMIT, clamped to the room actually left between the anchor and
 *      the far edge of the page. Truncated with an ellipsis rather than
 *      wrapped: a wrapped caption grows downward over the next field, and the
 *      panel row carries the full text anyway.
 *
 *   3. FLIP BELOW THE RECT WHEN THERE IS NO ROOM ABOVE. A field on the top
 *      line of a page had its caption at a negative `top`, which is the same
 *      bug on the other axis.
 *
 * The parent also clips, so nothing can escape the page even if all three miss
 * a case nobody has hit yet.
 */
function Marker({
    entry,
    label,
    viewport,
}: {
    entry: FieldGeometry;
    label: string;
    viewport: PageViewport;
}) {
    const rect = pdfRectToCss(viewport, entry.markRect);
    const rtl = entry.dir === "rtl";

    // Room between the caption's anchored edge and the far edge of the page.
    const available = rtl ? rect.left + rect.width : viewport.width - rect.left;
    const maxWidth = Math.max(
        CAPTION_MIN_WIDTH,
        Math.min(CAPTION_MAX_WIDTH, available - CAPTION_GAP),
    );

    const roomAbove = rect.top >= CAPTION_HEIGHT + CAPTION_GAP;
    const captionTop = roomAbove
        ? rect.top - CAPTION_HEIGHT
        : rect.top + rect.height + CAPTION_GAP;

    // Anchored by one edge only — setting both would stretch the box to the
    // rect's width, and a checkbox rect is nine points wide.
    const anchor = rtl
        ? { right: Math.max(0, viewport.width - (rect.left + rect.width)) }
        : { left: Math.max(0, rect.left) };

    return (
        <>
            <div
                className="absolute rounded-sm"
                style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    border: "2px solid #059669",
                    background: "#05966922",
                    // Dashed when the position was calculated rather than
                    // measured from ink on the page. The user is entitled to
                    // know which marks we are sure about (§8.10).
                    borderStyle: entry.fromDrawnShape ? "solid" : "dashed",
                }}
            />

            {label && (
                <div
                    className="absolute overflow-hidden rounded bg-emerald-600 px-1 py-0.5 text-[10px] leading-none text-white shadow"
                    style={{
                        ...anchor,
                        top: captionTop,
                        maxWidth,
                        // nowrap AND ellipsis together: the ellipsis only
                        // renders on a single line, and a wrapped caption
                        // covers the field below it.
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                    }}
                    // The value may be in the form's script while the UI is
                    // English (§9.3's language rule), so the browser decides
                    // direction per caption rather than inheriting one. It also
                    // puts the ellipsis on the correct end of a Hebrew string.
                    dir="auto"
                >
                    {label}
                </div>
            )}
        </>
    );
}