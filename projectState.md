# PDF Copilot — Project State & Session Handoff

**Phase 1 (editor): COMPLETE and stable.**
**Phase 2 (AI copilot): WORKING END TO END ON BOTH TEST DOCUMENTS, IN BOTH
SCRIPTS.** Advice appears per field, markers render on the page at real
coordinates, the follow-up question box answers free text. §9.3's language
separation — the last correctness unknown — is VERIFIED on the Hebrew fixture.

**DEMO IS 19 AUGUST. Three working days: 16, 17, 18.**

**START HERE NEXT SESSION: §14.** It has the running order and the one bug that
makes the screen look broken.

Read §1–3 for what this is, §7 for verification status, §8 for findings that
cost real time, §9 for what's left, §15 for the demo-day plan.

⚠ New this session: §8.24–§8.37, and they are unusually consequential.
- **§8.20's ✅ was FALSE** and the smoke report caught it on its first run.
- **§8.22 is FIXED** (run-keyed checkboxes) and confirmed on screen.
- **§8.35 — a prompt rewrite fixed language drift AND under-classification.**
  Position in the prompt mattered more than wording.
- **§8.36 — the store silently collapsed multi-field verdicts** for as long as
  classifications have existed. Third occurrence of the same line-vs-run bug.
- **§9.4 SCOPE CUT: no click-to-prefill, deliberately.** See §9.4.

---

## 0. Status

Phase 2 works end to end on two documents in two scripts. Extraction is
verified in-browser, both AI calls are built and tested live, markers render at
verified coordinates, and Hebrew classification produces English reasons with
Hebrew values.

**Demo-ready with one visible bug (§8.37, caption overflow) and three
degradation checks outstanding.** What remains is polish, verification breadth,
and rehearsal — not features.

---

## 1. What this is

A browser extension that lets you edit and sign any PDF in-browser, then uses
AI to tell you — field by field — what to fill in, what to skip, and why,
based on your own stated situation. It also answers free-text questions about
the form. No server, no database, no accounts.

## 2. The problem it solves

Filling a bureaucratic form today (example: the Israeli Harel severance
withdrawal form used as the fixture) means uploading the PDF to an AI chat,
asking what to fill, getting prose back, then going to a _separate_ tool to
type into the PDF — working out yourself where each described field sits.

This extension collapses that into one flow: the AI's answer and the place you
act on it are the same interface, and the answer is tied to real coordinates
instead of prose you have to translate.

**Note the boundary, and state it in the demo (§9.4):** the copilot tells you
what belongs in each field and marks where it goes. It does not type for you.
Those are different claims, and the second one is not needed for the first to
be useful.

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

### 3.1 Discovery is text-driven, geometry only enriches ✅ VALIDATED FOUR TIMES

The original plan made blank detection a **gate**: find the blank
geometrically, then ask the model about it. That is wrong, and four independent
results now disprove it.

**Harel:** section ב has NINE eligibility clauses and only EIGHT checkboxes
(the clause beginning `התחלתי לעבוד במקום חדש` has no box drawn; confirmed by
rasterising). A gated design silently drops a real option.

**W-9 (§8.17):** the form draws no rectangles at all, so geometry finds 8
checkboxes and nothing else on a form that is mostly write-in fields. Line 1,
"Name of entity/individual", has no detectable affordance of any kind. **The
model returned "fill in" for it anyway.** Under the gated design the entire
form would have come back nearly empty.

**W-9, second session.** On page 1 the reading order is visibly scrambled by
column interleaving (§8.21), five checkboxes collapse into a single line with
one rect (§8.22), and the masthead is mistagged as a write-in. **The copilot
still returned correct, specific advice for every real field.** Discovery
survived three simultaneous geometry and ordering defects.

**Harel, the untagged clause — DIRECTLY DEMONSTRATED (§8.33).** With context
"started a new job in June 2026", the model's reason for a DIFFERENT clause
reads: *"Gap between jobs was only about 3 months, not 6+ continuous months as
required."* It read `התחלתי לעבוד במקום חדש` — the clause with no checkbox
drawn beside it — understood it, and used it to reject a neighbouring clause's
condition. **A geometry-gated design never puts that line in front of the
model, so that reasoning could not happen at all.**

That fourth one is the demo line. It is no longer an argument about what the
architecture permits; it is a transcript of the architecture paying off.

**So: the model sees the whole document text and decides what the fields are.**
Geometry answers only "where exactly does a mark go, and how much room is
there." If every geometry detector returns nothing, the copilot still works —
every field is still found, explained, and listed. Only placement degrades.

Preserve that property. It is the reason the risky parts are deletable.

### 3.2 What goes to the model, and what never does

- **Coordinates never go.** `classify.ts`'s `projectLines` re-projects each
  line field by field rather than spreading it, so a coordinate added to
  `PayloadLine` later cannot silently start being uploaded.
  ⚠ **`projectLines` is shared with `ask.ts`** and is the ONLY serialisation of
  document data in the codebase. One function, one audit. Do not write a
  second one.
- **Cell counts DO go**, because they change the answer. ✅ **CONFIRMED LIVE
  (§8.32):** a six-cell date returned `120385` (DDMMYY, not DDMMYYYY) and a
  nine-cell ID returned `039274865`. This was a design argument for two
  sessions and is now a measured result.
- **Field refs DO go**, added this session (§8.27). A ref is `"p1l17f0"` — a
  line index and a field index. No coordinate and nothing derived from one; the
  payload already states a field was detected on that line, and the ref only
  numbers them. Added deliberately, not by a spread.
- **Absence is NEVER asserted.** A line carries a tag or carries nothing, and
  nothing means _unknown_. The system prompt states this explicitly as rule 2,
  and the W-9 result above is that rule paying off.

---

## 4. Storage & security (know this cold for demo day)

Everything except the API key is in-memory and gone on tab close or refresh.
That includes the two context answers **and the whole question thread**, which
are the most personal things in the app.

- **No database anywhere.** `chrome.storage.local` is sandboxed to the
  extension by Chrome — not readable by other extensions or sites, not synced.
- **Not encrypted at rest.** Don't claim encryption. Say "sandboxed locally by
  Chrome," which is accurate. The UI copy already says exactly this.
- ⚠ **`persist()` takes `StoredCredentials`, not a partial state.** That
  signature is the only thing keeping the context answers and the ask thread
  off disk. Widening it breaks the privacy claim and nothing would flag it.
- **Never log the API key**, including `console.log` while debugging. No file
  in `copilot/` logs it, including error paths. Keep it that way.
  ⚠ Several diagnostic logs were added this session (§8.38) — none touches the
  key, and none should.
- **Minimal `host_permissions`**: the three provider APIs and nothing else.
- `web_accessible_resources` was REMOVED — extension pages are same-origin with
  their own resources, so `chrome.runtime.getURL()` needs no declaration.
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
    PdfPage.tsx           canvas render, owns the page wrapper, mounts overlays
    PdfTextLayer.tsx      selectable transparent text overlay
    coordinates.ts        the ONLY place points and pixels convert
    useAnnotationStore.ts React binding for the vanilla store
    AnnotationLayer.tsx   overlay: placement, keyboard, deselect
    GeometryOverlay.tsx   NEW — dev-only rect visualiser, `g` toggles
    VerdictMarkers.tsx    NEW — §9.4, green markers on "fill" verdicts
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
in `copilot/` so it doesn't have to pick a side. The two new overlays are in
`viewer/` because they mount inside `PdfPage` and import `coordinates.ts`.

### 5.1 Invariants that must not be broken

**Geometry is PDF points**, y = bottom edge, origin bottom-left. Screen pixels
never enter the store. `coordinates.ts` is the only place the two systems meet.
Both new overlays go through `pdfRectToCss` and do no arithmetic of their own.

**Text is stored in logical order**, exactly as typed. Visual reordering
happens once, in the export path.

**Annotations are a flat array**; array order is z-order. The export path must
iterate in the same order — don't sort.

**Selection is two fields.** `selectedId` = has handles, Delete removes it.
`editingId` = caret inside, Delete types a character. Collapsing them makes
Backspace delete the box you're typing in.

**`state/` stays free of DOM and React imports** so the background worker can
import it. `copilot/` is NOT bound by this — nothing in the worker needs it.

**Layer order in `PdfPage`, bottom to top:** canvas → `PdfTextLayer` →
`GeometryOverlay` → `VerdictMarkers` → `AnnotationLayer`. AnnotationLayer must
stay LAST. Both new overlays are `pointerEvents: "none"` throughout, which is
what lets AnnotationLayer keep the transparency behaviour §6.10 depends on.

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

⚠ **This matters more now than it did.** The copilot returns
`039274865` as a value the user will type into the form. If export reverses it,
the demo produces a wrong ID number on a real document.

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

✅ **NO LONGER A §9.4 RISK.** The old warning here said §9.4 would mount a text
box with content already in it — a path that has never executed. **Click-to-
prefill was cut (§9.4), so that path still never executes.** This section is
back to being Phase 1 history rather than a live hazard.

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

⚠ **`CopilotPanel`, `ContextForm` and the `AskBox` question field all sit
inside `Shell`, which carries `data-editor-chrome`.** Without it, every click in
the panel — and every keystroke in the API key field or the question box —
deselects whatever annotation the user is holding. Every early-return branch in
`CopilotPanel` renders through `Shell`, so the error paths can't lose it.

**Everything is `click`, never `pointerdown`, at the layer level.** Pointerdown
fires before an open textarea's blur, so the new box's `editingId` gets cleared
by the old box's blur. Individual annotations still use pointerdown for drag.

⚠ **`GeometryOverlay` and `VerdictMarkers` are `pointerEvents: "none"` and
nothing inside re-enables it.** That is why they need no `data-editor-chrome`.
**If a marker ever becomes clickable, it needs the attribute** or clicking it
will deselect the user's annotation through the document-level listener.

⚠ **STILL OPEN, one look to settle:** if `AnnotationLayer` binds
Delete/Backspace at DOCUMENT level rather than on the layer element, typing in
the question box or the API key field will delete the selected annotation.
`GeometryOverlay`'s `g` handler has the same exposure and carries the same
input guard as a precaution. `ContextForm` has had this exposure all along, so
it may already be fine. The fix if it bites is a target check in the layer's
handler, NOT `stopPropagation` on each input.

### 6.11 Text runs are fragmented — but much less so on pdf.js v6

A PDF has no concept of a line, only positioned glyph runs. **However, v6
merges adjacent runs**: page 1 of the fixture yields 138 items where v4 yielded
204, and whole Hebrew sentences arrive intact.

⚠ This is why items-per-line is a bad proxy for anything — see §8.15.

⚠ **Merging is NOT uniform.** W-9 line 3b extracts as 19 runs because each dot
of a leader is its own item (§8.24). Do not assume a line is one run, and do
not assume a visually contiguous string is one run.

### 6.12 Page-at-a-time, no continuous scroll

Scroll doesn't affect copilot correctness — markers anchor to page plus
coordinates either way. It affects _discoverability_.

**Consequence, mandatory:** the copilot panel is a navigable list. One row
per line (label, verdict, tags, page number); clicking sets `pageNumber`.
✅ Built.

**Scanned / image-only PDFs are editor-only, no copilot.** `run-extraction.ts`
returns `readable: false` and the panel says so plainly. **STILL UNTESTED
against a real scan — §14 Step 2 does it.**

---

## 7. Phase 2 — what exists NOW

### 7.1 Files in `copilot/` and the new viewer overlays

| File                       | Role                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `extract-text.ts`          | page → ordered lines, logical order, PDF points, readability flags                            |
| `extract-geometry.ts`      | operator list → checkboxes, combs, dashed leaders. Document-level. Never throws.               |
| `detect-field.ts`          | joins the two; emits model payload (no coordinates) + client map (coordinates only)            |
| `run-extraction.ts`        | orchestrates the three, owns the failure policy, returns one object, calls `smokeReport`       |
| `verify.ts`                | dev-only; asserts the §7.2 table against the Harel baseline                                    |
| `smoke.ts`                 | **NEW.** Generic extraction report for ANY document. No assertions. §13.3                      |
| `provider.ts`              | the ONE place that talks to a provider. Config, both request shapes, timeout, errors           |
| `classify.ts`              | §9.3 — the classification task: prompt, `projectLines`, JSON parsing, ref validation           |
| `ask.ts`                   | §9.7 — the follow-up question task: prompt, history flattening, prose out                      |
| `copilotStore.ts`          | provider, key, context answers, classifications, ask thread                                    |
| `ContextForm.tsx`          | provider dropdown, masked key field, two free-text questions                                   |
| `CopilotPanel.tsx`         | the field list, verdicts, degraded-state notices, classify button, `AskBox`                    |
| `viewer/GeometryOverlay.tsx` | **NEW.** Dev-only. Draws every rect in the geometry map, coloured by `source`. `g` cycles.   |
| `viewer/VerdictMarkers.tsx`  | **NEW.** §9.4. Green markers on `fill` verdicts only. Read-only.                             |

⚠ **The file is `detect-field.ts`, singular.** Every import says so; only stale
comments said `detect-fields.ts`. Don't grep for the plural.

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
It is gated on the filename containing the fixture's name.

**W-9 baseline (2-page trimmed copy), via `smoke.ts`:**

```
2 pages · 228 lines · 13 tagged
page 1 = 89 lines / 12 tagged / 18 fields
page 2 = 139 lines /  1 tagged /  1 field
mark sources (tagged): checkbox: 8, gap: 11      <- was checkbox: 4 before §8.22
per-line fallback: 228
checkbox size: 8.0pt × 8 matched
mark offset: 5.60pt (calibrated)
corruption check: suppressed · latin 100.0% (gate 15.0%)
geometryOk: true · readable: true
```

⚠ **`fields` rose 14 → 18 on page 1 when §8.22 was fixed**, while `tagged`
stayed at 12 — the four recovered boxes are all on line 3a. That gap between
`tagged` and `fields` is the fastest way to see multi-field lines exist.

### 7.3 ✅ BOTH SCRIPTS VALIDATED AGAINST A RENDERED POSITION

Previously this section warned that `edgeDistance` and `offsetMark` had never
been checked against anything drawn on screen. `GeometryOverlay` (§8.25) closed
that in both directions:

- **LTR — W-9.** All five checkbox rects on line 3a land exactly on the five
  printed boxes. `gap` rects land in the blank areas.
- **RTL — Harel.** Marks sit on the correct side (right of the label), and
  coverage is visibly denser than the W-9's, as expected from 20 checkboxes,
  12 leaders and 5 combs against 8 boxes and no rectangles.

`markOffset` is 5.60pt on the W-9 and no longer an unfalsifiable number.

---

## 8. Phase 2 findings — recorded so they aren't rediscovered

### 8.1 Lines come from `hasEOL`, not from y-coordinates ⚠

pdf.js emits a zero-width item with `str === ""` carrying `hasEOL` at the end
of every line: 50 / 47 / 23 across the pages. **These items ARE the line
breaks.** Filtering them before grouping throws away the line structure.

Splitting on `hasEOL` beats y-clustering, measurably:

- Superscripts sit ~3pt off baseline. Any tolerance tight enough to keep table
  cells apart splits those; the stream keeps them together.
- On page 2 the rotated margin word `סטודיו` shares a baseline with the
  `שליחת דבר פרסומת` heading. Geometry can't separate unrelated content on the
  same y. The stream can.

✅ **The guard now exists** — see §8.15.

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
distinct / 8 occurrences instead of 5 / 9.

⚠ **This rule does NOT survive English documents** — see §8.16, now gated.

**Ranges, not booleans.** Because v6 merges runs, corrupted Latin sits inside
otherwise-perfect Hebrew items.

**No page-level verdict.** Extraction reports evidence; `detect-field.ts`
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
`PdfPage` (§6.9).

Extraction runs **once per document over every page**, not per render.

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
solid underlines gets nothing. ⚠ See §8.17 — on the W-9 those same solid rules
ARE the field boundaries. Identical geometry, opposite meaning.

### 8.8 Blank detection: three signals, not one

The Harel document contains **zero underscore-runs, zero dot-leaders, zero
dash-runs in its text**, on any page. Its blanks are whitespace runs followed
by a 48–105pt positional jump (against sub-1pt between words), and its dotted
leaders are vector strokes.

The literal-run signal is implemented (`literalBlanks` in `detect-field.ts`):
`_(?:\s?_){2,}`, `\.(?:\s?\.){4,}`, `-(?:\s?-){3,}`. Thresholds differ per
character and are set by what they must NOT match — `...` ellipsis, `1.1.2008`,
`co-op`, `well-known`.

⚠ **IT HAS NEVER MATCHED ANYTHING, ON ANY DOCUMENT. See §8.24.** The thresholds
are right; the granularity is wrong.

Gap threshold is one em of the adjacent text, not a constant.

⚠ **Known false positive, accepted:** Harel page 2's unsubscribe line has a
51.7pt gap and gets a `writeIn` tag. Real blanks measure 74–261pt, so
separating them needs a hardcoded number — which this codebase avoids. Tags
enrich and never gate, so the model reads the line and correctly calls it
prose. **Do not "fix" this with a constant.** The W-9's masthead produces the
identical false positive for the identical reason and the model correctly
ignored it there too.

### 8.9 Matching shapes to lines

**Checkboxes need a horizontal tiebreak.** Nearest-baseline alone fails: the box
beside `משיכה חלקית` (baseline 195.3) is 2.4pt from that line and 2.3pt from
the sidebar advert at 196.5 — the advert wins and steals the checkbox. Among
lines in the vertical band, pick the one whose **text edge** is nearest.

On an RTL line the relevant edge is the **right** one.

**A comb's label is NOT the nearest line above it.** Section ד lays each row out
as three lines: labels, signature text, tick marks. Rule that works on both
layouts: **walk upward and take the first line containing a run that
horizontally OVERLAPS the comb.** Nearest-above gets page 2 wrong three times
out of three.

✅ **`matchCheckboxes` is now run-keyed — FIXED, see §8.22.** It returns
`Map<Line, CheckboxMatch[]>` and appends; each box carries its own label run.

### 8.10 Calibrated mark offset

Checkboxes sit a stable distance from their line's text edge: median 2.75 /
2.44 / 2.75 across the three Harel pages, 5.60 on the W-9. Learn it from the
boxes that exist, then apply it to lines where **no box was drawn** — so the
`התחלתי לעבוד` clause gets its mark exactly where a box would have been.

`markOffset` is exposed on `DetectionResult` and printed by `smoke.ts`.

⚠ **It now measures to each box's OWN LABEL RUN**, not to the line edge, with
the line edge as fallback for unlabelled boxes (`labelOffset`). This had to
change in the same edit as §8.22: `line.minX` is the leftmost point of the
WHOLE line, so on a line carrying five options, boxes 2–5 would each report a
large negative offset and drag the median. While one box per line survived, the
two measurements were identical. They are not any more.

### 8.11 ⚠ RTL cell order — SEEN, and now defused

`cellRects` indexes cells **left to right, geometrically**. On a Hebrew form the
first character of an ID belongs in the **rightmost** cell, so a 9-digit ID
fills index 8 down to 0. Filling 0 upward writes the number **mirrored**.

✅ **CONFIRMED VISUALLY** via `GeometryOverlay`, which numbers each cell: on
Harel's 9-cell `מס' הזהות` comb, cell 0 is leftmost and therefore holds the
LAST digit.

✅ **AND NO LONGER A RISK.** Click-to-prefill was cut (§9.4), so nothing writes
into cells programmatically. The user reads `039274865` off the marker and
types it themselves, right-to-left, as a person naturally does. **If prefill is
ever revived, this is the first thing to get right.**

### 8.12 ⚠ A line can carry SEVERAL fields — AND THIS BUG HAS THREE HEADS

Page 1's עמית table puts four column labels on ONE line with a 6-cell comb and
a 9-cell comb beneath it. Keying affordances by line kept the first and
**silently dropped the ID number field**.

Affordances belong to **runs**, not lines. `PayloadLine.fields` is an array,
each entry carrying its own `ref`. `overlappingRun` returns the run rather than
a boolean precisely so the two combs on one line can be told apart.

The `geometry` map is keyed by BOTH field ref and line id: refs give a detected
shape's exact rect, line ids give the calibrated fallback.

⚠⚠ **THE SAME BUG HAS NOW APPEARED THREE TIMES, IN THREE PLACES:**

1. **Combs** — fixed here, §8.12.
2. **Checkboxes** — `matchCheckboxes` kept one box per line. Fixed §8.22.
3. **The store** — `classifications` was keyed by line id, collapsing several
   verdicts on one line. Fixed §8.36.

**RULE: when a line can carry several of something, check every map keyed by
line id.** `hasWideGap` is the remaining one and is deliberately unfixed
(§8.22).

### 8.13 Duplication to clean up

`extract-geometry.ts` exports `combCellRect` (single rect) and
`detect-field.ts` has a private `cellRects` (array) doing the same job.
Nothing will flag it — an exported function is never "unused." Delete the
export from `extract-geometry.ts`. **Still not done. Low priority.**

### 8.14 ⚠⚠ THE CONTENT STREAM IS NOT IN READING ORDER

pdf.js emits items in the order the producer wrote them. **InDesign writes one
text frame at a time, in the order the frames were created.** Measured on the
fixture:

- page 1 — section א (y 586), then ג (y 209), then ב (y 508)
- page 2 — ה, ד, ו, ח, ט, ז

**Fix: sort each page's lines by y descending.** Stable sort, so lines sharing
a baseline keep stream order for free. Gets both Harel pages exactly right.

⚠ **FRAME GROUPING WAS TRIED AND FAILS — do not re-attempt.** Grouping
consecutive lines while y descends, then sorting the groups, produces 6 groups
on page 1 and 4 on page 2, none aligned to the real sections.

⚠ **KNOWN LIMIT: two-column pages interleave.** Confirmed — see §8.21.

⚠ **LINE IDS SHIFT.** Ids are array positions (`p1l15`), so they change on every
re-extraction. Payload and geometry are built from the same array in one pass,
so nothing breaks — but ids noted in an old session are stale, and
classifications must never be cached across a re-extraction.

### 8.15 ⚠ The `hasEOL` guard — three revisions, and why

A PDF from Word, LaTeX, or a scanner may emit no `hasEOL` at all. Then
`splitIntoLines` returns **one line per page** with no error, the payload
becomes a few enormous strings, and nothing looks broken.

**Revision 1 — items-per-line ratio. WRONG, do not restore.** It FALSE-POSITIVED
on ordinary documents: items-per-line measures how aggressively the producer
merged runs, not correctness.

**Revision 2** used the right measurement with `some()`, which failed a whole
page on one odd group.

**Revision 3 — CURRENT.** A line is text sharing a baseline, so measure that:
a group's vertical spread against its own tallest glyph. Fall back only when
more than **25%** of a page's groups exceed 3×.

**The clustering fallback, measured.** Forcing it on the fixture yields
50 / 48 / 24 against the correct 52 / 48 / 24. The two merges are both the
sidebar advert gluing onto body lines.

⚠ `משיכה חלקית` is a real field, and the merge extends its `line.maxX` across
the advert. **On the fallback path a checkbox mark for that line can land
hundreds of points off.** If marks look wildly misplaced on a non-InDesign PDF,
look here first.

⚠ **STILL NEVER FIRED ON A GENUINELY BROKEN DOCUMENT.** Only via a forced
threshold. `smoke.ts` prints `lineSource` and warns loudly if it ever says
`"clustered"` — that remains the single most valuable unclaimed result.

### 8.16 ⚠ The corruption rule must be gated by document script

§8.4's rule flags lowercase-then-uppercase inside a word. On an English
document it flagged `SaaS`, `JavaScript`, `TypeScript`, `PayPal`, `macOS`,
`iPhone`, `PostgreSQL`, `YouTube` — 8 distinct, 22 occurrences, all false.

**Gate: suppress the rule when Latin exceeds 15% of the document's letters.**
Measured on Harel: 1.59% document-wide. The W-9 measures 100.0%.

✅ Confirmed on the W-9: zero "text unclear" badges across both pages.

**Placement matters.** `extract-text.ts` computes `suspectRanges`
unconditionally and reports `letters: { latin, rtl }` per page;
`detect-field.ts` decides whether to surface `unreliableText`.

**Document-level, not per page**, so an English appendix inside a Hebrew form
still gets checked. `smoke.ts` prints which side of the gate a document sits on.

### 8.17 ⚠⚠ US FORMS BUILD BOXES FROM UNCONNECTED STROKES

Measured on the IRS W-9 (Rev. March 2024), page 1: **every shape is `cmds=2`**
— one moveTo, one lineTo — with either zero width or zero height. The form
contains **no rectangles at all**. The box around "1 Name of entity/individual"
exists only visually, as four unrelated line segments meeting at corners.

Two completely different form idioms:

|               | Harel                                 | W-9                              |
| ------------- | ------------------------------------- | -------------------------------- |
| Blanks        | inline: whitespace run + 48–105pt gap | region bounded by separate rules |
| Field boxes   | none                                  | four unconnected strokes         |
| Detectable by | `hasWideGap`, leaders                 | **nothing currently**            |

**And the copilot works anyway.** See §3.1.

⚠ A rule-bounded-box detector is **optional**, affecting placement only.
Distinguishing table furniture from a field boundary probably needs the model,
not more geometry.

### 8.18 Groq free tier cannot fit a Hebrew document

The Harel payload measures **12,266 JSON characters, of which 6,159 are
Hebrew**. Llama's tokenizer has poor Hebrew coverage — roughly one token per
character — giving **~7,700 input tokens, ~8,200 with the system prompt**.

Groq's free tier caps `llama-3.3-70b-versatile` at **12,000 TPM**, and
**counts `max_completion_tokens` toward the estimate before the request runs**.
Actual response: `Limit 12000, Requested 13541`.

`maxTokens` is per-provider in `PROVIDER_CONFIG`: 8000 for Anthropic and
OpenAI, 3000 for Groq.

**Groq is for pipeline testing on Latin documents. Not for the Hebrew demo.**

⚠ The Groq-plus-Hebrew-ask question (does a 1,200-token ask fit where classify
cannot?) is still unanswered and now low value — Anthropic credit exists and
the demo runs on it.

### 8.19 Provider notes

- **Anthropic requires `anthropic-dangerous-direct-browser-access: true`** for
  browser calls. Without it, CORS rejection looks like a network failure.
- **Groq is OpenAI-compatible** — same request body, same response shape.
- **`fetch` rejects with `TypeError` for both network failure and CORS.** On
  this extension that almost always means a missing `host_permissions` entry.
  Chrome does not apply manifest permission changes on hot reload.
- Model names live in ONE place, `PROVIDER_CONFIG` in `provider.ts`. **VERIFY
  BEFORE THE DEMO.** Currently `claude-sonnet-5` and confirmed working.
- ⚠ **`stop_reason` is now logged** when it isn't `"end_turn"` (§8.38). Keep
  it — silent truncation was invisible for three separate failures.

### 8.20 ❌ CORRECTED — `literalBlanks` has NEVER fired, and could not have

**The previous version of this section was WRONG and marked ✅.** It claimed the
W-9's line 3b dot run matched `\.(?:\s?\.){4,}`. It did not.

Measured via `smoke.ts`'s mark-source histogram: `checkbox: 4, gap: 11`, **no
`literal` entry at all**, on a document where 3b visibly carries nine dots.

**How the false ✅ survived a session:** both available observations — dots in
the extracted text, and a `writeIn` badge on the row — were consistent with the
claim, and neither could test it. §8.20 itself warned that the dots proved
nothing. The badge turned out to be unattributable too, because `hasWideGap`
emits the same `writeIn` tag. The badge on 3b was `gap`.

**Two lessons worth more than the finding:**

1. **A tag with no provenance cannot confirm the detector that produced it.**
   Fixed by adding `MarkSource` to `FieldGeometry` — diagnostics only, on the
   client-side type, never serialised.
2. **The tool that prints numbers caught what a session of inspection missed.**
   `smoke.ts` deleted a false ✅ on its first run.

Cause and fix: §8.24.

### 8.21 ⚠ TWO-COLUMN PAGES DO INTERLEAVE — and it starts at line 0

W-9 page 1 is two-column. Line 4 (Exemptions) sits in a right-hand column
beside 3a and 3b, and the y-descending sort splices its lines between the left
column's.

⚠ **EXTENDED: the interleaving starts at line 0, not at line 40.** Page 1's
first three lines read `Request for Taxpayer` / `Give form to the` /
`Form(Rev. March 2024) W-9` — the masthead's three layout blocks arriving
shuffled, and the form number is itself three runs joined in the wrong order.

**Blast radius, measured not assumed:**

- **Placement: UNAFFECTED.** Marker coordinates come from the geometry map,
  never from list position.
- **Panel readability: degraded** in those regions.
- **Model context: degraded, and survivable.** The model classified 3a and 3b
  correctly on this exact page.

**Not fixable by §8.14's route.** A real fix means clustering lines by x-extent
into column bands. **Not committed:** it needs a rule for when a page IS
two-column, and getting that wrong scrambles a single-column form, which is the
common case. `page.getStructTree()` remains the correct answer for tagged PDFs.

Deferred. See §9.9.

### 8.22 ✅ FIXED — several checkboxes on one line

W-9 line 3a extracts as a SINGLE line carrying five options:

```
Individual/sole proprietor   C corporation   S corporation   Partnership   Trust/estate
```

Five drawn checkboxes, one extracted line. `matchCheckboxes` kept **one box per
line**, so four of the five got no rect at all.

**Measured before the fix:** `smoke.ts` reported `checkbox: 4` against 8 boxes
detected document-wide. Exactly the predicted deficit, but measured rather than
reasoned.

**Option 3 built** (run-keyed, mirroring `matchCombs` since §8.12):

- `matchCheckboxes` returns `Map<Line, CheckboxMatch[]>` and APPENDS.
- Each match carries its own label run via `labelRun` — nearest run on the side
  the text runs toward. LTR: look right. RTL: look left. Getting this backwards
  labels every box with its NEIGHBOUR's text, which reads plausibly on a row of
  similar options.
- Matches are sorted into reading order within the line.
- `calibrateMarkOffset` changed in the same edit — see §8.10.

**Result:** page 1 fields 14 → 18, geometry map 243 → 247, `checkbox: 8`.
`tagged` unchanged at 12, because all four recovered boxes are on one line.

✅ **Confirmed on screen** via `GeometryOverlay`: five blue rects, one per
printed box. ✅ **And the labels are right** — `f0` through `f4` resolve to
`Individual/sole proprietor`, `C corporation`, `S corporation`, `Partnership`,
`Trust/estate` in order. First verification `labelRun` has ever had.

⚠ **`hasWideGap` was NOT made run-keyed.** It still emits one `writeIn` for the
line however many gaps it finds, so line 3a carries a sixth field overlapping
the five checkboxes (§8.26). Deliberate: the checkbox fields already carry
placement, so the extra tag is redundant rather than wrong.

### 8.23 §9.7's design decisions, tested rather than assumed

Verified live on Groq / llama-3.3-70b against the W-9, five questions, five
passes. Notable because Llama is the WEAK model, so these are a floor.

- **History flattening works.** "And the one right after it — does that apply
  to me?" resolved to 3b with no restatement. Do not add a `messages` array
  until something actually fails.
- **The hardcoded English rule works.** A Hebrew question (`?מה זה TIN`)
  against an English document returned English.
- **Both refusal rules held.** "What's the deadline?" returned "not specified
  in the provided form" rather than inventing one. "How do I fill in Schedule
  K-2?" declined and pointed at Form 1065's instructions.
- **Skips carry reasons**, as designed.

✅ **And it recovered a classification failure live (§8.28).** Asked directly
about W-9 line 6, it answered correctly — a line classification had omitted.
That is §10's network-failure fallback doing a job nobody designed it for.

### 8.24 `literalBlanks` matches per RUN, and a dot leader is one run per dot

W-9 line 3b extracts as **19 runs**:

```
["...See instructions", " ", ".", " ", ".", " ", ".", ...]
```

`literalBlanks` iterates `line.runs` and matches inside each one, so the longest
string it ever tests is `"."`. Length one. The pattern needs five. **It cannot
match, and never could have.**

**The regex is correct.** Joined, the line reads `See instructions . . . . . . .
. .` and matches cleanly; the LLC line's four dots correctly do not. §8.8's
thresholds were right all along and remain unexercised.

**Fix, KNOWN AND DEFERRED:** match against `line.text`, map character offsets
back to runs, and union the rects of the runs a match spans. Union is
direction-agnostic, so the RTL branch is only needed for the single-run case.

**Why deferred:** the detector has never found a field no other detector found.
On the W-9 the same blanks are found by `gap`. Only the exact rect of an
already-detected blank differs. **Do it if a document appears where a literal
run is the ONLY signal on a line.**

### 8.25 ✅ Geometry overlay built — placement validated in both scripts

`viewer/GeometryOverlay.tsx`, dev-only. `g` cycles off → fields → all. Draws
every rect in the geometry map, coloured by `source`, dashed when
`fromDrawnShape` is false, comb cells drawn individually and NUMBERED.

`pointerEvents: "none"` throughout — see §6.10.

**Built instead of verdict markers as the first §9.4 step**, and that was the
right call: it needs no API key, covers all 247 rects rather than the handful
the model answers on, and works on any document. Verdict markers became the
same rects in different colours.

**Results: see §7.3.** Both scripts validated. §8.11 seen rather than predicted.

### 8.26 Overlapping detectors on one line, now visible

W-9 line 3a shows five checkbox rects AND a `gap` writeIn rect over the same
span. The LLC line likewise has a real write-in (the C/S/P letter) plus a box.

Harmless for discovery — one line, one verdict — but **§9.4 must decide which
rect a verdict lands on when a line carries both.** `VerdictMarkers` resolves
by source priority, preferring measured ink over calculated position.

### 8.27 ✅ Optional `ref` on FieldClassification — the model names WHICH field

Classifications key by LINE, but a line can carry six fields. Three changes:

- `projectLines` sends each field's `ref` (§3.2).
- Prompt rule 6 asks the model to name the specific field on a multi-field line,
  and explicitly says an omitted ref is handled correctly while a wrong one puts
  a mark on the wrong box.
- `parseResponse` validates the ref **against that line's own refs** — a global
  set-of-all-refs check would accept `p1l7f0` returned against `p1l3` and put
  the mark on another line. An invalid ref **strips the ref, it does not drop
  the row**: the verdict and reason are the valuable part.

**Measured, W-9 / Groq:** 9 verdicts, 1 with a ref — `p1l17f0` on line 3a, the
only genuine five-option row. Zero invalid refs. The weak model used the field
where it applied and omitted it on the other eight lines.

**Measured, Harel / Anthropic:** 19 of 19 verdicts carry refs.

Absent ref degrades to pre-§8.22 behaviour, so §9.3's tested passes remain the
floor.

### 8.28 Classification UNDER-returns; the question box recovers it

W-9 through Groq, sole-proprietor context: **9 verdicts on a form with ~12 real
fields.** Line 5 (Address) got a `fill`; **line 6 (City, state, ZIP) got no
verdict at all**, though both are required and adjacent.

Not a knowledge failure: asked directly in the question box, the model answered
that line 6 must be filled in.

⚠ **This inverts §9.3's earlier finding.** That section noted the natural
failure mode of "consider every line" is over-eagerness. **Silent omission is
the worse of the two:** an over-eager verdict is visible and dismissible, a
missing one looks like "nothing to do here."

✅ **Root cause found and fixed — see §8.35.** It was prompt weakness, not model
capacity. The model never hit the token ceiling in any run.

### 8.29 RTL geometry validated visually

Harel through `GeometryOverlay`: marks land on the correct side (right of the
label on RTL lines). Coverage visibly denser than the W-9's — expected, since
Harel draws 20 checkboxes, 12 leaders and 5 combs against the W-9's 8 boxes and
no rectangles at all.

§8.11 seen rather than predicted: the 9-cell `מס' הזהות` comb numbers left to
right, so cell 0 holds the LAST digit of an Israeli ID.

### 8.30 ⚠ The OUTPUT ceiling is the binding constraint on Hebrew

Harel, 124 lines, Anthropic:

- 8,000 output tokens, 90s timeout → **timed out**.
- 4,000 output tokens → **truncated mid-JSON** ("the model's answer wasn't
  readable").
- 8,000 tokens, 180s timeout → completed generation in ~100s, still truncated.

§8.18 measured only the INPUT side. Hebrew output tokenizes at roughly one
token per character, and 124 verdicts with prose reasons do not fit in 8,000
tokens regardless of how long you wait.

**Workaround in place: classify the CURRENT PAGE only.** `CopilotPanel` passes
`payload.filter((l) => l.page === pageNumber)` to `runClassification`. Page 1 is
52 lines and lands comfortably inside the ceiling.

**Cost, stated honestly in the demo:** cross-page reasoning is lost. Harel page
3 lists which documents to attach depending on which withdrawal type was picked
on page 1 (§9.9). For a demo that shows page 1, that cost does not apply.

⚠ **`CLASSIFY_TIMEOUT_MS` is now 180_000**, up from 90_000. A full Hebrew page
takes 60–100 seconds. **This is a demo pacing problem — have something to say
while it runs.**

### 8.31 §3.1's headline claim — CONFIRMED, after nearly failing

First Harel run (no new job): the untagged clause `התחלתי לעבוד במקום חדש` got
no verdict. §3.1 asserts a gated design drops it and a text-driven one does
not — but on that run the text-driven design dropped it too, at the model layer.

Second run, context changed to "started a new job in June 2026": **the model's
reason for a neighbouring clause explicitly reasons about it.** See §3.1.

**The first run was defensible** — an irrelevant clause is fair to omit. But the
claim was unproven for two sessions, and one badly chosen context would have
made the demo's best line unsupportable. **Check the claim on the run you are
about to demonstrate.**

### 8.32 ✅ §9.3's LANGUAGE RULE VERIFIED — §10's last Hebrew item ticks

Harel page 1, Anthropic, context carrying real personal data. Values came back
in the form's script and format:

| Field       | Value       | Why it matters                              |
| ----------- | ----------- | ------------------------------------------- |
| Name        | `כהן משה`   | Hebrew script, family name FIRST — matching the form's column order |
| ID          | `039274865` | 9 digits into a 9-cell comb                 |
| Birth date  | `120385`    | DDMMYY into a 6-cell comb, not DDMMYYYY     |

Every reason in English. Hebrew terms preserved inline where the term IS the
concept (`פיצויים`, `תגמולים`, `קצבה מוכרת`) rather than translated.

✅ **§3.2's cell-count argument is confirmed at the same time.** The six-cell
date produced DDMMYY and the nine-cell ID produced nine digits. That was a
design justification for two sessions and is now a measured result.

### 8.33 ⚠ The language rule LEAKS — intermittently, on Hebrew-dense rows

Same document, same model, different context: **two of five reasons came back
in Hebrew**, on exactly the rows whose reasoning quoted the form's Hebrew text.
Every other reason in that run, and all 19 in the previous run, were English.

**This is the failure mode §9.3 predicted:** intermittent, correlated with
Hebrew-dense content, and invisible to an audience who cannot read Hebrew. A
consistent failure would have been caught immediately.

⚠ **A later run had ALL FIVE reasons in Hebrew on the same build.** English and
Hebrew alternated across identical builds. **One pass proves nothing about a
prompt rule.**

Fixed by §8.35.

### 8.34 The capacity theory was WRONG — worth recording as a wrong turn

When Hebrew reasons appeared alongside a drop from 19 verdicts to 5, the
obvious theory was that Hebrew's ~4× token cost exhausted the output budget.

**It was wrong.** A later run produced 6 verdicts with SHORT ENGLISH reasons and
a raw response of ~2,700 characters against an 8,000-token ceiling. `stop_reason`
was never `max_tokens`. The model was choosing to stop, not running out of room.

Drift and omission were two separate problems that happened to appear together.

### 8.35 ✅✅ THE PROMPT REWRITE — position mattered more than wording

Five changes to `SYSTEM_PROMPT` in `classify.ts`, all needed:

1. **The language rule moved OUT of the numbered list** to AFTER the JSON
   schema, under its own `CRITICAL` heading. Same requirement, different
   position.
2. **`reason` hardcoded to ENGLISH** rather than "the language the person
   used." Removes an inference step the model was getting wrong, and matches
   `ask.ts`, which has always hardcoded English (§8.23).
3. **Rule 1 given a numeric floor:** "a page typically has 15–25 lines worth
   answering. If you have written fewer than 10 verdicts, go back through the
   lines you passed over." Plus "never stop early because the answer is getting
   long."
4. **Reasons capped at 25 words**, one sentence. Attacks omission from the other
   side and drifts less than a paragraph does.
5. **New rule 9:** never leave `value_or_instruction` empty on a `fill`.

**Results, three consecutive runs on Harel page 1:**

| Run | Verdicts | Refs | Reasons  | Values |
| --- | -------- | ---- | -------- | ------ |
| 1   | 19       | 19   | English  | Hebrew |
| 2   | 21       | 17   | English  | Hebrew |
| 3   | 19       | 19   | English  | Hebrew |

Raw response matched parsed output exactly — nothing dropped in validation.

⚠ **The strongest lesson available here:** the same requirement stated as rule 4
of 8 drifted on 2 of 5 rows; stated after the schema under its own heading it
held across three runs. **When a prompt rule is being ignored, try moving it
before rewriting it.**

### 8.36 ✅ FIXED — the store collapsed multi-field verdicts

`runClassification` built `new Map(...map((c) => [c.id, c]))`, keyed by LINE id.
Harel line `p1l14` carries three verdicts (birth date, ID, name) and `p1l21`
carries two. **Last write won, and two of three were silently lost** — at most
one marker could ever appear on the עמית table row.

This has been true for as long as classifications have existed.

**Fix:** key on `c.ref ?? c.id`. Refs are unique per field; the line id is the
fallback for verdicts with no ref.

✅ **Confirmed:** three separate markers now render on the עמית row — name, ID,
birth date — plus two on the withdrawal-type checkboxes.

**Third occurrence of §8.12's line-vs-run bug.** See the rule there.

⚠ **`CopilotPanel` still looks up by line** and now finds only the FIRST of
several verdicts on a line. Acceptable (panel showing one of three beats the
store keeping one of three) but it should build its own line-keyed index.
**TODO in §14.**

### 8.37 ⚠ Rule 9 is unreliable, and captions overflow the page

**Rule 9 (non-empty value on `fill`) does not hold consistently.** One run
returned Hebrew labels on every checkbox skip; the next returned empty strings
throughout, same prompt and context. All `fill` verdicts carried values in both
— so the rule as written is technically satisfied and the earlier run was
over-delivering.

**Do not depend on the model for captions.** `VerdictMarkers` should fall back
to the field's own `label`, which is deterministic and already correct (§8.22).

⚠⚠ **AND THE CAPTION OVERFLOWS — THIS IS THE ONE VISIBLE BUG.** A caption like
`כספי פיצויים – מבקש למשוך את סך כל הכספים ששולמו לרכיב פיצויים` has
`whitespace-nowrap` and is positioned by `left: rect.left` with no width
constraint. On an RTL form the rect sits near the right edge, so the caption
runs off the page, across the copilot panel, and over the ask box.

**It looks broken at the exact moment the best feature fires.** Fix first
thing — see §14 Step 1.

### 8.38 Diagnostics that must survive, and the DEV-guard trap

⚠⚠ **EVERY `import.meta.env.DEV` GUARD IS DEAD IN THE PRODUCTION BUILD.** Vite
strips those blocks at compile time. This cost real time three separate times
today: `smokeReport` appeared not to run, the classification log appeared not to
run, and the "dropped N of M classifications" warning has been invisible
throughout.

**Currently worked around by commenting out the guards.** Fix properly:

```ts
// copilot/dev.ts
export const COPILOT_DEV = true;
```

and replace every `import.meta.env.DEV` with it. **TODO in §14.**

**Logs added this session, all worth keeping:**

- `smokeReport(result)` in `run-extraction.ts` — §13.3.
- `[copilot] N verdicts, M with a ref:` in `runClassification`.
- `[copilot] raw response: N chars` and `[copilot] raw: …` in `parseResponse`.
- `[copilot] stop_reason: …` in `callAnthropic` when it isn't `end_turn`.
  **This one distinguishes "ran out of room" from "chose to stop" and was the
  measurement that killed the capacity theory (§8.34).**

⚠ None of these touches the API key. Keep it that way (§4).

**A separate trap, hit repeatedly: a stale bundle looks exactly like broken
code.** Several rounds today were spent debugging behaviour that had never been
compiled. **Check the bundle hash in the console before believing a result.**

---

## 9. Phase 2 — what's left

### 9.0 Recommended order

Nothing left blocks a demo. §14 has the running order: fix the caption
(§8.37), run the degradation checks, then rehearse.

### 9.1 ✅ DONE — pipeline + panel

Extraction wired into `App.openFile`, §7.2 numbers confirmed in-browser,
`CopilotPanel` lists every line with page grouping and click-to-navigate.

⚠ The panel defaults to **all lines**, not tagged-only. **Consider flipping the
default for the demo** — 124 rows reads as a dump, 35 reads as curated. The
toggle stays regardless.

### 9.2 ✅ DONE — context intake

Provider dropdown, masked key field disabled until `chrome.storage` has been
read, "Forget this key", and the two free-text questions.

Switching provider clears the key — only one `{ provider, apiKey }` pair is
stored, and an Anthropic key sent to OpenAI produces an auth error that reads
like a broken integration.

⚠ **The context answers do real work.** With a vague situation the model returns
`unclear` for name/ID/date; with real data it returns Hebrew values (§8.32).
**Have the test context ready for the demo — it is at the bottom of this file.**

### 9.3 ✅ DONE AND VERIFIED IN BOTH SCRIPTS — the AI call

`getFieldClassifications(payload, context, provider, apiKey)` in `classify.ts`.
Returns `{ id, ref?, fill, value_or_instruction, reason }`.

- Ids validated against the payload; refs validated per line (§8.27).
- **180s timeout** via `AbortController` (§8.30).
- Every failure path returns a readable message — never a thrown error, never a
  silent hang.
- ⚠ **The JSON parse has its OWN try/catch**, because `callProvider` has already
  returned successfully by then. Removing it turns a malformed reply into an
  unhandled rejection and the panel spins forever.
- Markdown fences stripped before parsing.
- ⚠ **The prompt's structure is load-bearing (§8.35).** The language rule sits
  AFTER the JSON schema on purpose. Do not tidy it back into the numbered list.

✅ **THE LANGUAGE SEPARATION IS VERIFIED (§8.32).** `reason` English,
`value_or_instruction` in the form's language and script, on the Hebrew fixture,
across three consecutive runs.

⚠ **Current scope: ONE PAGE PER RUN** (§8.30). `CopilotPanel` passes the current
page's lines only.

### 9.4 ✅ DONE (read-only) — and SCOPE CUT

`viewer/VerdictMarkers.tsx` draws a green marker on every line the copilot said
to FILL IN, at the coordinates `detect-field.ts` computed.

**Only `fill` is drawn.** Not skip, not unclear. On a bureaucratic form most
lines are skips, and drawing them buries the two or three things the user must
actually do. Nothing is lost — the panel lists every verdict with its reason.

**Which rect, when a line has six** (`resolveRect`):

1. **Ref wins.** `classify.ts` validated it against that line's own refs.
2. Otherwise **highest-priority source**: checkbox → comb → literal → leader →
   gap → calibrated. Measured ink before calculated position.
3. **Unless that is ambiguous** — several rects of the winning source and no
   ref. Then draw NOTHING. A mark on the wrong one of five identical checkboxes
   is invisible to the user and wrong on their form.

Lines with no fields at all fall back to the per-line calibrated entry — the
`התחלתי לעבוד` case.

⚠⚠ **NO CLICK-TO-PREFILL, DELIBERATELY.** The user places the value with the
existing text / symbol / signature tools. The AI's answer and the place you act
on it are still the same interface (§2), which is the product claim — it does
not require the tool to type for you.

**Consequences, all good:**

- §6.4's never-executed "box mounts with content" path is never executed.
- §8.11's mirrored-ID risk disappears — nothing writes into cells
  programmatically.
- §14's old sub-steps 2 and 3 are **cancelled, not deferred**.

It is also the more honest answer about what an AI should be trusted to do with
someone's tax form. **Say that in the demo rather than apologising for it.**

**Outstanding, small:** caption overflow and label fallback (§8.37).

### 9.5 ✅ DONE — multi-provider, three not two

Anthropic, OpenAI, Groq. One internal function branching on
`PROVIDER_CONFIG.openAiCompatible`. No `if (provider === …)` anywhere in UI
code. Adding a compatible provider is a one-line change.

**Demo runs on Anthropic** (`claude-sonnet-5`). Groq cannot fit Hebrew (§8.18).

### 9.6 Web search grounding — NOT STARTED, CUT for the demo

Optional. `provider.ts` already takes `timeoutMs` per call, so the plumbing
exists if it is ever wanted.

### 9.7 ✅ DONE — follow-up question box

A free-text box pinned at the bottom of the panel, with the extracted document
text already in context. Markers answer "what goes in this field"; this answers
"what does מס שבירה mean" and "I have a loan against the account, does that
change which box I tick."

- `ask.ts` — prompt, history flattening, prose out. No parsing.
- 45s timeout (not 180 — a user watching a box will reload, and a reload loses
  the extraction AND every annotation).
- 1,200 output tokens.
- History: last **3** exchanges, each remembered answer truncated to 500 chars.
- **English answers, hardcoded**, except a literal value to type.
- ⚠ **`askThread` never holds a half-turn** — the in-flight question lives in
  `pendingQuestion`.
- ⚠ **`ask()` returns a boolean** so the panel clears its textarea only on
  success.
- ⚠ **Independent of classification by design.** Reads no `status`, no
  `classifications`. That independence IS §10's network-failure fallback, and
  it earned its keep live (§8.23, §8.28). Don't gate the box.
- ⚠ **Not a `<form>`** — a real form on an extension page submits and navigates.
- **Deliberately NOT sent: the classifications.** Token cost.

**TODO left in `CopilotPanel.tsx`:** auto-scroll to the newest turn (LAYOUT
effect, not `useEffect`), and the §6.10 Delete-key check.

### 9.8 Phase 3 — CUT

AcroForm explanation layer. Neither test document has an AcroForm, so this needs
a third document to demo at all. **Cut, not deferred.** The only thing worth
doing is confirming an AcroForm PDF degrades rather than crashes (§14 Step 2).

### 9.9 Deferred, with reasons — say these out loud if asked

- **Two-column reading order (§8.21)** — panel readability and model context
  only; placement unaffected, and the model classified correctly through it.
- **Rule-bounded box detection (§8.17)** — placement only; the same geometry
  means opposite things on the two test documents.
- **`literalBlanks` granularity (§8.24)** — the same blanks are already found by
  `gap`; only the exact rect differs.
- **Per-page chunking as a general solution** — currently a hard page filter
  (§8.30). ⚠ Cost is real: Harel page 3 lists which documents to attach
  _depending on which withdrawal type was picked on page 1_.
- **Absolute size floor for checkbox candidates (§8.7)** — cheap second guard.
- **Sending classifications to `ask.ts`** — token cost; see §9.7.
- **Click-to-prefill (§9.4)** — cut on product grounds, not time.
- **`hasWideGap` run-keying (§8.22)** — redundant where it matters.

---

## 10. Pre-demo checklist

**Editor**

- [x] Viewer opens and renders the fixture correctly, all 3 pages
- [x] Text box placement accurate across zoom levels
- [x] Text layer selection accurate across zoom (50–300%)
- [x] Multi-page text PDFs open without crashing
- [x] Signature draws smoothly, resizes without distortion
- [x] Unsaved-changes warning fires
- [x] Exported PDF correct in macOS Preview and Chrome
- [x] Hebrew font still exports after removing `web_accessible_resources`
- [ ] **Export an ID number and check it in Adobe Reader (§6.1).** The copilot
      now returns `039274865` as a value the user will type. Higher stakes than
      when this was written.
- [ ] Single-page and large (50+ page) files
- [ ] Scanned/image-only PDF degrades cleanly

**Extraction**

- [x] TypeScript compiles (strict, noUnusedLocals)
- [x] **§7.2 numbers reproduce in-browser**
- [x] Reading order correct (א ב ג / ד ה ו ז ח ט)
- [x] Corruption gate: suppressed on an English document
- [x] An English **form** — W-9, checkbox detection validated LTR
- [x] **Generic smoke report exists and works on any document (§13.3)**
- [x] **Multi-checkbox rows detected (§8.22)** — `checkbox: 8` on the W-9
- [x] **Placement validated on screen, both scripts (§7.3)**
- [ ] A second Hebrew form from a different issuer
- [ ] A non-InDesign PDF where the `hasEOL` guard actually FIRES (§8.15)
- [ ] An AcroForm PDF — confirm it degrades rather than crashes

**Copilot**

- [x] API key flow: first-run prompt, persists, doesn't re-ask
- [x] Visible error if key missing or invalid — never a silent hang
- [x] Verdicts render per line with reason and value
- [x] Skips carry reasons
- [x] Question box: grounding, history, language, both refusal rules (§8.23)
- [x] **Hebrew demo: explanations in English, values in Hebrew (§8.32)** ✅
- [x] **Cell counts respected — DDMMYY into 6 cells, 9 digits into 9 (§8.32)**
- [x] **Markers render at verified coordinates (§9.4)**
- [x] **Multi-field lines produce multiple markers (§8.36)**
- [x] **§3.1's untagged-clause claim demonstrated live (§8.31)**
- [ ] **Field-to-line mapping stable on repeated runs** — three clean runs so
      far, do more
- [ ] Provider switch relabels/clears the key field (implemented, untested)
- [ ] Caption never overflows the page (§8.37)

**Overall**

- [x] Network-failure fallback exists (the question box, §9.7)
- [x] `App.openFile` calls `resetResults()` on a new document — CONFIRMED, it
      is inside `openFile` before `loadPdf`, next to `setExtraction(null)`
- [x] Paid API credit topped up ($5 Anthropic; a full run costs cents)
- [ ] Full demo rehearsed 3–5+ times on the exact file being presented
- [ ] Tested on a clean Chrome profile
- [ ] `PROVIDER_CONFIG` model names re-verified on demo morning
- [ ] `verify.ts` filename gate in place, or removed entirely
- [ ] Geometry overlay OFF by default and not accidentally toggled on stage

---

## 11. Ideas and open questions (not committed)

- **OCR — explicitly cut.** Would be the fallback for §8.4 and scanned pages.
- **Extraction-quality signal as a first-class concept.** ✅ Now built —
  `smoke.ts` surfaces `lineSource`, `geometryOk`, `readable`,
  `corruptionCheckApplied` and the mark-source histogram in one place.
- **`page.getStructTree()`** for reading order on tagged PDFs (§8.14, §8.21).
- **Column detection** for two-column pages (§8.21).
- **`messages` array on `ProviderRequest`** — only if history flattening starts
  losing the thread. It hasn't (§8.23).
- **A token-cost estimate under the classify button** —
  `JSON.stringify(projectLines(payload)).length / 4`. Cheap, and it makes the
  BYOK story concrete in the demo.
- **`TextLayer.update({ viewport })`** repositions spans instead of rebuilding
  on zoom. Not worth doing until something feels slow.
- **Canvas blanks on every zoom step.** Cosmetic.
- **Signature is a raster.** `embedPng` means slightly soft at high zoom.
- **Filled checkboxes** — the size histogram pools stroked and filled
  deliberately. Fix if it trips: prefer the stroked cluster.

---

## 12. Working conventions

- Explain the file and its non-obvious parts before writing code.
- One file at a time.
- The cancellation pattern in §6.8 is reused for every long-running pdf.js op.
- Comments earn their place by recording _why_, especially where the code looks
  wrong and isn't.
- **Verify claims against the fixture rather than reasoning about them.** Nearly
  every finding in §8 contradicted a confident prior assumption. §8.20 was
  marked ✅ and was false. §8.34 was a confident theory and was wrong.
- **Build the tool that prints numbers before the feature that needs them.**
  `smoke.ts` deleted a false ✅ on its first run; `GeometryOverlay` validated
  both coordinate branches without an API key.
- **One pass proves nothing about a prompt rule (§8.33).** English and Hebrew
  alternated across identical builds. Run it at least twice before believing it.
- **When a prompt rule is ignored, try MOVING it before rewriting it (§8.35).**
- **Check the bundle hash before believing a result (§8.38).**
- **Test on whatever PDF is lying around.** Five sessions running, the
  non-fixture document produced the session's most important finding.
- **Refactor before adding the second caller, not after.**

---

## 13. Generalising beyond the two test documents

### 13.1 What is already generic — do not "improve" these into constants

| Value           | Where it comes from                                        |
| --------------- | ---------------------------------------------------------- |
| Checkbox size   | mode of THIS document's own size histogram, ≥3 occurrences |
| Comb cell width | repetition — ≥3 consecutive equal gaps                     |
| Gap threshold   | one em of the adjacent text                                |
| Mark offset     | calibrated from the boxes THIS document drew               |
| Line direction  | strong-RTL presence in the line itself                     |
| Corruption gate | Latin share of THIS document's letters                     |

The only genuinely fixture-bound file is `verify.ts`, which is dev-only and
filename-gated.

And §3.1 is the larger protection: discovery is text-driven, so a document
where every detector fails still gets every field found, explained and listed.

### 13.2 What is rule-based but only ever exercised on two documents

- **Line splitting (§8.15).** The `hasEOL` guard has NEVER fired on a real
  document. On the fallback path text degrades slightly and **placement
  degrades badly**. Highest-risk unknown.
- **Reading order (§8.14, §8.21).** y-descending. Interleaves on two-column.
- **Checkbox mode needs ≥3 occurrences (§8.7).** A form with two checkboxes
  total gets none.
- **The 15% Latin gate (§8.16).** Harel 1.6%, W-9 100.0%. Nothing has landed
  near the boundary. A genuinely bilingual form is untested.
- **Form idiom (§8.17).** Two incompatible idioms already. Assume a third.
- **`labelRun` (§8.22).** Verified on five W-9 boxes. Never checked on a Hebrew
  multi-option row, because Harel does not have one.

### 13.3 ✅ BUILT — the generic smoke report

`copilot/smoke.ts`, called from `run-extraction.ts`. No assertions, no expected
values, no per-document baseline. Prints:

- **A per-page table:** lines, tagged, fields, unreliable, `lineSource`,
  `quality`, Latin %, and raw shape counts (boxes / combs / rules).
- **A mark-source histogram**, split into real detections and per-line
  fallbacks. **This is the part that caught §8.20's false ✅.**
- **Document facts:** checkbox mode + match count, calibrated `markOffset`,
  corruption gate side, `geometryOk`, `readable`.
- **First and last three lines per page** — the reading-order eyeball. §8.21's
  interleaving is visible here in two seconds.
- **A warnings block** that only appears when something is off.

⚠ **Its guard is currently commented out** because of §8.38. Restore properly
via a `COPILOT_DEV` constant.

**How to read it:** `lines: 1` = line splitting failed. `tagged: 0` on a real
form = a third form idiom. `lineSource: "clustered"` = §8.15 fired for the first
time ever. `checkbox: 4` against 8 boxes = matching is dropping them.

### 13.4 What to collect

Bring documents from **different producers**, not different languages.

1. **Word / Google Docs export** — most likely to fire §8.15's guard for the
   first time. Highest information value.
2. **A government e-file PDF that is not the W-9** — tests for a third form
   idiom (§8.17).
3. **A scan or photo of a form** — must return `readable: false`. Never tested.
4. **A second Hebrew issuer** — the one gap that IS language-shaped.

### 13.5 The rule for what to do with what you find

**A new document's failure is a §8 entry before it is a code change.** Record
the numbers, then decide. Several findings turned out cheaper to document than
to fix, and three are still deliberately unfixed with reasons written down
(§8.8, §8.21, §8.24).

Resist adding a constant. Every constant in this codebase that isn't derived
from the document is a per-document tuning knob in disguise.

---

## 14. How to start the next session (16 August)

Ordered. Everything here is polish or verification — no features.

### Step 1 — Fix the caption (§8.37). FIRST. ~40 minutes.

**This is the only visible bug and it appears at the best moment in the demo.**

In `VerdictMarkers.tsx`'s `Marker`:

- Drop `whitespace-nowrap`. Add `max-width` (the rect's width or ~220px),
  `overflow: hidden`, `text-overflow: ellipsis`.
- **Anchor from the RIGHT edge on RTL lines.** The rect sits near the page's
  right edge, so a left-anchored caption has nowhere to go. `FieldGeometry`
  does not carry direction — either add it, or derive from
  `markRect.x > viewport.width / 2` as a cheap proxy.

In `markerLabel`: **fall back to the field's own `label`** when
`value_or_instruction` is empty. Rule 9 is unreliable (§8.37) and the label is
deterministic.

Then re-run and look at the screen, not the console.

### Step 2 — The three degradation checks. ~45 minutes.

Each is "does it fail gracefully", not "does it work".

- **A scan or photo of a form** → must show "no text layer, editor works
  normally". Never tested. §6.12.
- **A 50+ page PDF** → editor must not die. §10.
- **Any AcroForm PDF** → must not crash. §9.8.

Run each through `smoke.ts` first and write the numbers down (§13.5).

### Step 3 — One other document through smoke. ~15 minutes.

§13.4's list, whatever is lying around. Watch for `lineSource: "clustered"` —
still the single most valuable unclaimed result.

### Step 4 — Small correctness TODOs. ~30 minutes.

- **`COPILOT_DEV` constant** replacing every `import.meta.env.DEV` (§8.38).
- **`CopilotPanel` line-keyed index** so a row with three verdicts shows more
  than the first (§8.36).
- **Consider defaulting the panel to tagged-only** (§9.1).
- Optionally: token estimate under the classify button (§11).

### Step 5 — Then 17 August is styling, 18 August is the speech.

See §15.

### What NOT to do

- **Don't add click-to-prefill.** Cut on product grounds (§9.4). It is also the
  one remaining change that could break what works — §6.4 documents three traps
  in a path that has never executed.
- **Don't fix two-column reading order (§8.21) or `literalBlanks` (§8.24).**
- **Don't tidy the prompt's structure (§8.35).** The language rule sits after
  the schema on purpose.
- **Don't strip the comments to "clean up" the code.** They are the material
  for the 18th. Write a workflow MD instead (§15).
- **Don't add a constant to fix a per-document surprise.** §13.5.

---

## 15. Demo plan (19 August)

### 15.1 The three-day shape

- **16th** — §14. Caption fix, degradation checks, small TODOs.
- **17th** — styling. Panel hierarchy, empty state, waiting state, verdict rows.
  Safe work: it cannot break correctness. Rehearse once at the end.
- **18th** — concepts and speech. No code. Rehearse 3–5 times, once on a clean
  Chrome profile.

### 15.2 Concepts to know cold

1. **Why no backend** — and what it buys (§3, §4). Easiest and strongest.
2. **Why the model sees all the text, not a list of blanks** (§3.1). The
   headline. The Harel untagged-clause transcript (§8.31) is the evidence.
3. **How a text answer becomes a coordinate** (§7.1, §8.9, §9.4).
4. **Sizes derived, never hardcoded** (§8.7, §13.1) — why the W-9 worked on the
   first attempt with zero code changes.
5. **What it deliberately does NOT do** — no prefill, no OCR, one page at a
   time, each with a reason (§9.4, §9.9). Knowing why you didn't build
   something is stronger than having built it.

### 15.3 Stories worth telling

- **§3.1 / §8.31** — discovery survived three simultaneous geometry defects on
  the W-9, and on Harel the model reasoned about a clause that has no checkbox
  drawn beside it. The architecture's central bet, paying off on transcript.
- **§8.20** — a claim marked ✅ turned out to be false, and what caught it was a
  tool built to print numbers rather than assert them. An engineering-judgement
  story, and rarer than a working feature.
- **§8.35** — a prompt rule that was being ignored started working when it was
  MOVED, not reworded. Concrete, surprising, and true.

### 15.4 Live-demo hazards

- **Classification takes 60–100 seconds** (§8.30). Have something to say. This
  is the natural moment for §15.2's architecture explanation.
- **If a run comes back thin**, the question box is the fallback and it is
  independent by design (§9.7). It recovered a real omission live (§8.28).
- **Don't press `g`** on stage unless you mean to (§8.25).
- **Re-verify the model name** that morning (§8.19).
- **Check §3.1's claim on the run you are about to show** (§8.31) — one badly
  chosen context makes the demo's best line unsupportable.

### 15.5 Test context — use these exact strings

**What is this document?**

```
Harel severance withdrawal form — my employer's pension provider sent it.
```

**What do you need to do?** (produces Hebrew values, §8.32)

```
I left my job in March 2026 and haven't started a new one. I want to withdraw
the severance in full. My name is משה כהן, ID 039274865, born 12/03/1985,
bank account at Leumi branch 800.
```

**Variant that demonstrates §3.1's untagged clause** (§8.31) — change "haven't
started a new one" to:

```
started a new job in June 2026
```

The model then reasons explicitly about `התחלתי לעבוד במקום חדש`, a clause with
no checkbox drawn beside it. **That is the demo's best single moment.**

- https://pdf-copilot.netlify.app/