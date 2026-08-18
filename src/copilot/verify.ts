/**
 * copilot/verify.ts
 *
 * Prints the extraction baseline in the browser console and marks each row PASS
 * or FAIL against values measured in Node on pdfjs-dist 6.2.108.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN "LOOK AT THE CONSOLE": every failure mode in the
 * extraction layer produces PLAUSIBLE numbers, not obviously broken ones. The
 * operator-list format changing yields zero shapes, not an error. A slightly
 * wrong comb tolerance reports 8 cells for a 9-digit ID. A hasEOL assumption
 * failing yields one line per page. None of those announce themselves, and
 * reading a number and thinking "yeah, about right" is how they survive to demo
 * day.
 *
 * ⚠ A MISMATCH HERE MEANS SOMETHING ENVIRONMENTAL — the browser build, the
 * bundled worker, a resolved pdfjs version other than 6.2.108 — because the same
 * code produces the expected column in Node. Check package resolution before
 * changing any detector.
 *
 * ⚠ FIXTURE-BOUND AND DEV-ONLY. It hardcodes one document's numbers and is
 * meaningless on any other file. smoke.ts is the generic cousin.
 */

import type { Extraction } from "./run-extraction";

/** Measured in Node against the Hebrew fixture, pdfjs-dist 6.2.108. */
const EXPECTED: Record<string, string> = {
    "Pages": "3",
    "Lines per page": "52 / 48 / 24",
    "Derived checkbox size": "8",
    "Checkboxes per page": "12 / 1 / 7",
    "Leaders per page": "4 / 8 / 0",
    "Comb cell counts": "6,9 · 9,9,9 · —",
    "Flagged Latin (distinct/occurrences)": "5 / 9",
    "HSBC flagged": "no",
};

export function verifyExtraction(extraction: Extraction | null): void {
    if (!extraction) {
        console.error("[verify] extraction returned null — nothing to check.");
        return;
    }

    const { pages, geometry } = extraction;
    const actual: Record<string, string> = {};

    actual["Pages"] = String(pages.length);
    actual["Lines per page"] = pages.map((p) => p.lines.length).join(" / ");
    actual["Derived checkbox size"] = String(geometry.checkboxSize ?? "null");
    actual["Checkboxes per page"] = geometry.pages.map((p) => p.checkboxes.length).join(" / ");
    actual["Leaders per page"] = geometry.pages.map((p) => p.leaders.length).join(" / ");

    // Sorted: detection order within a page isn't guaranteed stable, and an
    // ordering change is not a regression worth failing on.
    actual["Comb cell counts"] = geometry.pages
        .map((p) =>
            p.combs.length === 0
                ? "—"
                : p.combs.map((c) => c.cellCount).sort((a, b) => a - b).join(","),
        )
        .join(" · ");

    // Suspect ranges are per character range inside a run, so the words have to be
    // sliced back out rather than read off a flag.
    const flagged = new Map<string, number>();
    for (const page of pages) {
        for (const line of page.lines) {
            for (const run of line.runs) {
                for (const range of run.suspectRanges) {
                    const word = run.text.slice(range.start, range.end);
                    flagged.set(word, (flagged.get(word) ?? 0) + 1);
                }
            }
        }
    }

    const occurrences = [...flagged.values()].reduce((a, b) => a + b, 0);
    actual["Flagged Latin (distinct/occurrences)"] = `${flagged.size} / ${occurrences}`;

    // ⚠ The expensive false positive. HSBC sits in the bank-details section — the
    // one place on this form where a wrong value costs the user money, and the one
    // place a spurious "we couldn't read this" does real damage.
    actual["HSBC flagged"] = flagged.has("HSBC") ? "YES — REGRESSION" : "no";

    const rows: Record<string, { expected: string; actual: string; result: string }> = {};
    let failures = 0;

    for (const key of Object.keys(EXPECTED)) {
        const pass = actual[key] === EXPECTED[key];
        if (!pass) failures++;

        rows[key] = { expected: EXPECTED[key], actual: actual[key], result: pass ? "PASS" : "FAIL" };
    }

    console.table(rows);

    if (failures > 0) {
        console.error(
            `[verify] ${failures} row(s) FAILED. Stop and find out why before building ` +
            `on top of this. Check the resolved pdfjs-dist version first — the ` +
            `expected column was measured on 6.2.108.`,
        );
    } else {
        console.log("[verify] all rows match the Node baseline.");
    }
}