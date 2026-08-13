# PDF Copilot — Project State & Session Handoff

**Phase 1 (editor): COMPLETE and stable.**
**Phase 2 (AI copilot): WORKING END TO END. Advice appears per field, on two
documents, in two scripts. No markers on the page yet.**

Next session starts at §9.4 or §9.7 (see §9.0 for the recommendation).
Read §1–3 for what this is, §7 for verification status, §8 for findings that
cost real time, §9 for what's left.

⚠ §8.14–§8.18 are new this session and contain the two findings most likely to
be rediscovered the hard way: the content stream is not in reading order, and
US forms build their boxes in a way no shape detector can see.

---

## 0. Status

Phase 2 works end to end. Extraction is verified in-browser, the AI call is
built, and advice appears per field on two documents in two scripts. Sections
9.1–9.3 are done; 9.4, 9.6 and 9.7 are not.

Roughly 75% of the way to a demo. What remains is one visual feature (§9.4),
two optional ones (§9.6, §9.7), rehearsal, and one unverified correctness
property (§9.3's language separation).

## 1. What this is

A browser extension that lets you edit and sign any PDF in-browser, then uses
AI to tell you — field by field — what to fill in, what to skip, and why,
based on your own stated situation. No server, no database, no accounts.

## 2. The problem it solves

Filling a bureaucratic form today (example: the Israeli Harel severance
withdrawal form used as the fixture) means uploading the PDF to an AI chat,
asking what to fill, getting prose back, then going to a _separate_ tool to
type into the PDF — working out yourself where each described field sits.

This extension collapses that into one flow: the AI's answer and the place you
act on it are the same interface, and the answer is tied to real coordinates
instead of prose you have to translate.

## 3. Core architecture decisions

**No backend, no database.** Nothing persists across sessions except the API
key. Strong privacy story: no document leaves the browser except as text sent
directly to the AI provider, and only when the copilot is used.

**BYOK.** User pastes their own key, stored in `chrome.storage.local`. The
extension calls the provider directly from the client.

**No auth system** — there's nothing to authenticate _to_.

**pdf.js for viewing/reading, pdf-lib for editing/export.**

**Don't re-upload the PDF to the AI.** Something has to map "fill in your name"
to an x/y position, and that has to be our client-side code. Local extraction
is needed regardless, so the cheap payload is free.

**Native AcroForm rendering left untouched.** True AcroForms already render as
interactive fields via pdf.js's AnnotationLayer. (Note: the Harel fixture has
`Form: none`. The W-9 test document also has no AcroForm. Phase 3 still has no
target document.)

### 3.1 Discovery is text-driven, geometry only enriches ✅ VALIDATED TWICE

The original plan made blank detection a **gate**: find the blank
geometrically, then ask the model about it. That is wrong, and two documents
now disprove it independently.

**Harel:** section ב has NINE eligibility clauses and only EIGHT checkboxes
(the clause beginning `התחלתי לעבוד במקום חדש` has no box drawn; confirmed by
rasterising). A gated design silently drops a real option.

**W-9 (§8.17):** the form draws no rectangles at all, so geometry finds 8
checkboxes and nothing else on a form that is mostly write-in fields. Line 1,
"Name of entity/individual", has no detectable affordance of any kind. **The
model returned "fill in" for it anyway.** Under the gated design the entire
form would have come back nearly empty.

This is now the strongest single argument for the architecture and worth
saying out loud in the demo.

**So: the model sees the whole document text and decides what the fields are.**
Geometry answers only "where exactly does a mark go, and how much room is
there." If every geometry detector returns nothing, the copilot still works —
every field is still found, explained, and listed. Only placement degrades.

Preserve that property. It is the reason the risky parts are deletable.

### 3.2 What goes to the model, and what never does

- **Coordinates never go.** `classify.ts`'s `buildUserMessage` re-projects each
  line field by field rather than spreading it, so a coordinate added to
  `PayloadLine` later cannot silently start being uploaded.
- **Cell counts DO go**, because they change the answer. "Nine cells, one
  character each" produces nine digits. A six-cell date wants DDMMYY, an
  eight-cell one wants DDMMYYYY.
- **Absence is NEVER asserted.** A line carries a tag or carries nothing, and
  nothing means _unknown_. The system prompt states this explicitly as rule 2,
  and the W-9 result above is that rule paying off.

---

## 4. Storage & security (know this cold for demo day)

Everything except the API key is in-memory and gone on tab close or refresh.
That includes the two context answers, which are the most personal thing in the
app.

- **No database anywhere.** `chrome.storage.local` is sandboxed to the
  extension by Chrome — not readable by other extensions or sites, not synced.
- **Not encrypted at rest.** Don't claim encryption. Say "sandboxed locally by
  Chrome," which is accurate. The UI copy already says exactly this.
- **Never log the API key**, including `console.log` while debugging. No file
  in `copilot/` logs it, including error paths. Keep it that way.
- **Minimal `host_permissions`**: the three provider APIs and nothing else.
- `web_accessible_resources` was REMOVED — extension pages are same-origin with
  their own resources, so `chrome.runtime.getURL()` needs no declaration. The
  block was exposing `fonts/*` to `<all_urls>` for no reason.
- UI copy present: don't use on a shared computer.

---

## 5. Phase 1 — what is built

```
src/
  background/     MV3 service worker
  state/          shared; must stay free of DOM and React
    annotations.ts        pure types, no imports
    annotationStore.ts    zustand/vanilla store
  viewer/
    App.tsx               session state, file intake, beforeunload guard,
                          extraction wiring, panel layout
    pdf-setup.ts          worker + cmap wiring, loadPdf()
    PdfPage.tsx           canvas render, owns the page wrapper
    PdfTextLayer.tsx      selectable transparent text overlay
    coordinates.ts        the ONLY place points and pixels convert
    useAnnotationStore.ts React binding for the vanilla store
    AnnotationLayer.tsx   overlay: placement, keyboard, deselect
    TextAnnotation.tsx / SymbolAnnotation.tsx / SignatureAnnotation.tsx
    SignaturePad.tsx      modal drawing canvas
    Toolbar.tsx
  editor/
    export.ts             pdf-lib flatten + download
public/fonts/     NotoSansHebrew-Regular.ttf + OFL.txt
```

Working end to end: viewer (any PDF, page-at-a-time, zoom 50–300%, text
selection), text tool, symbol tool, signature tool, export (flattens to a real
PDF, Hebrew and English both correct), unsaved-changes warning.

**Known drift, deliberately deferred:** annotation components live in
`viewer/`, not `editor/` as originally planned. Left unresolved. Phase 2 lives
in `copilot/` so it doesn't have to pick a side.

### 5.1 Invariants that must not be broken

**Geometry is PDF points**, y = bottom edge, origin bottom-left. Screen pixels
never enter the store. `coordinates.ts` is the only place the two systems meet.

**Text is stored in logical order**, exactly as typed. Visual reordering
happens once, in the export path.

**Annotations are a flat array**; array order is z-order. The export path must
iterate in the same order — don't sort.

**Selection is two fields.** `selectedId` = has handles, Delete removes it.
`editingId` = caret inside, Delete types a character. Collapsing them makes
Backspace delete the box you're typing in.

**`state/` stays free of DOM and React imports** so the background worker can
import it. `copilot/` is NOT bound by this — nothing in the worker needs it.

---

## 6. Phase 1 findings — compressed, still load-bearing

### 6.1 fontkit silently reverses digits inside Hebrew ⚠ LOAD-BEARING

`fontkit` reverses Hebrew glyph order naively — whole string, not the bidi
algorithm. Pure Hebrew comes out right by accident. But `רחוב הרצל 45` exports
as `54`, and an account number exports backwards.

Fix needs both halves: `bidi-js` `getReorderedString()` for correct
logical→visual ordering, then force fontkit to `"ltr"` so it doesn't reverse
the already-correct output again. Lives in `editor/export.ts`.

**Keep the DO NOT REMOVE comment on `ltrFontkit`.** The published
`@pdf-lib/fontkit` types declare `layout(str, features?)` while the real
function takes five arguments, so the patch needs two casts and looks like
cruft. The comment is what saves it.

**Test:** export `חשבון 935921908 בבנק HSBC`, open in **Adobe Reader** (not
Chrome), confirm digits read left-to-right in order. Pure Hebrew proves nothing.

### 6.2 RTL export alignment

`drawText` runs left-to-right from `x`. The editor right-aligns RTL text via
`dir="auto"`. Export mirrors it: measure with `font.widthOfTextAtSize`, start
from `rect.x + rect.width - width` when the line's first strongly directional
character is Hebrew or Arabic. **The direction test must run on the logical
string, not the reordered one.**

Consequence: box width affects where text lands. If placement looks off, check
box width before suspecting the alignment code.

### 6.3 The text box grows, it never wraps

A browser soft-wrap inserts no `\n`, so export (which splits on `\n`) draws a
wrapped box as one long line off the page. Fixed by making the box grow:
`white-space: pre` + `wrap="off"`, both dimensions measured from content.

This is why there is **no resize handle on the text box** — a manual width
would be overwritten on the next edit and reintroduce the bug. Signatures have
a proportional resize handle; symbols have none.

### 6.4 Three React/DOM traps in auto-grow measurement

All three produce the same symptom — a committed box showing only its first
line — and each masks the next. Read before touching `TextAnnotation.tsx`.

- **Measure both axes before writing either.** Write both to `auto`, read both,
  then write both back.
- **`handleBlur` must read from a ref**, not state or the DOM. Blur fires after
  the layout effect ran with `isEditing` false.
- **Do not clear inline styles when leaving edit mode.** React writes height and
  width from the style prop in the same commit; clearing `el.style.height`
  afterwards wipes it while React still believes it applied it.

Also: the wrapper `<div>` needs an explicit height, and `rows={1}` on the
textarea (the default of 2 fights the measurement).

⚠ §9.4 will mount a text box with content already in it — a path that has never
executed. This section is the first place to look when it breaks.

### 6.5 pdf-lib anchoring differs per primitive

- `drawText` — `y` is the **baseline**. For a multi-line box the first line's
  baseline sits near the top: `rect.y + rect.height - ascent`, then subtract
  `fontSize * LINE_HEIGHT` per line. Ascent is
  `font.heightAtSize(size, { descender: false })`.
- `drawSvgPath` — anchors **top-left**, SVG y grows downward, so pass
  `rect.y + rect.height`.
- `drawImage` — anchors **bottom-left**, same as our stored rect. No adjustment.

Symbol paths are authored in a 0–100 viewBox in both the viewer component and
the export, duplicated rather than shared because the viewer imports React and
`editor/` must not.

### 6.6 Editor font doesn't match export font — OPEN

Editor renders `sans-serif`, export renders Noto Sans Hebrew. Cosmetic now that
the box grows rather than wraps, but the on-screen width is a slight lie. Fix
is an `@font-face` at the TTF in `public/fonts/`, possibly needing
`chrome.runtime.getURL()` at runtime. TODO is in `TextAnnotation.tsx`.

### 6.7 Scale-factor discipline

Two viewports from the same page, one line apart in `PdfPage.tsx`:

- **Canvas backing store** at `scale * devicePixelRatio` — sharp on retina.
- **Everything in the DOM** at plain `scale`. Mixing them = double offset.

pdf.js emits text-layer spans with percentage positions plus `--font-height`
and `--scale-x` custom properties and relies on `pdfjs-dist/web/pdf_viewer.css`.
Hand-writing that CSS produces spans right at exactly one zoom level. Import
the real stylesheet.

### 6.8 Cancellation pattern for pdf.js (reuse this)

1. `cancel()` — a request, not an instant stop.
2. `await …promise.catch(() => {})` — wait for real teardown.
3. Null the refs.

Plus a `cancelled` boolean flipped in effect cleanup and checked after **every**
`await`. Skipping step 2 gives "Cannot use the same canvas during multiple
render() operations" and duplicate stacked text spans.

### 6.9 Ownership rules

- `page.cleanup()` lives in `PdfPage` **only**. ✅ Phase 2 does NOT call it —
  see §8.6 for how the three-way race was resolved without new state.
- Canvas render lifecycle stays local component state. Wanting to hoist "which
  page is rendering" into `state/` signals something else is wrong.

### 6.10 Pointer-events and click discipline

`AnnotationLayer` is transparent to the mouse in select mode so `PdfTextLayer`
keeps its selection; opaque when a placement tool is active or a box is
editing. Individual annotations always set `pointerEvents: auto`.

Because the layer is transparent in select mode, deselect-on-background-click
is a **document-level** listener identifying background by exclusion: anything
not inside `[data-annotation-id]` or `[data-editor-chrome]`.

⚠ **`CopilotPanel` and `ContextForm` both carry `data-editor-chrome`.** Without
it, every click in the panel — and every keystroke in the API key field —
deselects whatever annotation the user is holding. Every early-return branch in
`CopilotPanel` renders through `Shell`, which owns the attribute, so the error
paths can't lose it.

**Everything is `click`, never `pointerdown`, at the layer level.** Pointerdown
fires before an open textarea's blur, so the new box's `editingId` gets cleared
by the old box's blur. Individual annotations still use pointerdown for drag.

### 6.11 Text runs are fragmented — but much less so on pdf.js v6

A PDF has no concept of a line, only positioned glyph runs. **However, v6
merges adjacent runs**: page 1 of the fixture yields 138 items where v4 yielded
204, and whole Hebrew sentences arrive intact.

⚠ This is why items-per-line is a bad proxy for anything — see §8.15.

### 6.12 Page-at-a-time, no continuous scroll

Scroll doesn't affect copilot correctness — markers anchor to page plus
coordinates either way. It affects _discoverability_.

**Consequence, mandatory:** the copilot panel is a navigable list. One row
per line (label, verdict, tags, page number); clicking sets `pageNumber`.
✅ Built.

**Scanned / image-only PDFs are editor-only, no copilot.** The editor never
needed text — canvas rendering works, and placing a box is pure coordinate
work. `run-extraction.ts` returns `readable: false` and the panel says so
plainly. **Still untested against a real scan — verify.**

---

## 7. Phase 2 — what exists NOW

### 7.1 Files in `copilot/`

| File                  | Role                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| `extract-text.ts`     | page → ordered lines, logical order, PDF points, readability flags                  |
| `extract-geometry.ts` | operator list → checkboxes, combs, dashed leaders. Document-level. Never throws.    |
| `detect-fields.ts`    | joins the two; emits model payload (no coordinates) + client map (coordinates only) |
| `run-extraction.ts`   | orchestrates the three, owns the failure policy, returns one object                 |
| `verify.ts`           | dev-only; asserts the §7.2 table against the Harel baseline                         |
| `copilotStore.ts`     | provider, key, context answers, classification results                              |
| `ContextForm.tsx`     | provider dropdown, masked key field, two free-text questions                        |
| `classify.ts`         | the ONE function that calls a provider                                              |
| `CopilotPanel.tsx`    | the field list, verdicts, degraded-state notices                                    |

### 7.2 VERIFICATION STATUS ✅ CONFIRMED IN BROWSER

All numbers below reproduce **in-browser** on pdfjs-dist 6.2.108, matching the
Node baseline exactly.

| Check                      | Expected                                    | Status |
| -------------------------- | ------------------------------------------- | ------ |
| Lines per page             | 52 / 48 / 24                                | ✅     |
| `hasEOL` with `str === ""` | 50 / 47 / 23                                | ✅     |
| Derived checkbox size      | 8.0pt, from 20 occurrences                  | ✅     |
| Checkboxes per page        | 12 / 1 / 7                                  | ✅     |
| Dashed leaders per page    | 4 / 8 / 0                                   | ✅     |
| Comb fields                | p1: 6 + 9 cells · p2: three × 9 · p3: none  | ✅     |
| Comb labels resolved       | `תאריך לידה` / `מס' הזהות` / `מספר זהות` ×3 | ✅     |
| Flagged Latin words        | 5 distinct (9 occurrences), all page 2      | ✅     |
| `HSBC` flagged?            | **NO**                                      | ✅     |
| Tagged lines               | 35 of 124                                   | ✅     |

⚠ `verify.ts` hardcodes these numbers and is meaningless on any other document.
It is gated on the filename containing the fixture's name — without that gate
it reports seven failures on every other PDF you open.

### 7.3 The LTR code path — PARTIALLY validated

Checkbox detection now runs correctly LTR: the W-9 yields 8.0pt × 8, matching
its seven classification boxes plus 3b.

**Still unvalidated:** `edgeDistance`'s LTR branch and `offsetMark`'s LTR
branch have never been checked against a rendered position, because markers
don't exist yet (§9.4). `literalBlanks` has never fired on any document.

---

## 8. Phase 2 findings — recorded so they aren't rediscovered

### 8.1 Lines come from `hasEOL`, not from y-coordinates ⚠

pdf.js emits a zero-width item with `str === ""` carrying `hasEOL` at the end
of every line: 50 / 47 / 23 across the pages, accounting for every `hasEOL` in
the document except one (the two-line title, which ends on real text).
**These items ARE the line breaks.** Filtering them before grouping throws away
the line structure.

Splitting on `hasEOL` beats y-clustering, measurably:

- Superscripts sit ~3pt off baseline. Any tolerance tight enough to keep table
  cells apart splits those; the stream keeps them together.
- On page 2 the rotated margin word `סטודיו` shares a baseline with the
  `שליחת דבר פרסומת` heading. Geometry can't separate unrelated content on the
  same y. The stream can.

✅ **The guard now exists** — see §8.15. The failure mode it prevents was
directly measured: forcing the fallback on the fixture merges the sidebar
advert into `ג אופן המשיכה` and `משיכה חלקית`, the same collision §8.9
describes for checkbox matching.

**Two different empty-ish strings.** `str === ""` is a line break, drop it.
`str === " "` is real whitespace on the page and MUST survive — every blank on
the Harel form is a whitespace run followed by a large gap. Widening the filter
to `!str.trim()` deletes Phase 2's signal.

### 8.2 Rotated text is separable from the transform matrix

Every page opens with a vertical margin strip (`הראל`, `סטודיו`, `51305.7`,
`03/2026`) — the printer's ID stamp, 4 items on every page. Normal text has
transform `[9,0,0,9,x,y]`; rotated has `[0,8.29,-8.29,0,x,y]`. So
`transform[1]` or `transform[2]` being non-zero is the whole test. Currently
dropped — a decision about _this_ document, since a rotated _field_ would
matter.

### 8.3 Reading order within a line is x-ascending, i.e. backwards for Hebrew

The עמית table header arrives as
`[תאריך לידה] [מס' הזהות] [שם פרטי] [שם משפחה]` and reads in the reverse
order. Confirmed on both v4 and v6. Every line must be re-sorted by its own
direction.

**Line direction is decided by "any strong RTL character present," NOT by
"first strong character."** The textbook rule needs the string already in
logical order — which is what the function is producing. Circular.
`editor/export.ts` uses the first-character rule legitimately, because by then
the string exists in logical order. **The two rules differ on purpose; don't
"unify" them.** Digits and punctuation count as neither direction.

### 8.4 Corruption is per-GLYPH, not per-font

- Every Hebrew character in the document extracts correctly, all 3 pages.
- Only Latin is ever corrupted — 5 distinct words, 9 occurrences, all page 2.
- **Not per-font.** `g_d0_f2` gives 44 clean Hebrew runs and 3 broken Latin
  ones. `g_d0_f1` gives `HSBC` correctly and `Qo` (truly `QR`) wrongly — same
  font, same page. A partially-populated `ToUnicode` table.
- **The offset isn't consistent in sign**: `p→S` is −29, `R→o` is +29. **No
  repair is possible.** Only disclosure.

**Detection rule, verified:** an uppercase letter immediately after a lowercase
one, inside a single alphabetic word. Flags `httSs`, `harHl`, `grouS`,
`uQsubscribH`, `iQs`. Passes `HSBC`, `mfax`, `harel`, `ins`, `www`, `co`, `il`.

⚠ **THE TOKENIZER MUST BE `/[A-Za-z]+/g`, NOT `\b`-ANCHORED.** The corrupted
text is `il.co.iQs-harHl@1uQsubscribH`, and a `\b` boundary can't start at `u`
because the digit `1` precedes it. A `\b`-anchored regex silently returns 4
distinct / 8 occurrences instead of 5 / 9. A "cleanup" refactor to `\bword\b`
would break this invisibly.

⚠ **This rule does NOT survive English documents** — see §8.16, now gated.

**Ranges, not booleans.** Because v6 merges runs, corrupted Latin sits inside
otherwise-perfect Hebrew items. A per-run boolean would condemn forty good
Hebrew words to flag two bad Latin ones.

**No page-level verdict.** Extraction reports evidence; `detect-fields.ts`
concludes.

### 8.5 Geometry: the v6 operator-list format ⚠ PRIVATE API

`getOperatorList()` is public; the shape of what it returns is not, and it
changed substantially v4 → v6:

- v4 emitted separate `stroke` / `fill` ops. **v6 emits NONE** — the paint
  operation moved into `constructPath`'s first argument.
- v4 had a `rectangle` opcode carrying `[x,y,w,h]`. v6 emits rectangles as
  moveTo + 3×lineTo + close in a flat coordinate array.

**Both changes yield ZERO results rather than an error.** That's why
`extractDocumentGeometry` never throws. If an upgrade turns the §7.2 counts to
zero, this file is the cause and it's safe to delete while fixing.

v6 `constructPath` args: `[0]` paint op (OPS constant), `[1][0]` Float32Array
of interleaved `[cmd, x, y, …]` (curves carry six coords, close none), `[2]`
precomputed bbox `[minX, minY, maxX, maxY]` in path space.

Path opcodes inside the array are LOCAL (`0`=moveTo, `1`=lineTo, `2`=curveTo,
`4`=close), **not** the `OPS` constants. An unknown opcode must bail rather
than step by a default stride, or the walk desynchronises and returns
plausible-but-wrong numbers silently.

### 8.6 `page.cleanup()` three-way race ✅ RESOLVED

`doc.getPage(n)` returns a **cached** proxy. `PdfPage` calls `cleanup()` after
canvas render resolves; `PdfTextLayer` separately streams text from it.

**Resolution: `runExtraction(loaded.doc)` runs inside `App.openFile`, after
`loadPdf()` resolves and BEFORE `setPdf()`.** In that window `PdfPage` has not
mounted and nothing else holds a page proxy. It costs no new state anywhere.

**`run-extraction.ts` does NOT call `page.cleanup()`.** Ownership stays with
`PdfPage` (§6.9). Calling it from two places recreates the race in a new form,
and leaving fonts cached makes the first render faster.

Extraction runs **once per document over every page**, not per render — the
panel must list fields on pages never opened.

### 8.7 Sizes are derived by repetition, never hardcoded

A form repeats its furniture; nothing else does. On Harel, checkbox width
8.0pt occurs **20 times**, the runner-up 5 times. On the W-9, 8.0pt occurs 8
times and nothing else qualifies. Comb cell width repeats 9 times in a row.

**Checkboxes:** histogram square-ish, low-complexity single-subpath shapes;
take the mode; require ≥3 occurrences. Squareness is _proportional_, not
absolute. Document-level pooling matters: Harel page 2 has one checkbox and no
mode in isolation.

⚠ Page 2 of the fixture also contains ~20 tiny vector shapes (0.57–2.37pt, the
✎ pen glyphs in section ד) that pass a naive squareness test. Doc-level mode
plus the ≥3 rule is what excludes them; without it page 2 reports 21
checkboxes. A minimum absolute size floor (~3pt) would be a cheap second guard.

**Combs:** runs of ≥3 consecutive **equal** gaps between thin vertical ticks
sharing a y-band. Gap tolerance must be **proportional** — the ID field's first
cell is genuinely 0.49pt narrower (15.31 vs 15.80), and a flat 0.4pt tolerance
reports 8 cells for a 9-digit Israeli ID.

**On a rejected run, advance by ONE tick, not past the whole run.** Two comb
fields side by side share a divider.

**Leaders** are dashed strokes — parameter-free. Known limit: a form using
solid underlines gets nothing, and loosening to "thin, long, horizontal" would
catch every table rule. ⚠ See §8.17 — on the W-9 those same solid rules ARE
the field boundaries. Identical geometry, opposite meaning.

### 8.8 Blank detection: three signals, not one

The Harel document contains **zero underscore-runs, zero dot-leaders, zero
dash-runs in its text**, on any page. Its blanks are whitespace runs followed
by a 48–105pt positional jump (against sub-1pt between words), and its dotted
leaders are vector strokes.

✅ **The literal-run signal is now implemented** (`literalBlanks` in
`detect-fields.ts`): `_(?:\s?_){2,}`, `\.(?:\s?\.){4,}`, `-(?:\s?-){3,}`.
Thresholds differ per character and are set by what they must NOT match —
`...` ellipsis, `1.1.2008`, `co-op`, `well-known`. Verified zero matches across
all three Harel pages, so it cannot regress the fixture. **Never fired on any
document yet.**

Gap threshold is one em of the adjacent text, not a constant.

⚠ **Known false positive, accepted:** Harel page 2's unsubscribe line has a
51.7pt gap and gets a `writeIn` tag. Real blanks measure 74–261pt, so
separating them needs a hardcoded number — which this codebase avoids. Tags
enrich and never gate, so the model reads the line and correctly calls it
prose. The cost is one unused coordinate. **Do not "fix" this with a constant.**

**Cross-check worth keeping:** page 1's leaders sit at y = 613, 450, 181, 139 —
exactly the baselines where text-gap analysis independently finds blanks.

### 8.9 Matching shapes to lines

**Checkboxes need a horizontal tiebreak.** Nearest-baseline alone fails: the box
beside `משיכה חלקית` (baseline 195.3) is 2.4pt from that line and 2.3pt from
the sidebar advert at 196.5 — the advert wins and steals the checkbox. Among
lines in the vertical band, pick the one whose **text edge** is nearest. The
advert's edge is 352pt away.

On an RTL line the relevant edge is the **right** one.

**A comb's label is NOT the nearest line above it.** Section ד lays each row out
as three lines: labels, signature text, tick marks. Rule that works on both
layouts: **walk upward and take the first line containing a run that
horizontally OVERLAPS the comb.** Nearest-above gets page 2 wrong three times
out of three.

⚠ **`matchCheckboxes` still keeps only ONE box per line.** Combs became
run-keyed after §8.12; checkboxes never did. Invisible on both test documents,
live risk on the next issuer.

### 8.10 Calibrated mark offset

Checkboxes sit a stable distance from their line's text edge: median 2.75 /
2.44 / 2.75 across the three Harel pages. Learn it from the boxes that exist,
then apply it to lines where **no box was drawn** — so the `התחלתי לעבוד`
clause gets its mark exactly where a box would have been.

`markOffset` is now exposed on `DetectionResult`.

### 8.11 ⚠ RTL cell order — most likely place to produce a silent wrong value

`cellRects` indexes cells **left to right, geometrically**. On a Hebrew form the
first character of an ID belongs in the **rightmost** cell, so a 9-digit ID
fills index 8 down to 0. Filling 0 upward writes the number **mirrored** — and
it looks entirely plausible on screen. Only obvious once printed.

**Still unexercised** — nothing writes into cells yet. This lands in §9.4.

### 8.12 ⚠ A line can carry SEVERAL fields

Page 1's עמית table puts four column labels on ONE line with a 6-cell comb and
a 9-cell comb beneath it. Keying affordances by line kept the first and
**silently dropped the ID number field**.

Affordances belong to **runs**, not lines. `PayloadLine.fields` is an array,
each entry carrying its own `ref`. `overlappingRun` returns the run rather than
a boolean precisely so the two combs on one line can be told apart.

`literalBlanks` follows the same rule — `Name: ____ Date: ____` emits two
fields, not one.

The `geometry` map is keyed by BOTH field ref and line id: refs give a detected
shape's exact rect, line ids give the calibrated fallback.

### 8.13 Duplication to clean up

`extract-geometry.ts` exports `combCellRect` (single rect) and
`detect-fields.ts` has a private `cellRects` (array) doing the same job.
Nothing will flag it — an exported function is never "unused." Delete the
export from `extract-geometry.ts`.

### 8.14 ⚠⚠ THE CONTENT STREAM IS NOT IN READING ORDER — NEW

pdf.js emits items in the order the producer wrote them. **InDesign writes one
text frame at a time, in the order the frames were created.** Measured on the
fixture:

- page 1 — section א (y 586), then ג (y 209), then ב (y 508)
- page 2 — ה, ד, ו, ח, ט, ז

Within a frame the lines are fine — only 5 of page 1's 52 break monotonic
descent. Whole **blocks** arrive shuffled.

**This is not cosmetic.** §9.3's premise is that the model reasons from context
— a heading reading "mark the relevant options below" means nothing if _below_
isn't below. It also makes the panel unnavigable.

**Fix: sort each page's lines by y descending.** Stable sort, so lines sharing
a baseline keep stream order for free. Gets both pages exactly right.

⚠ **FRAME GROUPING WAS TRIED AND FAILS — do not re-attempt.** Grouping
consecutive lines while y descends, then sorting the groups, produces 6 groups
on page 1 and 4 on page 2, none aligned to the real sections, because blocks
chain into one another with no detectable boundary (א's lines flow straight
into ג's). Page 1 still came out א → ג → ב.

⚠ **KNOWN LIMIT:** on a genuinely two-column page this interleaves the columns
line by line. Bureaucratic forms are single-column with full-width sections.
The proper fix for tagged PDFs is `page.getStructTree()`, which carries the
producer's declared reading order — the Harel fixture is tagged (it was
accessibility-remediated) but most forms are not, so it can't be the only path.

⚠ **LINE IDS SHIFT.** Ids are array positions (`p1l15`), so they all changed
when this landed. Payload and geometry are built from the same array in one
pass, so nothing breaks — but ids noted in an old session are stale.

### 8.15 ⚠ The `hasEOL` guard — three revisions, and why — NEW

A PDF from Word, LaTeX, or a scanner may emit no `hasEOL` at all. Then
`splitIntoLines` returns **one line per page** with no error, the payload
becomes a few enormous strings, and nothing looks broken.

**Revision 1 — items-per-line ratio. WRONG, do not restore.** Compared text
items to lines, fell back above 8:1. Two problems. It FALSE-POSITIVED on
ordinary documents: items-per-line measures how aggressively the producer
merged runs, not correctness. Harel runs at 2.2–3.3 because v6 merges Hebrew
heavily (§6.11); a dense English page merges far less and legitimately exceeds
8 — at which point a correct page gets rebuilt with the inferior method. It was
also REDUNDANT, since the span test below catches its stated case better.

**Revision 2** used the right measurement with `some()`, which failed a whole
page on one odd group.

**Revision 3 — CURRENT.** A line is text sharing a baseline, so measure that:
a group's vertical spread against its own tallest glyph. Fall back only when
more than **25%** of a page's groups exceed 3×.

Scale separation makes the threshold uncritical: superscripts sit at 0.33×, a
group holding a whole page sits at ~78×. Three orders of magnitude.

**The clustering fallback, measured.** Forcing it on the fixture yields
50 / 48 / 24 against the correct 52 / 48 / 24. Zero splits — the 0.5×-height
tolerance covers the ~3pt superscript offset. The two merges are both the
sidebar advert gluing onto body lines:

```
ג אופן המשיכה …  +  הראל מאפשרת לקיחת הלוואה על סמך כספים
משיכה חלקית      +  בקופת גמל לפרטים: *הראל 2735*
```

⚠ `משיכה חלקית` is a real field, and the merge extends its `line.maxX` across
the advert. `edgeDistance` and the calibrated offset both measure from that
edge, so **on the fallback path a checkbox mark for that line can land hundreds
of points off.** The text degrades slightly; the placement degrades badly. If
marks look wildly misplaced on a non-InDesign PDF, look here first.

No cheap mitigation exists: requiring horizontal adjacency to merge would fix
this and break blanks, which are 48–105pt gaps by definition.

⚠ **STILL NEVER FIRED ON A GENUINELY BROKEN DOCUMENT.** Only via a forced
threshold. A Word or LaTeX PDF remains untested.

`ExtractedPage.lineSource` is `"eol" | "clustered"` and the panel says so.

### 8.16 ⚠ The corruption rule must be gated by document script — NEW

§8.4's rule flags lowercase-then-uppercase inside a word. On an English
document it flagged, on a real test: `SaaS`, `JavaScript`, `TypeScript`,
`PayPal`, `macOS`, `iPhone`, `PostgreSQL`, `YouTube` — 8 distinct, 22
occurrences, every one a false positive. The copilot would disclaim a third of
a perfectly readable document, which trains the user to ignore the warning that
matters.

**Gate: suppress the rule when Latin exceeds 15% of the document's letters.**
Measured on Harel: 0.7% / 3.0% / 0.3% per page, **1.59% document-wide**. An
English document sits near 100%. Not close to the boundary.

**Placement matters.** `extract-text.ts` still computes `suspectRanges`
unconditionally and reports `letters: { latin, rtl }` per page.
`detect-fields.ts` decides whether to surface `unreliableText`. That split is
what §8.4's closing comment already prescribed: extraction reports evidence,
detect-fields draws the conclusion. It also means the evidence survives if the
gate is ever reconsidered.

**Document-level, not per page**, so an English appendix inside a Hebrew form
still gets checked — that's the page where mangled Latin is most likely.

**Known limit:** a Hebrew form legitimately mentioning "PayPal" still flags it.
Safe direction; the real fix is a dictionary and isn't worth the bundle size.

`DetectionResult.corruptionCheckApplied` exposes the decision.

### 8.17 ⚠⚠ US FORMS BUILD BOXES FROM UNCONNECTED STROKES — NEW

Measured on the IRS W-9 (Rev. March 2024), page 1:

```
items=252  eol-empty=48  lines=89  shapes=30
checkbox histogram: 8.0pt × 8      <- the 7 classification boxes + 3b
large rectangles:   0
```

**Every shape is `cmds=2`** — one moveTo, one lineTo — with either zero width
or zero height. The form contains **no rectangles at all**. The box around
"1 Name of entity/individual" exists only visually, as four unrelated line
segments meeting at corners.

Two completely different form idioms:

|               | Harel                                 | W-9                              |
| ------------- | ------------------------------------- | -------------------------------- |
| Blanks        | inline: whitespace run + 48–105pt gap | region bounded by separate rules |
| Field boxes   | none                                  | four unconnected strokes         |
| Detectable by | `hasWideGap`, leaders                 | **nothing currently**            |

**Consequence:** on the W-9, geometry finds 8 checkboxes and nothing else, on a
form that is mostly write-in fields. Lines 1, 2, 5, 6, 7 get no tag at all.

**And the copilot works anyway.** The model returned "fill in" for line 1 with
no affordance tag whatsoever. See §3.1 — this is the architecture's strongest
validation to date.

⚠ A rule-bounded-box detector is therefore **optional**, affecting placement
only. It is also harder than it looks: the same "thin, long, horizontal stroke"
is table furniture on Harel and a field boundary on the W-9 (§8.7). Distinguishing
them probably needs the model, not more geometry.

### 8.18 Groq free tier cannot fit a Hebrew document — NEW

The Harel payload measures **12,266 JSON characters, of which 6,159 are
Hebrew**. Llama's tokenizer has poor Hebrew coverage — roughly one token per
character — giving **~7,700 input tokens, ~8,200 with the system prompt**.

Groq's free tier caps `llama-3.3-70b-versatile` at **12,000 TPM**, and
**counts `max_completion_tokens` toward the estimate before the request runs**.
Actual response: `Limit 12000, Requested 13541`.

So `max_tokens` is the dominant fixable term, and even at 3,000 the Hebrew
document doesn't fit (13,541 − 3,000 = ~10,541 input alone). `maxTokens` is now
per-provider in `PROVIDER_CONFIG`: 8000 for Anthropic and OpenAI, 3000 for Groq.

**Groq is for pipeline testing on Latin documents. Not for the Hebrew demo,**
and not for judging output quality — Llama's Hebrew is weak and §9.3's language
separation is exactly what a weaker model drops.

Groq's 413 body states the limit and the requested amount; `providerError`
surfaces it rather than swallowing it.

### 8.19 Provider notes

- **Anthropic requires `anthropic-dangerous-direct-browser-access: true`** for
  browser calls. Without it, CORS rejection looks like a network failure.
- **Groq is OpenAI-compatible** — same request body, same response shape. It
  shares `callOpenAiCompatible` entirely. Three providers, two request shapes.
- **`fetch` rejects with `TypeError` for both network failure and CORS.** On
  this extension that almost always means a missing `host_permissions` entry.
  Chrome does not apply manifest permission changes on hot reload — reload the
  extension.
- Model names live in ONE place, `PROVIDER_CONFIG`. They move; verify before a
  demo. Groq's catalogue rotates fastest.

---

## 9. Phase 2 — what's left

### 9.0 Recommended order

**§9.7 (follow-up question box) before §9.4 (markers).** §9.7 is one API call
on machinery that already exists, it doubles as §10's network-failure fallback,
and it answers questions markers can't. §9.4 is more visually impressive but
carries Phase 2's last real trap (§6.4 / §9.4).

### 9.1 ✅ DONE — pipeline + panel

Extraction wired into `App.openFile`, §7.2 numbers confirmed in-browser,
`CopilotPanel` lists every line with page grouping and click-to-navigate.

⚠ The panel defaults to **all lines**, not tagged-only as §9.1 originally
specified. While extraction is still being generalised, "did line splitting
work" is the question asked most often and only the full list answers it. Flip
the default once a second Hebrew issuer is tested. The toggle stays regardless.

### 9.2 ✅ DONE — context intake

Provider dropdown (Anthropic / OpenAI / Groq), masked key field disabled until
`chrome.storage` has been read, "Forget this key", and the two free-text
questions. Key persists; context answers are in-memory only.

Switching provider clears the key — only one `{ provider, apiKey }` pair is
stored, and an Anthropic key sent to OpenAI produces an auth error that reads
like a broken integration.

### 9.3 ✅ DONE — the AI call

`getFieldClassifications(payload, context, provider, apiKey)` in `classify.ts`.
Every line goes, not a filtered list. Returns
`{ id, fill: "fill"|"skip"|"unclear", value_or_instruction, reason }`.

- Ids validated against the payload; unknown ids dropped, with a dev-only
  warning naming how many and showing three samples.
- 90s timeout via `AbortController`, cleared in `finally`.
- Every failure path returns a readable message — never a thrown error, never a
  silent hang.
- Markdown fences stripped before parsing.

**⚠ THE LANGUAGE SEPARATION IS THE RULE MOST LIKELY TO FAIL INVISIBLY.**
`reason` in the user's language; `value_or_instruction` in the FORM's language
and script. A name or address in English on a Hebrew form gets the submission
rejected, and nobody in a demo audience who can't read Hebrew will notice.
**Not yet verified on the Hebrew fixture** — Groq couldn't run it (§8.18).

**Demonstrated on the W-9** (Groq, llama-3.3-70b-versatile): line 1 and line
3a returned "fill in", 3b and 4 returned "skip", and page 2 — pure instructions
— returned nothing at all. That last result matters as much as the others: the
natural failure mode of "consider every line" is over-eagerness, and it didn't
happen. See §8.17 for why line 1 is the interesting one.

### 9.4 Wiring results into the editor — NOT STARTED

Colour-coded markers (fill / skip / unclear) at the coordinates from
`detect-fields.ts`'s client map, plus click-to-prefill.

**Pre-fill mechanism, decided:** seed the **draft**, not the store. `cancelEdit`
removes a text annotation only when the _stored_ `text` is falsy — so seeding
the store would make Escape keep the AI's value, while seeding the draft gives
exactly the desired behaviour (click away commits, Escape discards) with **zero
changes** to `addText` / `commitText` / `cancelEdit`. Mirror the
`pendingSignature` pattern with a `pendingText`.

⚠ **A draft-seeded box mounts with content already in it — a path that has
never executed**, since every box so far has mounted empty. It is exactly the
path §6.4 documents three traps in. If pre-filled boxes come out one line tall,
look at the measurement order, not the marker code.

⚠ This is where §8.11 (RTL cell order) finally gets exercised. A 9-digit ID
fills cell index 8 down to 0. Filling 0 upward writes it mirrored and looks
plausible on screen.

⚠ This is also where §7.3's remaining LTR branches (`edgeDistance`,
`offsetMark`) get validated against a rendered position for the first time.

✅ Copilot state already lives in its own store, so AI responses don't set
`dirty` on the annotation store.

### 9.5 Multi-provider — ✅ DONE, three not two

Anthropic, OpenAI, Groq. One internal function branching on
`PROVIDER_CONFIG.openAiCompatible`. No `if (provider === …)` anywhere in UI
code. Adding a compatible provider is a one-line change.

**Still open:** web search grounding is wired differently per provider. Decide
which one gets it before building §9.6.

### 9.6 Web search grounding — NOT STARTED

Only when the model flags genuine uncertainty (e.g. a legal eligibility rule),
not every field. Needs a timeout so a slow search never hangs the UI.

### 9.7 Follow-up question box — NOT STARTED

A free-text box under the panel, with the extracted document text already in
context. Markers answer "what goes in this field"; they don't answer "what does
מס שבירה mean" or "I have a loan against the account, does that change which
box I tick." One API call, on machinery that already exists.

Doubles as the §10 network-failure fallback: a working question box is a much
better live recovery than narrating screenshots.

### 9.8 Phase 3, only if time remains

AcroForm explanation layer. **Neither test document has an AcroForm**, so this
needs a third document to demo at all.

### 9.9 Deferred, with reasons

- **Rule-bounded box detection (§8.17)** — placement only; the same geometry
  means opposite things on the two test documents.
- **Per-page chunking of the payload** — needed for 50+ page documents and for
  tight provider limits. ⚠ Cost is real: Harel page 3 lists which documents to
  attach _depending on which withdrawal type was picked on page 1_. Chunking
  breaks that link. A fallback for documents that don't fit, not a default.
- **`matchCheckboxes` one-box-per-line (§8.9)** — invisible on both test
  documents.
- **Absolute size floor for checkbox candidates (§8.7)** — cheap second guard.

---

## 10. Pre-demo checklist

**Editor**

- [x] Viewer opens and renders the fixture correctly, all 3 pages
- [x] Text box placement accurate across zoom levels
- [x] Text layer selection accurate across zoom (50–300%)
- [x] Multi-page text PDFs open without crashing
- [x] Signature draws smoothly, resizes without distortion
- [x] Unsaved-changes warning fires
- [x] Exported PDF correct in macOS Preview and Chrome — verified with
      `חשבון 935921908 בבנק HSBC`. Adobe Reader still untested.
- [x] Hebrew font still exports after removing `web_accessible_resources`
- [ ] Single-page and large (50+ page) files
- [ ] Scanned/image-only PDF degrades cleanly

**Extraction**

- [x] TypeScript compiles (strict, noUnusedLocals)
- [x] Runs end to end in Node
- [x] **§7.2 numbers reproduce in-browser**
- [x] Reading order correct (א ב ג / ד ה ו ז ח ט)
- [x] `hasEOL` guard silent on good documents, fires when forced
- [x] Corruption gate: 8 false positives suppressed on an English document
- [x] An English **form** — W-9, checkbox detection validated LTR
- [ ] A second Hebrew form from a different issuer
- [ ] A non-InDesign PDF — the `hasEOL` guard has never fired for real (§8.15)
- [ ] An AcroForm PDF — confirm it degrades rather than crashes

**Copilot**

- [x] API key flow: first-run prompt, persists, doesn't re-ask
- [x] Visible error if key missing or invalid — never a silent hang
- [x] Verdicts render per line with reason and value
- [x] Model does NOT over-classify prose (W-9 page 2 returned nothing)
- [ ] **Hebrew demo: explanations in English, values in Hebrew** ⚠ unverified
- [ ] Field-to-line mapping stable on repeated runs
- [ ] Both providers produce correctly-structured JSON on the same document
- [ ] Provider switch relabels/clears the key field (implemented, untested)
- [ ] ID number lands in cells **right to left** (§8.11) — blocked on §9.4
- [ ] Web search has a timeout — blocked on §9.6

**Overall**

- [ ] Full demo rehearsed 3–5+ times on the exact file being presented
- [ ] Fallback if AI or network fails live
- [ ] Tested on a clean Chrome profile
- [ ] `verify.ts` filename gate in place, or removed entirely
- [ ] Paid API credit topped up (Groq cannot run the Hebrew fixture — §8.18)

---

## 11. Ideas and open questions (not committed)

- **OCR — explicitly cut.** Would be the fallback for §8.4 and scanned pages.
  Whole subsystem. (If it happens: Tesseract needs `heb` loaded explicitly.)
- **Extraction-quality signal as a first-class concept.** Partly built now —
  `lineSource`, `geometryOk`, `readable`, `corruptionCheckApplied` are all
  facets of it.
- **`page.getStructTree()`** for reading order on tagged PDFs (§8.14).
- **`TextLayer.update({ viewport })`** repositions spans instead of rebuilding
  on zoom. Not worth doing until something feels slow.
- **Canvas blanks on every zoom step.** Render to a detached canvas, swap on
  completion. Cosmetic.
- **Signature is a raster.** `embedPng` means slightly soft at high zoom.
- **Filled checkboxes** — the size histogram pools stroked and filled
  deliberately. Risk: a document whose bullet markers are small filled squares
  out-voting real checkboxes. Harel dodges it because its ■ bullets are
  ZapfDingbats _text_; its page-2 QR is a raster image, not vector, so it
  contributes nothing either. Fix if it trips: prefer the stroked cluster.
- **Slide decks** will produce phantom checkboxes — a deck repeats its
  furniture harder than any form, and with no real checkboxes competing, the
  most-repeated decoration becomes the mode. Harmless: tags enrich, the model
  reads slide text and finds no fields. No fallback needed.

---

## 12. Working conventions

- Explain the file and its non-obvious parts before writing code.
- One file at a time.
- Skeletons with TODO blocks; the human writes the component logic.
- The cancellation pattern in §6.8 is reused for every long-running pdf.js op.
- Comments earn their place by recording _why_, especially where the code looks
  wrong and isn't. `ltrFontkit`, the inline-style rules in `TextAnnotation.tsx`,
  the opcode-stride switch in `extract-geometry.ts`, the alpha-run tokenizer in
  `findSuspectRanges`, and the reading-order sort are all in that category.
- **Verify claims against the fixture rather than reasoning about them.** Nearly
  every finding in §8 contradicted a confident prior assumption. This session:
  the reading-order bug, the `hasEOL` guard's two wrong versions, and the W-9's
  stroke-built boxes were all found by measuring, and none by reading code.
- **Test on whatever PDF is lying around.** Three of this session's findings
  came from documents that were not the fixture, and the first `hasEOL` guard —
  written specifically to prevent a failure — would have shipped broken without
  one.
