# PDF Copilot — Project State & Session Handoff

**Phase 1 (editor): COMPLETE and stable.**
**Phase 2 (AI copilot): §9.3 AND §9.7 BOTH WORKING END TO END. Advice appears
per field; the follow-up question box answers free-text questions and was
tested five ways on the W-9. No markers on the page yet.**

**START HERE NEXT SESSION: §14.** It has the running order, what to test, when,
and how.

§9.4 is the only demo blocker and it has a PREREQUISITE — read §8.22 before
writing marker code. §13 covers making this work on documents other than the
two test files.

Read §1–3 for what this is, §7 for verification status, §8 for findings that
cost real time, §9 for what's left.

⚠ New this session: §8.20–§8.23. §8.22 is the one that changes the next
session's plan — a single line can carry SEVERAL CHECKBOXES, and the code keeps
only one.

---

## 0. Status

Phase 2 works end to end on two documents. Extraction is verified in-browser,
both AI calls are built, and §9.7 was tested five ways on a live provider.
Sections 9.1, 9.2, 9.3, 9.5 and 9.7 are done; 9.4 and 9.6 are not.

Roughly 85% of the way to a demo. What remains is one visual feature (§9.4),
one optional one (§9.6), restyling the panel, rehearsal, and one unverified
correctness property (§9.3's language separation, blocked on API credit rather
than on code).

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

### 3.1 Discovery is text-driven, geometry only enriches ✅ VALIDATED THREE TIMES

The original plan made blank detection a **gate**: find the blank
geometrically, then ask the model about it. That is wrong, and three
independent results now disprove it.

**Harel:** section ב has NINE eligibility clauses and only EIGHT checkboxes
(the clause beginning `התחלתי לעבוד במקום חדש` has no box drawn; confirmed by
rasterising). A gated design silently drops a real option.

**W-9 (§8.17):** the form draws no rectangles at all, so geometry finds 8
checkboxes and nothing else on a form that is mostly write-in fields. Line 1,
"Name of entity/individual", has no detectable affordance of any kind. **The
model returned "fill in" for it anyway.** Under the gated design the entire
form would have come back nearly empty.

**W-9, second session — the strongest one.** On page 1 the reading order is
visibly scrambled by column interleaving (§8.21), five checkboxes collapse into
a single line with one rect (§8.22), and the masthead is mistagged as a
write-in. **The copilot still returned correct, specific advice for every real
field, and correct reasons for every skip.** Discovery survived three
simultaneous geometry and ordering defects.

Say this out loud in the demo. It is the reason the risky parts are deletable.

**So: the model sees the whole document text and decides what the fields are.**
Geometry answers only "where exactly does a mark go, and how much room is
there." If every geometry detector returns nothing, the copilot still works —
every field is still found, explained, and listed. Only placement degrades.

Preserve that property. It is the reason the risky parts are deletable.

### 3.2 What goes to the model, and what never does

- **Coordinates never go.** `classify.ts`'s `projectLines` re-projects each
  line field by field rather than spreading it, so a coordinate added to
  `PayloadLine` later cannot silently start being uploaded.
  ⚠ **`projectLines` is now shared with `ask.ts`** and is the ONLY
  serialisation of document data in the codebase. One function, one audit. Do
  not write a second one.
- **Cell counts DO go**, because they change the answer. "Nine cells, one
  character each" produces nine digits. A six-cell date wants DDMMYY, an
  eight-cell one wants DDMMYYYY.
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

⚠ **`CopilotPanel`, `ContextForm` and the `AskBox` question field all sit
inside `Shell`, which carries `data-editor-chrome`.** Without it, every click in
the panel — and every keystroke in the API key field or the question box —
deselects whatever annotation the user is holding. Every early-return branch in
`CopilotPanel` renders through `Shell`, so the error paths can't lose it.

**Everything is `click`, never `pointerdown`, at the layer level.** Pointerdown
fires before an open textarea's blur, so the new box's `editingId` gets cleared
by the old box's blur. Individual annotations still use pointerdown for drag.

⚠ **OPEN, one look to settle:** if `AnnotationLayer` binds Delete/Backspace at
DOCUMENT level rather than on the layer element, typing in the question box or
the API key field will delete the selected annotation. `ContextForm` has had
this exposure all along, so it may already be fine. The fix if it bites is a
target check in the layer's handler, NOT `stopPropagation` on each input —
that patches one field and leaves the next one broken. TODO is in
`CopilotPanel.tsx` on the textarea.

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

| File                  | Role                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `extract-text.ts`     | page → ordered lines, logical order, PDF points, readability flags                            |
| `extract-geometry.ts` | operator list → checkboxes, combs, dashed leaders. Document-level. Never throws.              |
| `detect-field.ts`     | joins the two; emits model payload (no coordinates) + client map (coordinates only)           |
| `run-extraction.ts`   | orchestrates the three, owns the failure policy, returns one object                           |
| `verify.ts`           | dev-only; asserts the §7.2 table against the Harel baseline                                   |
| `provider.ts`         | **NEW.** The ONE place that talks to a provider. Config, both request shapes, timeout, errors |
| `classify.ts`         | §9.3 — the classification task: prompt, `projectLines`, JSON parsing                          |
| `ask.ts`              | **NEW.** §9.7 — the follow-up question task: prompt, history flattening, prose out            |
| `copilotStore.ts`     | provider, key, context answers, classifications, ask thread                                   |
| `ContextForm.tsx`     | provider dropdown, masked key field, two free-text questions                                  |
| `CopilotPanel.tsx`    | the field list, verdicts, degraded-state notices, `AskBox`                                    |

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
It is gated on the filename containing the fixture's name — without that gate
it reports seven failures on every other PDF you open.

**W-9 baseline (2-page trimmed copy, this session):**
page 1 = 89 lines / 12 tagged; page 2 = 139 lines / 1 tagged; checkbox
histogram 8.0pt × 8; zero "text unclear" badges, i.e. §8.16's gate correctly
suppressed the corruption rule on a ~100% Latin document.

### 7.3 The LTR code path — PARTIALLY validated

Checkbox detection runs correctly LTR: the W-9 yields 8.0pt × 8, matching its
seven classification boxes plus 3b. `literalBlanks` has now fired for the first
time (§8.20).

**Still unvalidated:** `edgeDistance`'s LTR branch and `offsetMark`'s LTR
branch have never been checked against a rendered position, because markers
don't exist yet (§9.4).

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

✅ **The literal-run signal is implemented** (`literalBlanks` in
`detect-field.ts`): `_(?:\s?_){2,}`, `\.(?:\s?\.){4,}`, `-(?:\s?-){3,}`.
Thresholds differ per character and are set by what they must NOT match —
`...` ellipsis, `1.1.2008`, `co-op`, `well-known`. Verified zero matches across
all three Harel pages. ✅ **Now fired for real — see §8.20.**

Gap threshold is one em of the adjacent text, not a constant.

⚠ **Known false positive, accepted:** Harel page 2's unsubscribe line has a
51.7pt gap and gets a `writeIn` tag. Real blanks measure 74–261pt, so
separating them needs a hardcoded number — which this codebase avoids. Tags
enrich and never gate, so the model reads the line and correctly calls it
prose. **Do not "fix" this with a constant.** The W-9's masthead
(`Department of the Treasury / Internal Revenue Service / Go to www.irs.gov…`)
produces the identical false positive for the identical reason — a genuine
multi-column gap — and the model correctly ignored it there too.

**Cross-check worth keeping:** page 1's leaders sit at y = 613, 450, 181, 139 —
exactly the baselines where text-gap analysis independently finds blanks.

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

⚠ **`matchCheckboxes` keeps only ONE box per line — NO LONGER INVISIBLE.**
See §8.22. This is now a §9.4 prerequisite, not a deferred nicety.

### 8.10 Calibrated mark offset

Checkboxes sit a stable distance from their line's text edge: median 2.75 /
2.44 / 2.75 across the three Harel pages. Learn it from the boxes that exist,
then apply it to lines where **no box was drawn** — so the `התחלתי לעבוד`
clause gets its mark exactly where a box would have been.

`markOffset` is exposed on `DetectionResult`.

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

⚠ **THIS FIX WAS APPLIED TO COMBS ONLY.** Checkboxes and gap-blanks still key
by line. §8.22 is that omission coming due.

### 8.13 Duplication to clean up

`extract-geometry.ts` exports `combCellRect` (single rect) and
`detect-field.ts` has a private `cellRects` (array) doing the same job.
Nothing will flag it — an exported function is never "unused." Delete the
export from `extract-geometry.ts`.

### 8.14 ⚠⚠ THE CONTENT STREAM IS NOT IN READING ORDER

pdf.js emits items in the order the producer wrote them. **InDesign writes one
text frame at a time, in the order the frames were created.** Measured on the
fixture:

- page 1 — section א (y 586), then ג (y 209), then ב (y 508)
- page 2 — ה, ד, ו, ח, ט, ז

Within a frame the lines are fine — only 5 of page 1's 52 break monotonic
descent. Whole **blocks** arrive shuffled.

**Fix: sort each page's lines by y descending.** Stable sort, so lines sharing
a baseline keep stream order for free. Gets both Harel pages exactly right.

⚠ **FRAME GROUPING WAS TRIED AND FAILS — do not re-attempt.** Grouping
consecutive lines while y descends, then sorting the groups, produces 6 groups
on page 1 and 4 on page 2, none aligned to the real sections, because blocks
chain into one another with no detectable boundary. Page 1 still came out
א → ג → ב.

⚠ **KNOWN LIMIT: two-column pages interleave.** Predicted here, now CONFIRMED
on a real document — see §8.21.

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
merged runs, not correctness. Harel runs at 2.2–3.3 because v6 merges Hebrew
heavily (§6.11); a dense English page merges far less and legitimately exceeds 8.

**Revision 2** used the right measurement with `some()`, which failed a whole
page on one odd group.

**Revision 3 — CURRENT.** A line is text sharing a baseline, so measure that:
a group's vertical spread against its own tallest glyph. Fall back only when
more than **25%** of a page's groups exceed 3×.

Scale separation makes the threshold uncritical: superscripts sit at 0.33×, a
group holding a whole page sits at ~78×. Three orders of magnitude.

**The clustering fallback, measured.** Forcing it on the fixture yields
50 / 48 / 24 against the correct 52 / 48 / 24. The two merges are both the
sidebar advert gluing onto body lines.

⚠ `משיכה חלקית` is a real field, and the merge extends its `line.maxX` across
the advert. `edgeDistance` and the calibrated offset both measure from that
edge, so **on the fallback path a checkbox mark for that line can land hundreds
of points off.** If marks look wildly misplaced on a non-InDesign PDF, look here
first.

⚠ **STILL NEVER FIRED ON A GENUINELY BROKEN DOCUMENT.** Only via a forced
threshold. The W-9 did NOT trigger it, which is itself useful — an IRS PDF is a
non-InDesign producer and its `hasEOL` markers are sound.

`ExtractedPage.lineSource` is `"eol" | "clustered"` and the panel says so.

### 8.16 ⚠ The corruption rule must be gated by document script

§8.4's rule flags lowercase-then-uppercase inside a word. On an English
document it flagged `SaaS`, `JavaScript`, `TypeScript`, `PayPal`, `macOS`,
`iPhone`, `PostgreSQL`, `YouTube` — 8 distinct, 22 occurrences, every one a
false positive.

**Gate: suppress the rule when Latin exceeds 15% of the document's letters.**
Measured on Harel: 1.59% document-wide. An English document sits near 100%.

✅ **Re-confirmed on the W-9 this session:** zero "text unclear" badges across
both pages of a ~100% Latin document.

**Placement matters.** `extract-text.ts` computes `suspectRanges`
unconditionally and reports `letters: { latin, rtl }` per page;
`detect-field.ts` decides whether to surface `unreliableText`.

**Document-level, not per page**, so an English appendix inside a Hebrew form
still gets checked.

`DetectionResult.corruptionCheckApplied` exposes the decision.

### 8.17 ⚠⚠ US FORMS BUILD BOXES FROM UNCONNECTED STROKES

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

**And the copilot works anyway.** See §3.1.

⚠ A rule-bounded-box detector is **optional**, affecting placement only. It is
harder than it looks: the same "thin, long, horizontal stroke" is table
furniture on Harel and a field boundary on the W-9. Distinguishing them
probably needs the model, not more geometry.

### 8.18 Groq free tier cannot fit a Hebrew document

The Harel payload measures **12,266 JSON characters, of which 6,159 are
Hebrew**. Llama's tokenizer has poor Hebrew coverage — roughly one token per
character — giving **~7,700 input tokens, ~8,200 with the system prompt**.

Groq's free tier caps `llama-3.3-70b-versatile` at **12,000 TPM**, and
**counts `max_completion_tokens` toward the estimate before the request runs**.
Actual response: `Limit 12000, Requested 13541` — note Groq's own estimator
implies ~10,541 input, higher than our count.

`maxTokens` is per-provider in `PROVIDER_CONFIG`: 8000 for Anthropic and
OpenAI, 3000 for Groq.

⚠ **OPEN QUESTION, two minutes to settle:** `ask.ts` requests only 1,200
output tokens, so a follow-up question MAY fit on Groq where classification
cannot. The ask box does not depend on classification — open the Hebrew
fixture, skip the classify button, ask one question. If it 413s, the body names
both numbers; record them and close this. Not attempted yet.

**Groq is for pipeline testing on Latin documents. Not for the Hebrew demo,**
and not for judging output quality.

### 8.19 Provider notes

- **Anthropic requires `anthropic-dangerous-direct-browser-access: true`** for
  browser calls. Without it, CORS rejection looks like a network failure.
- **Groq is OpenAI-compatible** — same request body, same response shape. Three
  providers, two request shapes.
- **`fetch` rejects with `TypeError` for both network failure and CORS.** On
  this extension that almost always means a missing `host_permissions` entry.
  Chrome does not apply manifest permission changes on hot reload — reload the
  extension.
- Model names live in ONE place, `PROVIDER_CONFIG` (now in `provider.ts`). They
  move; verify before a demo. Groq's catalogue rotates fastest.

### 8.20 ✅ `literalBlanks` FIRED FOR THE FIRST TIME — W-9, NEW

The dot-leader pattern `\.(?:\s?\.){4,}` matched line 3b's nine-dot run
(`See instructions . . . . . . . . .`). The LLC line directly above it, with
four dots, did not match.

§8.8's thresholds were set entirely by what they must NOT match and had never
been exercised on any document. This is the first document to exercise them,
and the split fell where intended.

⚠ **Confirm the BADGE, not just the dots.** Dots appearing in extracted text is
not evidence the pattern ran — the `writeIn` badge on that row is. Partially
confirmed this session; finish the check next time the W-9 is open.

### 8.21 ⚠ TWO-COLUMN PAGES DO INTERLEAVE — confirmed, NEW

§8.14 predicted this and accepted it as a known limit on the grounds that
bureaucratic forms are single-column. **W-9 page 1 is not.** Line 4
(Exemptions) sits in a right-hand column beside 3a and 3b, and the y-descending
sort splices its lines between the left column's. The panel order is visibly
wrong in that region.

**Blast radius is smaller than it looks, and this was measured, not assumed:**

- **Placement: UNAFFECTED.** Marker coordinates come from `detect-field.ts`'s
  geometry map, never from list position.
- **Panel readability: degraded** in that region only.
- **Model context: degraded, and survivable.** The model still classified 3a
  and 3b correctly, with correct reasons, on this exact page.

**Not fixable by §8.14's route** — frame grouping was tried and failed there,
and that was a different problem (stream order, not columns). A real fix means
clustering lines by x-extent into column bands and sorting within each band
before merging. **Not committed:** it needs a rule for when a page IS
two-column, and getting that wrong scrambles a single-column form, which is the
common case. `page.getStructTree()` remains the correct answer for tagged PDFs.

Deferred. See §9.9.

### 8.22 ⚠⚠ SEVERAL CHECKBOXES ON ONE LINE — §9.4 PREREQUISITE, NEW

W-9 line 3a extracts as a SINGLE line carrying five options:

```
Individual/sole proprietor   C corporation   S corporation   Partnership   Trust/estate
```

Five drawn checkboxes, one extracted line. Two detectors collapse it, both for
the same reason — **they key by line, not by run**:

- `matchCheckboxes` keeps **one box per line** (§8.9). Four of the five boxes
  get no rect at all.
- `hasWideGap` emits **one** `writeIn` for the line regardless of how many gaps
  it found. The gaps here are the spaces between the five options, so the whole
  option row reads as one big blank.

§8.12 solved exactly this for combs by keying affordances to **runs**, which is
why `overlappingRun` returns the run rather than a boolean. **Checkboxes and
gap-blanks never got the same treatment.** On Harel that was invisible. On the
W-9 it is plainly visible.

**Discovery is unaffected — verified.** One line means one id, so the model gets
one row to answer in, and it answered correctly: "check Individual/sole
proprietor." The panel looks right.

⚠ **§9.4 IS WHERE THIS BREAKS.** That single verdict maps to a single rect, and
the rect belongs to whichever box was drawn first. **The marker lands on the
wrong checkbox, and on a row of five identical boxes nobody will notice.** This
is the same class of silent-wrong-value error as §8.11.

**Decide before writing marker code**, options in increasing cost:

1. Ship it and accept wrong placement on multi-option rows. Cheapest, and the
   question box (§9.7) covers the user who notices.
2. Suppress markers where a line has more boxes drawn than fields tagged — no
   marker beats a confidently wrong one.
3. Make `matchCheckboxes` run-keyed, mirroring `matchCombs`. Correct, and the
   pattern already exists to copy.

Moved OUT of §9.9's deferred list.

### 8.23 §9.7's design decisions, now tested rather than assumed — NEW

Verified live on Groq / llama-3.3-70b-versatile against the W-9, five questions,
five passes. Notable because Llama is the WEAK model — §8.18 warns it is where
prompt rules drop first, so these results are a floor, not a ceiling.

- **History flattening works.** "And the one right after it — does that apply
  to me?" resolved to 3b with no restatement. `ProviderRequest` carries ONE
  message and the transcript is flattened into it (§9.7); real chat roles were
  not needed. Do not add a `messages` array until something actually fails.
- **The hardcoded English rule works.** A Hebrew question (`?מה זה TIN`) against
  an English document returned English.
- **Both refusal rules held**, and these matter most. "What's the deadline?"
  returned "not specified in the provided form, check with the client" rather
  than inventing one. "How do I fill in Schedule K-2?" declined and pointed at
  Form 1065's instructions rather than answering from memory. These are the
  rules protecting a user from a confident wrong answer about their own
  eligibility.
- **Skips carry reasons**, as designed.

---

## 9. Phase 2 — what's left

### 9.0 Recommended order

**§9.4 is the only thing blocking a demo.** Read §8.22 first and pick one of its
three options before writing marker code — the decision changes what you build.

§9.6 is optional. Panel restyling is real but cosmetic.

### 9.1 ✅ DONE — pipeline + panel

Extraction wired into `App.openFile`, §7.2 numbers confirmed in-browser,
`CopilotPanel` lists every line with page grouping and click-to-navigate.

⚠ The panel defaults to **all lines**, not tagged-only. Flip the default once a
second Hebrew issuer is tested. The toggle stays regardless.

### 9.2 ✅ DONE — context intake

Provider dropdown, masked key field disabled until `chrome.storage` has been
read, "Forget this key", and the two free-text questions. Key persists; context
answers are in-memory only.

Switching provider clears the key — only one `{ provider, apiKey }` pair is
stored, and an Anthropic key sent to OpenAI produces an auth error that reads
like a broken integration.

### 9.3 ✅ DONE — the AI call

`getFieldClassifications(payload, context, provider, apiKey)` in `classify.ts`.
Every line goes, not a filtered list. Returns
`{ id, fill: "fill"|"skip"|"unclear", value_or_instruction, reason }`.

Transport moved to `provider.ts` this session; behaviour unchanged.

- Ids validated against the payload; unknown ids dropped, with a dev-only
  warning.
- 90s timeout via `AbortController`.
- Every failure path returns a readable message — never a thrown error, never a
  silent hang.
- ⚠ **The JSON parse has its OWN try/catch**, because `callProvider` has already
  returned successfully by then. Removing it turns a malformed reply into an
  unhandled rejection and the panel spins forever.
- Markdown fences stripped before parsing.

**⚠ THE LANGUAGE SEPARATION IS STILL THE RULE MOST LIKELY TO FAIL INVISIBLY.**
`reason` in the user's language; `value_or_instruction` in the FORM's language
and script. **Not yet verified on the Hebrew fixture — blocked on API credit,
not on code.** Groq can't run it (§8.18). This is the single remaining
correctness unknown in Phase 2.

**Demonstrated on the W-9** (Groq): correct fills, correct skips with reasons,
and page 2 — pure instructions — returned nothing at all. That last result
matters as much as the others: the natural failure mode of "consider every
line" is over-eagerness, and it didn't happen.

### 9.4 Wiring results into the editor — NOT STARTED — THE LAST FEATURE

Colour-coded markers (fill / skip / unclear) at the coordinates from
`detect-field.ts`'s client map, plus click-to-prefill.

⚠⚠ **READ §8.22 FIRST AND PICK AN OPTION.** A row of five identical checkboxes
maps to one rect. Wrong-box placement is silent.

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
`PROVIDER_CONFIG.openAiCompatible`, now in `provider.ts`. No
`if (provider === …)` anywhere in UI code. Adding a compatible provider is a
one-line change.

**Still open:** web search grounding is wired differently per provider. Decide
which one gets it before building §9.6.

### 9.6 Web search grounding — NOT STARTED, optional

Only when the model flags genuine uncertainty (e.g. a legal eligibility rule),
not every field. Needs a timeout so a slow search never hangs the UI.

`provider.ts` already takes `timeoutMs` per call, so the plumbing exists.

### 9.7 ✅ DONE — follow-up question box

A free-text box pinned at the bottom of the panel, with the extracted document
text already in context. Markers answer "what goes in this field"; this answers
"what does מס שבירה mean" and "I have a loan against the account, does that
change which box I tick."

**Shape:**

- `ask.ts` — prompt, history flattening, prose out. No parsing.
- 45s timeout (not 90 — a user watching a box will reload, and a reload loses
  the extraction AND every annotation).
- 1,200 output tokens.
- History: last **3** exchanges, each remembered answer truncated to 500 chars.
  Questions kept whole. Cost stays flat instead of growing per question.
- **English answers, hardcoded**, except a literal value to type, which stays in
  the form's script.
- ⚠ **`askThread` never holds a half-turn** — the in-flight question lives in
  `pendingQuestion`. The thread is resent to the model as history, so a turn
  with an empty answer would upload `A:` followed by nothing.
- ⚠ **`ask()` returns a boolean** so the panel clears its textarea only on
  success. The draft is local state; failing shouldn't delete what they typed.
- ⚠ **Independent of classification by design.** Reads no `status`, no
  `classifications`, not blocked while classification runs. That independence
  IS §10's network-failure fallback. Don't "tidy" it by gating the box.
- ⚠ **Not a `<form>`** — a real form on an extension page submits and navigates,
  unmounting the viewer and losing everything.
- **Deliberately NOT sent: the classifications.** So "why did you say skip on
  that line?" is answered poorly. Left out on token cost. If added, send only
  verdicts near the line in question, never all of them.

Tested five ways — see §8.23.

**TODO left in `CopilotPanel.tsx`:** auto-scroll to the newest turn (use a
LAYOUT effect, not `useEffect` — a passive effect scrolls after the browser has
painted the pre-growth height and flashes), and the §6.10 Delete-key check.

### 9.8 Phase 3, only if time remains

AcroForm explanation layer. **Neither test document has an AcroForm**, so this
needs a third document to demo at all.

### 9.9 Deferred, with reasons

- **Two-column reading order (§8.21)** — panel readability and model context
  only; placement unaffected, and the model classified correctly through it.
  Needs a "is this page two-column" rule that can't scramble the common case.
- **Rule-bounded box detection (§8.17)** — placement only; the same geometry
  means opposite things on the two test documents.
- **Per-page chunking of the payload** — needed for 50+ page documents. ⚠ Cost
  is real: Harel page 3 lists which documents to attach _depending on which
  withdrawal type was picked on page 1_. Chunking breaks that link. A fallback,
  not a default.
- **Absolute size floor for checkbox candidates (§8.7)** — cheap second guard.
- **Sending classifications to `ask.ts`** — token cost; see §9.7.
- **Panel restyling** — real work, cosmetic. `LineRow`, `AskBox` and the badges
  all carry TODO markers; structure and `data-editor-chrome` are the
  load-bearing parts and are safe to build around.

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
- [x] Corruption gate: suppressed on an English document, re-confirmed on W-9
- [x] An English **form** — W-9, checkbox detection validated LTR
- [x] `literalBlanks` fires on a real document (§8.20) — badge check pending
- [ ] A second Hebrew form from a different issuer
- [ ] A non-InDesign PDF where the `hasEOL` guard actually FIRES (§8.15). The
      W-9 is non-InDesign but its markers are sound, so this is still open
- [ ] An AcroForm PDF — confirm it degrades rather than crashes

**Copilot**

- [x] API key flow: first-run prompt, persists, doesn't re-ask
- [x] Visible error if key missing or invalid — never a silent hang
- [x] Verdicts render per line with reason and value
- [x] Model does NOT over-classify prose (W-9 page 2 returned nothing)
- [x] Skips carry reasons
- [x] Question box: grounding, history, language, and both refusal rules (§8.23)
- [ ] **Hebrew demo: explanations in English, values in Hebrew** ⚠ unverified,
      blocked on paid credit
- [ ] Field-to-line mapping stable on repeated runs
- [ ] Both providers produce correctly-structured JSON on the same document
- [ ] Provider switch relabels/clears the key field (implemented, untested)
- [ ] ID number lands in cells **right to left** (§8.11) — blocked on §9.4
- [ ] Multi-option row markers (§8.22) — blocked on §9.4
- [ ] Web search has a timeout — blocked on §9.6
- [ ] Groq + Hebrew + ask at 1,200 tokens: fits or 413s (§8.18) — 2 minutes

**Overall**

- [x] Network-failure fallback exists (the question box, §9.7)
- [ ] `App.openFile` calls `resetResults()` on a new document — CHECK THIS.
      Without it the old thread carries over and is resent as history for a
      document that is no longer open
- [ ] Full demo rehearsed 3–5+ times on the exact file being presented
- [ ] Tested on a clean Chrome profile
- [ ] `verify.ts` filename gate in place, or removed entirely
- [ ] Paid API credit topped up (Groq cannot run the Hebrew fixture — §8.18)

---

## 11. Ideas and open questions (not committed)

- **OCR — explicitly cut.** Would be the fallback for §8.4 and scanned pages.
  (If it happens: Tesseract needs `heb` loaded explicitly.)
- **Extraction-quality signal as a first-class concept.** Partly built —
  `lineSource`, `geometryOk`, `readable`, `corruptionCheckApplied`.
- **`page.getStructTree()`** for reading order on tagged PDFs (§8.14, §8.21).
- **Column detection** for two-column pages (§8.21).
- **`messages` array on `ProviderRequest`** — only if history flattening starts
  losing the thread. It hasn't (§8.23).
- **`TextLayer.update({ viewport })`** repositions spans instead of rebuilding
  on zoom. Not worth doing until something feels slow.
- **Canvas blanks on every zoom step.** Render to a detached canvas, swap on
  completion. Cosmetic.
- **Signature is a raster.** `embedPng` means slightly soft at high zoom.
- **Filled checkboxes** — the size histogram pools stroked and filled
  deliberately. Risk: a document whose bullet markers are small filled squares
  out-voting real checkboxes. Fix if it trips: prefer the stroked cluster.
- **Slide decks** will produce phantom checkboxes — harmless: tags enrich, the
  model reads slide text and finds no fields.

---

## 12. Working conventions

- Explain the file and its non-obvious parts before writing code.
- One file at a time.
- Skeletons with TODO blocks; the human writes the component logic.
- The cancellation pattern in §6.8 is reused for every long-running pdf.js op.
- Comments earn their place by recording _why_, especially where the code looks
  wrong and isn't. `ltrFontkit`, the inline-style rules in `TextAnnotation.tsx`,
  the opcode-stride switch in `extract-geometry.ts`, the alpha-run tokenizer in
  `findSuspectRanges`, the reading-order sort, and `projectLines`' field-by-field
  rebuild are all in that category.
- **Verify claims against the fixture rather than reasoning about them.** Nearly
  every finding in §8 contradicted a confident prior assumption.
- **Test on whatever PDF is lying around.** This is now four sessions running
  where the non-fixture document produced the session's most important finding.
  §8.20, §8.21 and §8.22 all came from the W-9, and §8.22 changes the next
  session's plan.
- **Refactor before adding the second caller, not after.** §9.7 was described as
  "one API call on machinery that already exists" — it wasn't, because the
  machinery was welded to `classify.ts`. Extracting `provider.ts` first cost one
  file and prevented two timeout values, two error vocabularies, and a second
  place the API key could be logged.

---

## 13. Generalising beyond the two test documents

The goal is a copilot that works on whatever form a user opens, not on two
known files. This section records how close that already is, where it isn't,
and the cheapest thing that would make every new document faster to evaluate.

### 13.1 What is already generic — do not "improve" these into constants

Almost nothing in `copilot/` is bound to a specific document. That was
deliberate (§8.7) and it is why the W-9 worked on the first attempt without a
single code change.

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
Verified three times, most convincingly on W-9 page 1 with three simultaneous
defects.

### 13.2 What is rule-based but only ever exercised on two documents

These are the places a third document is most likely to hurt. Note they are
**producer-shaped, not language-shaped** — which is what §13.4 acts on.

- **Line splitting (§8.15).** The `hasEOL` guard has NEVER fired on a real
  document; both test files have sound markers. On the fallback path text
  degrades slightly and **placement degrades badly**. Highest-risk unknown.
- **Reading order (§8.14, §8.21).** y-descending. Correct on single-column,
  interleaves on two-column. Confirmed on W-9 page 1.
- **Checkbox mode needs ≥3 occurrences (§8.7).** A form with two checkboxes
  total gets none. Correct behaviour, worth knowing before it surprises you.
- **The 15% Latin gate (§8.16).** Harel sits at 1.6%, the W-9 near 100%.
  Nothing has ever landed near the boundary. A genuinely bilingual form is
  untested.
- **Form idiom (§8.17).** Harel and the W-9 are already two incompatible
  idioms — inline gaps vs regions bounded by unconnected strokes. Assume a
  third exists.

### 13.3 ⚠ BUILD THIS FIRST: a generic smoke report

`verify.ts` asserts hardcoded fixture numbers and is meaningless elsewhere.
What is missing is its generic cousin: **open any PDF, read six numbers, know
in ten seconds whether extraction worked.**

No assertions, no expected values, no per-document baseline. Just what
extraction concluded, printed.

**Suggested shape — `copilot/smoke.ts`, dev-only, called from
`run-extraction.ts` behind `import.meta.env.DEV`:**

| Signal                                 | Source                            | Read it as                            |
| -------------------------------------- | --------------------------------- | ------------------------------------- |
| lines per page                         | `ExtractedPage.lines.length`      | 1 per page = line splitting failed    |
| tagged lines per page                  | payload entries with `fields`     | 0 everywhere = geometry found nothing |
| `lineSource`                           | `ExtractedPage.lineSource`        | `"clustered"` = §8.15 fired           |
| `quality`                              | `ExtractedPage.quality`           | `"empty"` = scan, copilot off         |
| checkbox mode + occurrence count       | `DocumentGeometry.checkboxSize`   | mode from <3 = no confident size      |
| `geometryOk`                           | `Extraction`                      | false = placement approximate         |
| `corruptionCheckApplied` + Latin %     | `DetectionResult`, `page.letters` | shows which side of the 15% gate      |
| first 3 and last 3 line texts per page | `lines`                           | eyeball reading order in one glance   |

Most of these already exist and are already computed — this is surfacing, not
new detection. §11 has been calling this "extraction-quality as a first-class
concept" and it is now half-built by accident.

**Why it is worth a session's opening hour:** every document tested afterwards
costs ten seconds instead of a manual panel inspection, and the numbers are
directly quotable into a new §8 finding.

### 13.4 What to collect, and why these four

Bring documents from **different producers**, not different languages. Language
is mostly handled; producers are what break line splitting and geometry.

1. **Word / Google Docs export** — most likely thing to fire §8.15's guard for
   the first time. Highest information value of the four.
2. **A government e-file PDF that is not the W-9** — tests whether a third form
   idiom exists (§8.17).
3. **A scan or photo of a form** — must return `readable: false` and say so in
   the panel. Never tested; §6.12 flags it.
4. **A second Hebrew issuer** — the one gap that IS language-shaped, and the
   only way to trust RTL beyond a single form.

Whatever is lying around beats anything sought out. Four sessions running, the
non-fixture document produced the session's most important finding.

### 13.5 The rule for what to do with what you find

**A new document's failure is a §8 entry before it is a code change.** Record
the numbers, then decide. Three of the last four sessions' findings turned out
to be cheaper to document than to fix, and two of them (§8.8's false positive,
§8.21's interleaving) are still deliberately unfixed with reasons written down.

Resist adding a constant. Every constant in this codebase that isn't derived
from the document is a per-document tuning knob in disguise.

---

## 14. How to start the next session

Ordered. Each step says what, when to stop, and what to write down.

### Step 0 — Confirm the two open checks (10 minutes)

Neither needs code.

- **`App.openFile` calls `resetResults()`?** Grep it. If not, add it. Without
  it, opening a second document carries the old ask thread over and resends it
  to the model as history for a document that is no longer open.
- **The `writeIn` badge on W-9 line 3b.** Dots in the extracted text are not
  proof `literalBlanks` ran (§8.20). Open the W-9, find 3b, look for the badge.
  Confirm the LLC line above it does NOT have one. Then §8.20 is closed.

### Step 1 — The Groq/Hebrew question (2 minutes)

Open the Hebrew fixture, **skip the classify button**, ask one question in the
box. The ask call requests 1,200 output tokens where classify requests 3,000
(§8.18).

Record either "fits" or the two numbers from the 413 body. Then §8.18 is closed
either way.

### Step 2 — Build the smoke report (§13.3)

One file, dev-only, no assertions. Everything after this step gets faster.

### Step 3 — Run every document you brought through it (§13.4)

For each: open it, read the smoke output, glance at the panel. **Do not fix
anything yet.** Write the numbers down first — §13.5.

Stop and take note especially if:

- `lineSource` comes back `"clustered"` → §8.15 fired for the first time ever.
  This is the single most valuable result available right now. Record which
  producer did it and what the panel looked like.
- tagged count is 0 on a form that clearly has fields → a third form idiom
  (§8.17). Not a bug; a finding.
- `quality: "empty"` on the scan → correct behaviour, tick §10.

### Step 4 — §9.4, the last feature

⚠ **Read §8.22 and pick one of its three options before writing marker code.**
A row of five identical checkboxes maps to one rect, and wrong-box placement is
silent. The decision changes what you build.

Then, in this order, because each one is a trap that masks the next:

1. Render markers read-only first — no click-to-prefill. This validates
   §7.3's untested LTR branches (`edgeDistance`, `offsetMark`) against a
   rendered position for the first time. Check both a Hebrew and an English
   document; the two branches are separate code.
2. Add click-to-prefill for plain text boxes. ⚠ §6.4 — a box mounting with
   content already in it has never executed. If pre-filled boxes come out one
   line tall, the measurement order is the cause, not the marker code.
3. Add comb cells last. ⚠ §8.11 — a 9-digit ID fills cell index 8 down to 0 on
   an RTL form. Filling 0 upward writes it mirrored and looks entirely
   plausible on screen. **Verify by exporting and reading the PDF, not by
   looking at the editor.**

### Step 5 — Stop

§9.4 done, or one of its three sub-steps done, is a complete session. §9.6 is
optional and panel restyling is cosmetic; neither blocks a demo.

Update §8 with anything new, tick §10, and write the next session's starting
point at the top of this file.

### What NOT to do next session

- Don't fix the two-column reading order (§8.21). Placement is unaffected and
  the model classified correctly through it.
- Don't build rule-bounded box detection (§8.17). Placement only, and the same
  geometry means opposite things on the two test documents.
- Don't add a constant to fix a per-document surprise. See §13.5.
- Don't restyle the panel until §9.4 renders, or you will style it twice.
