# PDF Copilot — Project State & Session Handoff

**Phase 1 (editor): COMPLETE and stable.**
**Phase 2 (AI copilot): COMPLETE and verified in both scripts, on three
documents, in two builds.**
**Deployed: https://pdf-copilot.netlify.app/**

**DEMO IS 19 AUGUST. Two working days left: 17, 18 — and the 18th is spare.**

**START HERE NEXT SESSION: §14.** Nothing in it is a feature or a fix; it is
documentation, polish and rehearsal.

Read §1–3 for what this is, §7 for verification status, §8 for findings that
cost real time, §13 for generalisation limits, §15 for the demo plan, §16 for
submission requirements.

⚠ New this session — the two most consequential:

- **§8.39 — a THIRD form idiom.** Checkboxes as `❑` characters in the text
  layer, no vector shapes at all. `literalBlanks` fired for the first time in
  the project's history on the same document.
- **§8.41 — a diagnostic log printed a filtered subset while reporting a
  total**, and read as a silent data loss for three debugging rounds. Same
  shape of mistake as §8.20.

Also: the caption bug is fixed, the panel is restyled and dense, click-to-
highlight is built, and the whole thing deploys as a static site.

---

## 0. Status

Everything on the pre-demo path is done. What remains is the explainer, a
cleanup pass, a logo, the video, and rehearsal.

**Known-unfixed, all deliberate:** one-page-per-request on dense Hebrew
(§8.30, §8.40), two-column reading order (§8.21), `literalBlanks` granularity
(§8.24). Each has a reason written down and each is safe to say out loud.

**Untested:** an AcroForm PDF (skipped — §9.8), a document that fires the
`hasEOL` guard (§8.15), a clean Chrome profile.

---

## 1. What this is

A tool that lets you edit and sign any PDF in the browser, then uses AI to tell
you — field by field — what to fill in, what to skip, and why, based on your
own stated situation. It also answers free-text questions about the form. No
server, no database, no accounts.

**Two builds from one source** (§3.3): a Chrome extension, and a static site.

## 2. The problem it solves

Filling a bureaucratic form today means uploading the PDF to an AI chat, asking
what to fill, getting prose back, then going to a _separate_ tool to type into
the PDF — working out yourself where each described field sits.

This collapses that into one flow: the AI's answer and the place you act on it
are the same interface, and the answer is tied to real coordinates instead of
prose you have to translate.

**Note the boundary, and state it in the demo (§9.4):** the copilot tells you
what belongs in each field and marks where it goes. It does not type for you.
Those are different claims, and the second is not needed for the first to be
useful.

## 3. Core architecture decisions

**No backend, no database.** Nothing persists across sessions except the API
key. No document leaves the browser except as text sent directly to the AI
provider, and only when the copilot is used.

**BYOK.** User pastes their own key. Stored via `copilot/storage.ts`, which
picks `chrome.storage.local` or `localStorage` depending on the build (§4).

**No auth system** — there's nothing to authenticate _to_.

**pdf.js for viewing/reading, pdf-lib for editing/export.**

**Don't re-upload the PDF to the AI.** Something has to map "fill in your name"
to an x/y position, and that has to be our client-side code. Local extraction
is needed regardless, so the cheap payload is free.

**Native AcroForm rendering left untouched.** True AcroForms already render as
interactive fields via pdf.js's AnnotationLayer. No test document has one.

### 3.1 Discovery is text-driven, geometry only enriches ✅ VALIDATED ON THREE DOCUMENTS

The original plan made blank detection a **gate**: find the blank
geometrically, then ask the model about it. That is wrong, and three
independent documents disprove it.

**The Hebrew fixture.** Section ב has NINE eligibility clauses and only EIGHT
checkboxes — the clause beginning `התחלתי לעבוד במקום חדש` has no box drawn.
**With the "started a new job in June 2026" context the model returns a verdict
on that clause itself**, quoting its text and rejecting it on the arithmetic:
new job ~3 months after leaving, not the 13 months required. It is also the
ONLY verdict in the run with no `ref`, because it is the only line with no
detected field. Reproduced on **five consecutive runs**.

**W-9 (§8.17).** The form draws no rectangles at all. Line 1, "Name of
entity/individual", has no detectable affordance of any kind. **The model
returned "fill in" for it anyway.** On page 1 the reading order is scrambled by
column interleaving (§8.21), five checkboxes collapse into one line (§8.22),
and the masthead is mistagged — and the copilot still returned correct,
specific advice for every real field.

**The tax-authority form (§8.39).** Checkboxes are `❑` characters in the text
layer; geometry finds **zero boxes**. Every checkbox option still got a
verdict, including the two-column income table.

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
- **Cell counts DO go**, because they change the answer. ✅ Confirmed live: a
  six-cell date returns `120385` (DDMMYY, not DDMMYYYY), a nine-cell ID returns
  `039274865` (§8.32).
- **Field refs DO go** (§8.27). A ref is `"p1l17f0"` — a line index and a field
  index. No coordinate and nothing derived from one.
- **Absence is NEVER asserted.** A line carries a tag or carries nothing, and
  nothing means _unknown_. System prompt rule 2.

**Client-side only, never serialised** — all on `FieldGeometry`: `markRect`,
`cells`, `fromDrawnShape`, `source` (§8.20), `dir` (§8.37), `lineRect` (§9.4).

### 3.3 Two builds, one source

```
npm run build       → dist/      Chrome extension (crx plugin + manifest)
npm run build:web   → dist-web/  static site, then scripts/flatten-html.mjs
```

The **only** environment-specific file is `copilot/storage.ts`: it branches at
runtime on `chrome.runtime?.id` and provides `readStored` / `writeStored` /
`removeStored` / `assetUrl` / `STORAGE_DESCRIPTION` / `IS_EXTENSION`.

⚠ **`assetUrl` is load-bearing for Hebrew.** pdf.js cmaps decode CID fonts; a
wrong path there doesn't throw, it makes Hebrew extract as garbage or not at
all — indistinguishable from an extraction bug. `editor/export.ts` uses it too,
for the Hebrew export font (§6.1). **If §7.2's counts go to zero after a build
change, check the network tab before the code.**

`vite.config.ts` branches on `--mode web` and drops only the crx plugin.

---

## 4. Storage & security (know this cold for demo day)

Everything except the API key is in-memory and gone on tab close or refresh.
That includes the two context answers **and the whole question thread**, which
are the most personal things in the app.

- **No database anywhere.**
- ⚠ **THE STORAGE CLAIM IS BUILD-DEPENDENT AND THEY ARE NOT THE SAME.**
  Extension: `chrome.storage.local`, sandboxed by Chrome from other extensions
  and sites, not synced. Web: `localStorage`, scoped to the origin and readable
  by any script on it. **Neither is encrypted.** `STORAGE_DESCRIPTION` picks
  the right sentence per build so the UI can't overclaim — rehearse the WEB
  version, since that's the link people click.
- ⚠ **`persist()` takes `StoredCredentials`, not a partial state.** That
  signature is the only thing keeping the context answers and the ask thread
  off disk. Widening it breaks the privacy claim and nothing would flag it.
- **Never log the API key**, including while debugging. No file in `copilot/`
  logs it, including error paths and the §8.38 diagnostics. Keep it that way.
- **Minimal `host_permissions`** in the extension: the three provider APIs.
  On the web, CORS is handled by `anthropic-dangerous-direct-browser-access`
  (§8.19) — ✅ verified working from the deployed origin.
- ✅ **Git history checked for leaked keys** — clean.
- UI copy present: don't use on a shared computer.

---

## 5. Phase 1 — what is built

```
src/
  background/     MV3 service worker (extension build only)
  state/          shared; must stay free of DOM and React
  viewer/
    App.tsx               session state, file intake, beforeunload guard,
                          extraction wiring, focusedLineId, panel layout
    pdf-setup.ts          worker + cmap wiring via assetUrl(), loadPdf()
    PdfPage.tsx           canvas render, owns the page wrapper, mounts overlays
    PdfTextLayer.tsx      selectable transparent text overlay
    coordinates.ts        the ONLY place points and pixels convert
    AnnotationLayer.tsx   overlay: placement, keyboard, deselect
    GeometryOverlay.tsx   dev-only rect visualiser, `g` toggles
    VerdictMarkers.tsx    §9.4 — green markers on "fill" + the amber focus band
    TextAnnotation.tsx / SymbolAnnotation.tsx / SignatureAnnotation.tsx
    SignaturePad.tsx / Toolbar.tsx / useAnnotationStore.ts
  copilot/        see §7.1
  editor/
    export.ts             pdf-lib flatten + download
public/fonts/     NotoSansHebrew-Regular.ttf + OFL.txt
scripts/          flatten-html.mjs (web build postprocess)
```

Working end to end: viewer (any PDF, page-at-a-time, zoom 50–300%, text
selection), text tool, symbol tool, signature tool, export (Hebrew and English
both correct), unsaved-changes warning.

**Known drift, deliberately deferred:** annotation components live in
`viewer/`, not `editor/`. Also `editor/export.ts` now imports `assetUrl` from
`copilot/storage.ts`, crossing a layer boundary — `assetUrl` arguably belongs
in `state/`. Cosmetic; move it during the cleanup pass if convenient.

### 5.1 Invariants that must not be broken

**Geometry is PDF points**, y = bottom edge, origin bottom-left. Screen pixels
never enter the store. `coordinates.ts` is the only place the two systems meet.
Every overlay goes through `pdfRectToCss` and does no arithmetic of its own.

**Text is stored in logical order**, exactly as typed. Visual reordering
happens once, in the export path.

**Annotations are a flat array**; array order is z-order. The export path must
iterate in the same order — don't sort.

**Selection is two fields.** `selectedId` = has handles, Delete removes it.
`editingId` = caret inside, Delete types a character. Collapsing them makes
Backspace delete the box you're typing in.

**`state/` stays free of DOM and React imports** so the background worker can
import it. `copilot/` is NOT bound by this.

**Layer order in `PdfPage`, bottom to top:** canvas → `PdfTextLayer` →
`GeometryOverlay` → `VerdictMarkers` → `AnnotationLayer`. AnnotationLayer must
stay LAST. Both overlays are `pointerEvents: "none"` throughout, which is what
lets AnnotationLayer keep the transparency behaviour §6.10 depends on.

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

✅ **VERIFIED IN ADOBE READER** on the web build: Hebrew plus digits export in
correct order. This closes §10's last editor item and matters because the
copilot hands the user `039274865` to type.

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

Not a live hazard — the "box mounts with content already in it" path has never
executed, and click-to-prefill was cut (§9.4).

### 6.5 pdf-lib anchoring differs per primitive

- `drawText` — `y` is the **baseline**. First line's baseline sits near the
  top: `rect.y + rect.height - ascent`, then subtract `fontSize * LINE_HEIGHT`
  per line. Ascent is `font.heightAtSize(size, { descender: false })`.
- `drawSvgPath` — anchors **top-left**, SVG y grows downward, so pass
  `rect.y + rect.height`.
- `drawImage` — anchors **bottom-left**, same as our stored rect.

Symbol paths are authored in a 0–100 viewBox in both the viewer component and
the export, duplicated because the viewer imports React and `editor/` must not.

### 6.6 Editor font doesn't match export font — OPEN, cosmetic

Editor renders `sans-serif`, export renders Noto Sans Hebrew. The on-screen
width is a slight lie. Fix is an `@font-face` at the TTF, using `assetUrl()`.
TODO is in `TextAnnotation.tsx`.

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

- `page.cleanup()` lives in `PdfPage` **only**. Phase 2 does NOT call it (§8.6).
  ⚠ Note: in `PdfPage` it currently runs BEFORE the post-await `cancelled`
  check, while `PdfTextLayer` may still be streaming from the same cached
  proxy. Never observed failing; if rapid page-flipping ever produces duplicate
  text spans or a font error, look here.
- Canvas render lifecycle stays local component state.

### 6.10 Pointer-events and click discipline

`AnnotationLayer` is transparent to the mouse in select mode so `PdfTextLayer`
keeps its selection; opaque when a placement tool is active or a box is
editing. Individual annotations always set `pointerEvents: auto`.

Because the layer is transparent in select mode, deselect-on-background-click
is a **document-level** listener identifying background by exclusion: anything
not inside `[data-annotation-id]` or `[data-editor-chrome]`.

⚠ **`CopilotPanel`, `ContextForm` and the `AskBox` question field all sit
inside `Shell`, which carries `data-editor-chrome`.** Both branches of
`ContextForm` (expanded and collapsed) carry it too. Without it, every click in
the panel — and every keystroke in the API key field or the question box —
deselects whatever annotation the user is holding.

**Everything is `click`, never `pointerdown`, at the layer level.** Pointerdown
fires before an open textarea's blur, so the new box's `editingId` gets cleared
by the old box's blur. Individual annotations still use pointerdown for drag.

⚠ **`GeometryOverlay` and `VerdictMarkers` are `pointerEvents: "none"`** and
nothing inside re-enables it — including the focus band. That is why they need
no `data-editor-chrome`. **If anything in them ever becomes clickable, it needs
the attribute.**

⚠ **STILL OPEN, one look to settle:** if `AnnotationLayer` binds
Delete/Backspace at DOCUMENT level rather than on the layer element, typing in
the question box or the API key field will delete the selected annotation.
`ContextForm` has had this exposure all along, so it may already be fine. The
fix if it bites is a target check in the layer's handler, NOT
`stopPropagation` on each input.

### 6.11 Text runs are fragmented — but much less so on pdf.js v6

A PDF has no concept of a line, only positioned glyph runs. **v6 merges
adjacent runs**: page 1 of the fixture yields 138 items where v4 yielded 204.

⚠ **Merging is NOT uniform.** W-9 line 3b extracts as 19 runs because each dot
of a leader is its own item (§8.24). Do not assume a line is one run, and do
not assume a visually contiguous string is one run. This is also why
items-per-line is a bad proxy for anything (§8.15).

### 6.12 Page-at-a-time, no continuous scroll

Scroll doesn't affect copilot correctness — markers anchor to page plus
coordinates either way. It affects _discoverability_.

**Consequence:** the copilot panel is a navigable list; clicking a row sets
`pageNumber` and now also highlights the line on the page (§9.4). ✅ Built.

✅ **Scanned / image-only PDFs are editor-only, no copilot — TESTED.**
`run-extraction.ts` returns `readable: false`, `smoke.ts` handles a zero-line
document without a special case, and the panel says so. The editor half was
verified too: text, signature and export all work on a photo-of-a-form PDF.

---

## 7. Phase 2 — what exists NOW

### 7.1 Files in `copilot/` and the viewer overlays

| File                         | Role                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `extract-text.ts`            | page → ordered lines, logical order, PDF points, readability flags                  |
| `extract-geometry.ts`        | operator list → checkboxes, combs, dashed leaders. Document-level. Never throws.    |
| `detect-field.ts`            | joins the two; emits model payload (no coordinates) + client map (coordinates only) |
| `run-extraction.ts`          | orchestrates the three, owns the failure policy, calls `smokeReport`                |
| `verify.ts`                  | dev-only; asserts the §7.2 table. Filename-gated to the fixture.                    |
| `smoke.ts`                   | generic extraction report for ANY document. No assertions. §13.3                    |
| `provider.ts`                | the ONE place that talks to a provider. Config, request shapes, timeout, errors     |
| `classify.ts`                | §9.3 — prompt, `projectLines`, JSON parsing, id/ref validation                      |
| `ask.ts`                     | §9.7 — follow-up questions: prompt, history flattening, prose out                   |
| `copilotStore.ts`            | provider, key, context answers, classifications, ask thread                         |
| `storage.ts`                 | §3.3 — the only environment-specific file. Storage backend + `assetUrl`.            |
| `dev.ts`                     | `COPILOT_DEV` — §8.38                                                               |
| `ContextForm.tsx`            | provider dropdown, masked key field, two free-text questions; collapses after a run |
| `CopilotPanel.tsx`           | field list, verdicts, counts strip, waiting state, degraded notices, `AskBox`       |
| `viewer/GeometryOverlay.tsx` | dev-only. Every rect in the geometry map, coloured by `source`. `g` cycles.         |
| `viewer/VerdictMarkers.tsx`  | §9.4. Green markers on `fill` verdicts + the amber focus band. Read-only.           |

⚠ **The file is `detect-field.ts`, singular.** Don't grep for the plural.

### 7.2 VERIFICATION STATUS ✅ CONFIRMED IN BOTH BUILDS

All numbers reproduce in-browser on pdfjs-dist 6.2.108 in the extension build
**and on the deployed web build**, matching the Node baseline exactly.

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
| `markOffset`               | 2.75pt calibrated                           | ✅     |

**W-9 baseline (2-page trimmed copy), via `smoke.ts`:**

```
2 pages · 228 lines · 13 tagged
mark sources (tagged): checkbox: 8, gap: 11
checkbox size: 8.0pt × 8 matched · mark offset: 5.60pt
corruption check: suppressed · latin 100.0% (gate 15.0%)
geometryOk: true · readable: true
```

**Tax-authority form baseline (1 page), via `smoke.ts` — see §8.39:**

```
1 page · 61 lines · 19 tagged · 22 fields
mark sources (tagged): comb: 3, gap: 17, literal: 2      <- literal FIRED
checkbox size: null (no size repeated 3+ times)
mark offset: 3.00pt = FALLBACK_MARK_OFFSET, nothing calibrated
boxes: 0 · combs: 3 · rules: 1
lineSource: eol · reading order correct · geometryOk: true · readable: true
```

**Scan/photo baseline:** `1 page · 0 lines · 0 tagged`, `readable: false`,
`geometryOk: true` (geometry ran fine and found nothing — distinguishable from
§8.5's failure mode, which sets `ok: false`).

### 7.3 ✅ BOTH SCRIPTS VALIDATED AGAINST A RENDERED POSITION

`GeometryOverlay` (§8.25) closed this in both directions:

- **LTR — W-9.** All five checkbox rects on line 3a land exactly on the five
  printed boxes. `gap` rects land in the blank areas.
- **RTL — Hebrew fixture.** Marks sit on the correct side (right of the label),
  and coverage is visibly denser, as expected from 20 checkboxes, 12 leaders
  and 5 combs against 8 boxes and no rectangles.

---

## 8. Phase 2 findings — recorded so they aren't rediscovered

### 8.1 Lines come from `hasEOL`, not from y-coordinates ⚠

pdf.js emits a zero-width item with `str === ""` carrying `hasEOL` at the end
of every line: 50 / 47 / 23 across the pages. **These items ARE the line
breaks.** Filtering them before grouping throws away the line structure.

Splitting on `hasEOL` beats y-clustering, measurably: superscripts sit ~3pt off
baseline, and on page 2 a rotated margin word shares a baseline with an
unrelated heading. Geometry can't separate either; the stream can.

**Two different empty-ish strings.** `str === ""` is a line break, drop it.
`str === " "` is real whitespace on the page and MUST survive — every blank on
the Hebrew fixture is a whitespace run followed by a large gap. Widening the
filter to `!str.trim()` deletes Phase 2's signal.

Guard: §8.15.

### 8.2 Rotated text is separable from the transform matrix

Every page opens with a vertical margin strip — the printer's ID stamp, 4 items
per page. Normal text has transform `[9,0,0,9,x,y]`; rotated has
`[0,8.29,-8.29,0,x,y]`. So `transform[1]` or `transform[2]` being non-zero is
the whole test. Currently dropped — a decision about _this_ document, since a
rotated _field_ would matter.

### 8.3 Reading order within a line is x-ascending, i.e. backwards for Hebrew

The עמית table header arrives reversed and must be re-sorted per line.

**Line direction is decided by "any strong RTL character present," NOT by
"first strong character."** The textbook rule needs the string already in
logical order — which is what the function is producing. Circular.
`editor/export.ts` uses the first-character rule legitimately, because by then
the string exists in logical order. **The two rules differ on purpose; don't
"unify" them.** Digits and punctuation count as neither direction.

### 8.4 Corruption is per-GLYPH, not per-font

Only Latin is ever corrupted on the Hebrew fixture — 5 distinct words, 9
occurrences, all page 2. **Not per-font:** the same font gives `HSBC` correctly
and `Qo` (truly `QR`) wrongly. A partially-populated `ToUnicode` table. **The
offset isn't consistent in sign**, so no repair is possible — only disclosure.

**Detection rule, verified:** an uppercase letter immediately after a lowercase
one, inside a single alphabetic word. Flags `httSs`, `harHl`, `grouS`,
`uQsubscribH`, `iQs`. Passes `HSBC`, `mfax`, `ins`, `www`, `co`, `il`.

⚠ **THE TOKENIZER MUST BE `/[A-Za-z]+/g`, NOT `\b`-ANCHORED.** The corrupted
text is `il.co.iQs-harHl@1uQsubscribH`, and a `\b` boundary can't start at `u`
because the digit `1` precedes it. A `\b`-anchored regex silently returns 4/8
instead of 5/9.

**Ranges, not booleans**, because v6 merges runs and corrupted Latin sits inside
otherwise-perfect Hebrew items. **No page-level verdict** — extraction reports
evidence, `detect-field.ts` concludes. Gated by §8.16.

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
precomputed bbox in path space. Path opcodes inside the array are LOCAL
(`0`=moveTo, `1`=lineTo, `2`=curveTo, `4`=close), **not** `OPS` constants. An
unknown opcode must bail rather than step by a default stride, or the walk
desynchronises and returns plausible-but-wrong numbers silently.

### 8.6 `page.cleanup()` three-way race ✅ RESOLVED

`doc.getPage(n)` returns a **cached** proxy. **Resolution:
`runExtraction(loaded.doc)` runs inside `App.openFile`, after `loadPdf()`
resolves and BEFORE `setPdf()`.** In that window `PdfPage` has not mounted and
nothing else holds a page proxy. Costs no new state anywhere.

`run-extraction.ts` does NOT call `page.cleanup()` — ownership stays with
`PdfPage` (§6.9). Extraction runs once per document over every page. ✅ Verified
harmless on a 50+ page PDF: opens in seconds.

### 8.7 Sizes are derived by repetition, never hardcoded

A form repeats its furniture; nothing else does. Checkbox width 8.0pt occurs 20
times on the Hebrew fixture, 8 on the W-9, and **nothing qualifies on the
tax-authority form** — which correctly yields `checkboxSize: null`.

**Checkboxes:** histogram square-ish, low-complexity single-subpath shapes;
take the mode; require ≥3 occurrences. Squareness is _proportional_. Document-
level pooling matters: fixture page 2 has one checkbox and no mode in isolation.

⚠ Fixture page 2 also contains ~20 tiny vector shapes (0.57–2.37pt) that pass a
naive squareness test. Doc-level mode plus the ≥3 rule excludes them; without it
page 2 reports 21 checkboxes. An absolute size floor (~3pt) would be a cheap
second guard.

**Combs:** runs of ≥3 consecutive **equal** gaps between thin vertical ticks
sharing a y-band. Gap tolerance must be **proportional** — the ID field's first
cell is genuinely 0.49pt narrower, and a flat 0.4pt tolerance reports 8 cells
for a 9-digit ID. **On a rejected run, advance by ONE tick**, since two combs
side by side share a divider.

**Leaders** are dashed strokes — parameter-free. Known limit: solid underlines
get nothing, and on the W-9 those same solid rules ARE the field boundaries
(§8.17). Identical geometry, opposite meaning.

### 8.8 Blank detection: three signals, not one

The Hebrew fixture contains zero underscore-runs, dot-leaders or dash-runs in
its text. Its blanks are whitespace runs followed by a 48–105pt positional jump
(against sub-1pt between words); its dotted leaders are vector strokes.

`literalBlanks` patterns: `_(?:\s?_){2,}`, `\.(?:\s?\.){4,}`, `-(?:\s?-){3,}`.
Thresholds are set by what they must NOT match — `...`, `1.1.2008`, `co-op`.
✅ **Fired for the first time on the tax-authority form** (§8.39); still subject
to §8.24's granularity limit.

Gap threshold is one em of the adjacent text, not a constant.

⚠ **Known false positive, accepted:** the fixture's unsubscribe line has a
51.7pt gap and gets a `writeIn` tag. Real blanks measure 74–261pt, so separating
them needs a hardcoded number. Tags enrich and never gate, so the model reads
the line and correctly calls it prose. **Do not "fix" this with a constant.**
The W-9's masthead does the same and the model ignored it there too.

### 8.9 Matching shapes to lines

**Checkboxes need a horizontal tiebreak.** Nearest-baseline alone fails: a box
2.4pt from its real line is 2.3pt from a sidebar advert, and the advert wins.
Among lines in the vertical band, pick the one whose **text edge** is nearest.
On an RTL line the relevant edge is the **right** one.

**A comb's label is NOT the nearest line above it.** Section ד lays each row out
as three lines: labels, signature text, tick marks. Rule that works on both
layouts: **walk upward and take the first line containing a run that
horizontally OVERLAPS the comb.** Nearest-above gets page 2 wrong 3 times of 3.

`matchCheckboxes` is run-keyed (§8.22): returns `Map<Line, CheckboxMatch[]>`,
appends, each box carrying its own label run.

### 8.10 Calibrated mark offset

Checkboxes sit a stable distance from their line's text edge: median 2.75 /
2.44 / 2.75 across the fixture's pages, 5.60 on the W-9. Learn it from the
boxes that exist, then apply it to lines where **no box was drawn**.

⚠ **It measures to each box's OWN LABEL RUN**, not the line edge, with the line
edge as fallback for unlabelled boxes. This had to change with §8.22:
`line.minX` is the leftmost point of the WHOLE line, so on a five-option row
boxes 2–5 would each report a large negative offset and drag the median.

⚠ **`markOffset: 3.00pt` means nothing was calibrated** — that is
`FALLBACK_MARK_OFFSET`. Seen on the tax-authority form (no drawn boxes) and on
the scan. `smoke.ts` labels it "(calibrated)" either way; mildly misleading.

### 8.11 RTL cell order — seen, and defused

`cellRects` indexes cells **left to right, geometrically**. On a Hebrew form the
first character of an ID belongs in the **rightmost** cell, so a 9-digit ID
fills index 8 down to 0. ✅ Confirmed visually via `GeometryOverlay`.

✅ **No longer a risk** — click-to-prefill was cut (§9.4), so nothing writes
into cells programmatically. **If prefill is ever revived, this is the first
thing to get right.**

### 8.12 ⚠ A line can carry SEVERAL fields — THE BUG WITH FOUR HEADS

Page 1's עמית table puts four column labels on ONE line with a 6-cell comb and
a 9-cell comb beneath it. Keying affordances by line kept the first and
**silently dropped the ID number field**.

Affordances belong to **runs**, not lines. `PayloadLine.fields` is an array,
each entry carrying its own `ref`. The `geometry` map is keyed by BOTH field
ref and line id: refs give a detected shape's exact rect, line ids give the
calibrated fallback.

⚠⚠ **THE SAME BUG HAS APPEARED FOUR TIMES:**

1. **Combs** — fixed §8.12.
2. **Checkboxes** — `matchCheckboxes` kept one box per line. Fixed §8.22.
3. **The store** — `classifications` keyed by line id. Fixed §8.36.
4. **The marker keys** — `key={verdict.id}` gave duplicate React keys for three
   verdicts on one line. Fixed to `ref ?? id` (§8.37).

**RULE: when a line can carry several of something, check every map keyed by
line id.** `hasWideGap` is the remaining one and is deliberately unfixed.

### 8.13 Duplication to clean up

`extract-geometry.ts` exports `combCellRect` (single rect) and
`detect-field.ts` has a private `cellRects` (array) doing the same job. An
exported function is never "unused", so nothing will flag it. **Low priority —
candidate for the cleanup pass.**

### 8.14 ⚠⚠ THE CONTENT STREAM IS NOT IN READING ORDER

pdf.js emits items in the order the producer wrote them; InDesign writes one
text frame at a time. Measured: page 1 — section א, then ג, then ב.

**Fix: sort each page's lines by y descending.** Stable sort, so lines sharing a
baseline keep stream order for free. Correct on both fixture pages, and ✅ on the
tax-authority form.

⚠ **FRAME GROUPING WAS TRIED AND FAILS — do not re-attempt.**

⚠ **LINE IDS SHIFT.** Ids are array positions (`p1l15`), so they change on every
re-extraction. Payload and geometry are built from the same array in one pass,
so nothing breaks — but ids noted in an old session are stale, classifications
must never be cached across a re-extraction, and `App` clears `focusedLineId`
in `openFile` for the same reason.

### 8.15 ⚠ The `hasEOL` guard — three revisions, and why

A PDF from Word, LaTeX, or a scanner may emit no `hasEOL` at all. Then
`splitIntoLines` returns **one line per page** with no error, the payload
becomes a few enormous strings, and nothing looks broken.

**Revision 1 — items-per-line ratio. WRONG, do not restore.** It false-positived
on ordinary documents: items-per-line measures how aggressively the producer
merged runs, not correctness.

**Revision 2** used the right measurement with `some()`, which failed a whole
page on one odd group.

**Revision 3 — CURRENT.** A line is text sharing a baseline, so measure that: a
group's vertical spread against its own tallest glyph. Fall back only when more
than **25%** of a page's groups exceed 3×.

**The clustering fallback, measured.** Forcing it on the fixture yields
50 / 48 / 24 against the correct 52 / 48 / 24 — both merges are the sidebar
advert gluing onto body lines. ⚠ `משיכה חלקית` is a real field, and the merge
extends its `line.maxX` across the advert, so **on the fallback path a checkbox
mark for that line can land hundreds of points off.** If marks look wildly
misplaced on a non-InDesign PDF, look here first.

⚠ **STILL NEVER FIRED ON A GENUINELY BROKEN DOCUMENT.** `smoke.ts` prints
`lineSource` and warns loudly if it ever says `"clustered"` — that remains the
single most valuable unclaimed result.

### 8.16 The corruption rule must be gated by document script

§8.4's rule flagged `SaaS`, `JavaScript`, `PayPal`, `macOS`, `iPhone` — 8
distinct, 22 occurrences, all false, on an English document.

**Gate: suppress the rule when Latin exceeds 15% of the document's letters.**
Fixture 1.6%, W-9 100.0%, tax-authority form 0.0%. ✅ Zero false badges on the
W-9. Nothing has ever landed near the boundary; a genuinely bilingual form is
untested.

`extract-text.ts` computes `suspectRanges` unconditionally and reports
`letters: { latin, rtl }` per page; `detect-field.ts` decides whether to surface
`unreliableText`. Document-level, not per page.

### 8.17 US FORMS BUILD BOXES FROM UNCONNECTED STROKES

IRS W-9 page 1: **every shape is `cmds=2`** — one moveTo, one lineTo — with
either zero width or zero height. The form contains **no rectangles at all**.
The box around "1 Name of entity/individual" exists only visually, as four
unrelated line segments meeting at corners.

**And the copilot works anyway** (§3.1). A rule-bounded-box detector is
optional, affecting placement only. Distinguishing table furniture from a field
boundary probably needs the model, not more geometry.

See §8.39 for the three-idiom table.

### 8.18 Groq free tier cannot fit a Hebrew document

The fixture payload is 12,266 JSON characters, 6,159 of them Hebrew — roughly
one token per character on Llama's tokenizer, so ~8,200 input tokens with the
system prompt. Groq's free tier caps `llama-3.3-70b-versatile` at 12,000 TPM
and **counts `max_completion_tokens` toward the estimate before the request
runs**: `Limit 12000, Requested 13541`.

`maxTokens` is per-provider in `PROVIDER_CONFIG`: 8000 Anthropic/OpenAI, 3000
Groq. **Groq is for pipeline testing on Latin documents.**

### 8.19 Provider notes

- **Anthropic requires `anthropic-dangerous-direct-browser-access: true`** for
  browser calls. ✅ Verified working from the deployed web origin, not just from
  an extension page. Without it, CORS rejection looks like a network failure.
- **Groq is OpenAI-compatible** — same request body, same response shape.
- **`fetch` rejects with `TypeError` for both network failure and CORS.** In the
  extension that usually means a missing `host_permissions` entry; Chrome does
  not apply manifest permission changes on hot reload.
- Model names live in ONE place, `PROVIDER_CONFIG` in `provider.ts`. **VERIFY
  ON DEMO MORNING.** Currently `claude-sonnet-5`.
- ⚠ **`stop_reason` is logged** when it isn't `"end_turn"` (§8.38). Keep it — it
  distinguished "ran out of room" from "chose to stop" on three separate
  occasions (§8.34, §8.40).

### 8.20 ❌ CORRECTED — `literalBlanks` had NEVER fired

The previous version of this section was WRONG and marked ✅: it claimed the
W-9's line 3b dot run matched. It did not. `smoke.ts`'s mark-source histogram
showed `checkbox: 4, gap: 11` and **no `literal` entry at all**.

**How the false ✅ survived a session:** both available observations — dots in
the extracted text, and a `writeIn` badge on the row — were consistent with the
claim, and neither could test it. The badge was unattributable because
`hasWideGap` emits the same tag.

**Two lessons worth more than the finding:**

1. **A tag with no provenance cannot confirm the detector that produced it.**
   Fixed by adding `MarkSource` to `FieldGeometry`.
2. **The tool that prints numbers caught what a session of inspection missed.**

Cause: §8.24. It finally fired on a different document: §8.39.

### 8.21 TWO-COLUMN PAGES DO INTERLEAVE — and it starts at line 0

W-9 page 1's masthead arrives shuffled across three layout blocks, and the form
number is itself three runs joined in the wrong order.

**Blast radius, measured not assumed:**

- **Placement: UNAFFECTED.** Marker coordinates come from the geometry map,
  never from list position.
- **Panel readability: degraded** in those regions.
- **Model context: degraded, and survivable.** The model classified 3a and 3b
  correctly on this exact page.

**Not fixable by §8.14's route.** A real fix means clustering lines by x-extent
into column bands, which needs a rule for when a page IS two-column — and
getting that wrong scrambles a single-column form, the common case.
`page.getStructTree()` remains the correct answer for tagged PDFs. Deferred.

### 8.22 ✅ FIXED — several checkboxes on one line

W-9 line 3a extracts as a SINGLE line carrying five options with five drawn
checkboxes. `matchCheckboxes` kept **one box per line**, so four got no rect.
Measured before the fix: `checkbox: 4` against 8 boxes detected document-wide.

**Fix (run-keyed, mirroring `matchCombs`):** returns `Map<Line, CheckboxMatch[]>`
and APPENDS; each match carries its own `labelRun` — nearest run on the side the
text runs toward (LTR: right, RTL: left). **Getting this backwards labels every
box with its NEIGHBOUR's text**, which reads plausibly on a row of similar
options. Matches sorted into reading order. `calibrateMarkOffset` changed in the
same edit (§8.10).

**Result:** page 1 fields 14 → 18, geometry map 243 → 247, `checkbox: 8`.
✅ Confirmed on screen, and `f0`–`f4` resolve to the five option labels in order.

✅ **`labelRun` now also verified on a Hebrew multi-option row** — the
tax-authority form's income table has `אין הכנסות ☐ / יש הכנסות ☐` twice on one
row, and the model separated applicant from spouse correctly (§8.39). This was
§13.2's one untested item.

⚠ **`hasWideGap` was NOT made run-keyed.** It still emits one `writeIn` per line
however many gaps it finds, so line 3a carries a sixth field overlapping the
five checkboxes. Deliberate: the checkbox fields already carry placement, so the
extra tag is redundant rather than wrong. Visible on the עמית row as a stray
`write-in` badge next to two comb badges — cosmetic.

### 8.23 §9.7's design decisions, tested rather than assumed

Verified live on Groq / llama-3.3-70b against the W-9 — the WEAK model, so these
are a floor.

- **History flattening works.** "And the one right after it — does that apply to
  me?" resolved correctly with no restatement. Do not add a `messages` array
  until something actually fails.
- **The hardcoded English rule works.** A Hebrew question against an English
  document returned English.
- **Both refusal rules held.** "What's the deadline?" returned "not specified in
  the provided form". "How do I fill in Schedule K-2?" declined and pointed at
  Form 1065.
- ✅ **It recovered a classification failure live (§8.28).**

### 8.24 `literalBlanks` matches per RUN, and a dot leader is one run per dot

W-9 line 3b extracts as 19 runs: `["…See instructions", " ", ".", " ", ".", …]`.
`literalBlanks` iterates `line.runs`, so the longest string it ever tests is
`"."`. The pattern needs five. **It cannot match on that document.**

**The regex is correct** — joined, the line matches cleanly; the LLC line's four
dots correctly do not.

**Fix, KNOWN AND DEFERRED:** match against `line.text`, map character offsets
back to runs, union the rects of the runs a match spans. Union is
direction-agnostic, so the RTL branch is only needed for the single-run case.

**Why still deferred:** it fired on the tax-authority form (§8.39), where blanks
ARE single underscore runs — so the granularity limit only costs the exact rect
of blanks that `gap` already finds. Do it if a document appears where a
multi-run literal is the ONLY signal on a line.

### 8.25 ✅ Geometry overlay — placement validated in both scripts

`viewer/GeometryOverlay.tsx`, dev-only. `g` cycles off → fields → all. Draws
every rect coloured by `source`, dashed when `fromDrawnShape` is false, comb
cells drawn individually and NUMBERED. `pointerEvents: "none"` throughout.

**Built instead of verdict markers as the first §9.4 step**, and that was the
right call: no API key needed, covers all 247 rects, works on any document.
Verdict markers became the same rects in different colours. Results: §7.3.

### 8.26 Overlapping detectors on one line

W-9 line 3a shows five checkbox rects AND a `gap` writeIn rect over the same
span. `VerdictMarkers.resolveRect` decides by source priority, preferring
measured ink over calculated position (§9.4).

### 8.27 Optional `ref` — the model names WHICH field

- `projectLines` sends each field's `ref`.
- Prompt rule 6 asks the model to name the specific field on a multi-field line,
  and says an omitted ref is handled correctly while a wrong one puts a mark on
  the wrong box.
- `parseResponse` validates the ref **against that line's own refs** — a global
  check would accept `p1l7f0` returned against `p1l3`. An invalid ref **strips
  the ref, it does not drop the row**.

⚠ **REF EMISSION IS HIGH-VARIANCE.** Measured across runs on the same build and
document: 19/20, 16/20, 5/21, 9/9. It swings with the context, not the code.
Consequence: `resolveRect`'s ambiguity path (rule 3) fires or doesn't depending
on the run. Both paths have now been exercised clean.

Absent ref degrades to pre-§8.22 behaviour, so §9.3's tested passes remain the
floor.

### 8.28 Classification UNDER-returned; the question box recovered it

W-9 through Groq: 9 verdicts on a form with ~12 real fields, with line 6 (City,
state, ZIP) getting no verdict though line 5 (Address) did. Asked directly in
the question box, the model answered correctly.

⚠ **Silent omission is worse than over-eagerness:** an over-eager verdict is
visible and dismissible, a missing one looks like "nothing to do here."

✅ Root cause was prompt weakness, not model capacity — fixed by §8.35.

### 8.29 RTL geometry validated visually

Marks land right of the label on RTL lines; coverage visibly denser than the
W-9's. The 9-cell `מס' הזהות` comb numbers left to right, so cell 0 holds the
LAST digit (§8.11).

### 8.30 ⚠ The OUTPUT ceiling is the binding constraint on Hebrew

Full fixture, 124 lines, Anthropic: 8,000 tokens / 90s → timed out. 4,000 →
truncated mid-JSON. 8,000 / 180s → generated in ~100s, still truncated.

§8.18 measured only the INPUT side. Hebrew output tokenizes at roughly one token
per character, and 124 verdicts with prose reasons do not fit in 8,000 tokens
regardless of how long you wait.

**Workaround in place: classify the CURRENT PAGE only.** `CopilotPanel` passes
`payload.filter((l) => l.page === pageNumber)`. Page 1 is 52 lines and lands
comfortably inside the ceiling.

⚠ **Pages are a bad unit — see §8.40.** A dense single Hebrew page can exceed
the ceiling on its own, and per-page chunking has no smaller fallback for it.

⚠ **`CLASSIFY_TIMEOUT_MS` is 180_000.** A full Hebrew page takes 60–100 seconds.
The panel now shows a waiting state naming the page and line count (§9.1).

### 8.31 §3.1's headline claim — CONFIRMED, and now directly

First run (no new job): the untagged clause got no verdict — defensible, since
an irrelevant clause is fair to omit, but it meant the claim was unproven for
two sessions.

With "started a new job in June 2026" the model now returns **a verdict on the
clause itself**, five consecutive runs, quoting its text and rejecting it on the
13-month condition. Stronger than the original evidence, which was the model
reasoning about it while classifying a _neighbouring_ clause.

⚠ **Check the claim on the run you are about to demonstrate.** One badly chosen
context makes the demo's best line unsupportable.

### 8.32 ✅ The language rule, verified

Fixture page 1, Anthropic, context carrying real personal data:

| Field      | Value       | Why it matters                                               |
| ---------- | ----------- | ------------------------------------------------------------ |
| Name       | `כהן משה`   | Hebrew script, family name FIRST — matching the column order |
| ID         | `039274865` | 9 digits into a 9-cell comb                                  |
| Birth date | `120385`    | DDMMYY into a 6-cell comb, not DDMMYYYY                      |

Every reason in English. Hebrew terms preserved inline where the term IS the
concept (`פיצויים`, `קצבה מוכרת`) rather than translated. ✅ §3.2's cell-count
argument confirmed at the same time.

### 8.33 The language rule leaked intermittently — fixed by §8.35

Two of five reasons came back in Hebrew on exactly the rows whose reasoning
quoted the form's Hebrew text; a later run had all five in Hebrew on the same
build. English and Hebrew alternated across identical builds.

**Lesson that outlived the bug: one pass proves nothing about a prompt rule.**

### 8.34 The capacity theory was WRONG — a recorded wrong turn

When Hebrew reasons appeared alongside a drop from 19 verdicts to 5, the obvious
theory was that Hebrew's ~4× token cost exhausted the output budget. **Wrong.** A
later run produced 6 verdicts with short English reasons and a ~2,700-character
response against an 8,000-token ceiling, and `stop_reason` was never
`max_tokens`. The model was choosing to stop.

Drift and omission were two separate problems that appeared together.

### 8.35 ✅✅ THE PROMPT REWRITE — position mattered more than wording

Five changes to `SYSTEM_PROMPT` in `classify.ts`, all needed:

1. **The language rule moved OUT of the numbered list** to AFTER the JSON
   schema, under its own `CRITICAL` heading.
2. **`reason` hardcoded to ENGLISH** rather than "the language the person used".
3. **Rule 1 given a numeric floor:** "a page typically has 15–25 lines worth
   answering… if fewer than 10, go back through the lines you passed over",
   plus "never stop early because the answer is getting long."
4. **Reasons capped at 25 words**, one sentence.
5. **New rule 9:** never leave `value_or_instruction` empty on a `fill`.

Results across six runs since: 19–21 verdicts, English reasons every time,
Hebrew values every time. Raw response matches parsed output exactly.

⚠ **The strongest lesson available here:** the same requirement stated as rule 4
of 8 drifted on 2 of 5 rows; stated after the schema under its own heading it
has held on every run since. **When a prompt rule is being ignored, try MOVING
it before rewriting it.** Do not tidy the prompt's structure.

### 8.36 ✅ FIXED — the store collapsed multi-field verdicts

`runClassification` built `new Map(...map((c) => [c.id, c]))`, keyed by LINE id.
Line `p1l14` carries three verdicts. **Last write won, and two of three were
silently lost** — at most one marker could ever appear on the עמית row. True for
as long as classifications had existed.

**Fix:** key on `c.ref ?? c.id`. ✅ Three markers now render on that row.

✅ **The panel side is fixed too:** `CopilotPanel` builds its own line-keyed
index of ARRAYS (`byLine`) and renders one `VerdictBlock` per verdict. It also
replaced an O(rows × verdicts) scan.

**Third occurrence of §8.12's line-vs-run bug** — see the rule there.

### 8.37 ✅ FIXED — Rule 9 is unreliable, and captions overflowed

**Rule 9 does not hold consistently.** One run returned Hebrew labels on every
checkbox skip; the next returned empty strings throughout, same prompt and
context. **Do not depend on the model for captions.**

**Caption overflow, fixed with three changes** in `VerdictMarkers.Marker`:

1. **Anchor on the side the text comes from.** RTL captions pin their right edge
   to the rect's right edge and grow leftward into the page.
   ⚠ Direction comes from `entry.dir`, copied off `Line.dir` in
   `detect-field.ts` — **not** derived from the coordinate.
   `markRect.x > width/2` was the obvious proxy and is wrong on the 9-cell comb,
   whose left cells sit the other side of the midpoint from the rest.
2. **`maxWidth` clamped to the room remaining**, with nowrap + ellipsis.
3. **Flip below the rect** when there's no room above.

Plus the parent clips, so nothing can escape the page.

**`markerLabel` now branches on field kind:** checkbox → the field's `label`
wins (the action is a tick, the content is worthless); cells/writeIn → the
model's value wins (`039274865` is the point). Each falls back to the other.

**And a duplicate React key was fixed** — `key={verdict.id}` collided for three
verdicts on one line. Now `ref ?? id`. Fourth head of §8.12.

### 8.38 Diagnostics that must survive, and the DEV-guard trap

⚠⚠ **EVERY `import.meta.env.DEV` GUARD IS DEAD IN THE PRODUCTION BUILD.** Vite
strips those blocks at compile time — they are not false, they are gone. An
unpacked extension loaded from `dist/` is a production build. This cost real
time on four separate occasions.

✅ **FIXED:** `copilot/dev.ts` exports `COPILOT_DEV`, a real runtime constant,
used in `run-extraction.ts`, `classify.ts` (both the dropped-classification
warning and the invalid-ref warning) and `copilotStore.ts`.
⚠ **Set it to `false` before the demo** — not for correctness, but `smokeReport`
walks every line of every page and a console full of it on stage is noise.

**Logs worth keeping:** `smokeReport(result)`; `[copilot] N verdicts, M with a
ref`; `[copilot] raw response: N chars` and `raw: …`; `[copilot] stop_reason` in
`callAnthropic` when it isn't `end_turn`. None touches the API key. Keep it
that way (§4).

**A separate trap: a stale bundle looks exactly like broken code.** Check the
bundle hash in the console before believing a result.

### 8.39 ✅ A THIRD FORM IDIOM — checkboxes as text glyphs

A one-page Hebrew government tax form. `smoke.ts`: 61 lines, 19 tagged, 22
fields, **`boxes: 0`**, `checkboxSize: null`, `markOffset: 3.00pt` (= fallback,
nothing calibrated), `lineSource: eol`, reading order correct.

**Its checkboxes are `❑` characters in the text layer.** There is nothing for
`extract-geometry` to find. Three idioms now, all incompatible:

|             | Hebrew fixture            | W-9                      | Tax form            |
| ----------- | ------------------------- | ------------------------ | ------------------- |
| Checkboxes  | drawn rects (20)          | drawn rects (8)          | `❑` in the text     |
| Field boxes | none                      | four unconnected strokes | table rules         |
| Blanks      | whitespace run + 48–105pt | region bounded by rules  | literal underscores |
| Detected by | `hasWideGap`, leaders     | `gap`                    | `literal`, `gap`    |

✅ **`literalBlanks` fired for the first time in the project's history** —
`literal: 2` — because this form types its blanks as underscore runs in a single
run. §8.8's thresholds were right all along.

✅ **The copilot works on it.** Every checkbox option got a verdict with zero
geometry behind them, including the two-column income table, and `labelRun`
correctly separated the applicant's column from the spouse's — closing §13.2's
last untested item.

⚠ **But classification hits the ceiling — see §8.40.**

### 8.40 ⚠ TWO truncation modes, and pages are the wrong chunking unit

The tax form is ONE page of 61 dense Hebrew lines. Both attempts failed
differently:

- **Sparse context** → response truncated mid-string at 3,315 chars,
  `stop_reason: max_tokens`, unparseable JSON. Nearly every line came back
  `unclear` **with a long Hebrew field description** in
  `value_or_instruction` — so a sparse context costs MORE output, not less.
  Output cost scales with how little the user tells you (§9.2).
- **Full context** → **zero characters** returned, `stop_reason: max_tokens`.
  A different failure: the budget went before any text was emitted.

⚠ **Recorded as a wrong turn:** the prediction that a fuller context would
shorten the values and fit was wrong. Same mistake as §8.34 — reasoning about
token budgets instead of measuring them.

**The structural point: §8.30's per-page workaround has no smaller unit for a
one-page form.** The fix is chunking by CHARACTER BUDGET, not by page:
`JSON.stringify(projectLines(chunk)).length`, capped around 2,500, fired in
parallel with a concurrency cap of 3–4, merged into the store as each returns
(the store is already keyed by `ref ?? id`, so merging is nearly free, and the
panel renders whatever is in the map). That also gives partial results while
later chunks run, and a failed chunk costs one chunk instead of the page.

**Not before the demo** — it rewrites the one call everything depends on.
Deferred to §9.9.

⚠ **Embeddings/RAG do NOT apply here.** The input already fits (~7,700 tokens
against a 200k window); retrieval would re-create the gated design §3.1
disproves. The ceiling is on the OUTPUT, whose length scales with the number of
fields, and no retrieval scheme shrinks that.

### 8.41 ⚠ A log that printed a SUBSET while reporting a TOTAL

`runClassification` logged `${result.classifications.length} verdicts,
${withRef.length} with a ref` — and then logged **`withRef`**, not
`result.classifications`.

So a run with 20 verdicts, 19 of them carrying a ref, printed a header saying 20
and an array of 19. The one missing entry was always the ref-less one — which,
on this document, is the `התחלתי לעבוד` clause, the single most important
verdict in the demo. **It read as a targeted silent drop for three debugging
rounds.** Two wrong theories were built on it (a hallucinated line id, then a
store filter) before the log itself was suspected.

**Fixed:** log `result.classifications`. The ref count is already in the string.

**Same shape as §8.20** — an observation consistent with a bug, that could not
test it. **A diagnostic that prints a filtered view must not report an unfiltered
count.**

---

## 9. Phase 2 — what's left

### 9.0 Nothing blocks the demo

§14 is documentation, polish and rehearsal only.

### 9.1 ✅ DONE — pipeline + panel

Extraction wired into `App.openFile`, §7.2 numbers confirmed in both builds,
`CopilotPanel` lists every line with page grouping and click-to-navigate.

**Restyled for density:** unanswered rows clamp to one line, answered rows to
two, each verdict is two lines (badge + field label + value, then the reason).
A left rail coloured by the strongest verdict on the line is the only structural
device. A counts strip (`5 to fill in · 1 unclear · 14 to skip`) replaces the
tagged/lines count once results exist, and counts FIELDS not lines. A waiting
state names the page and line count during the 60–100s run.

**The filter default is derived, not stored:** `taggedOnlyOverride ?? taggedCount > 0`.
⚠ **The filter matches `l.fields || byLine.has(l.id)`** — tagged OR answered.
Filtering on `fields` alone hides the `התחלתי לעבוד` row, which has no field at
all. That is the demo's best moment; don't simplify this predicate.

⚠ **`ContextForm` collapses** to a one-line summary when a classification
starts, and re-arms on the next run. Both branches carry `data-editor-chrome`.

⚠ **`App.tsx` layout:** the panel is a SIBLING of the scrolling `<section>`,
inside a `flex flex-1 overflow-hidden` wrapper. It used to be a flex child of
the scroll area, where the line stretched to the tallest item (the canvas) — so
the panel's height was driven by the document's, squeezing the list at 120% zoom
and pushing the ask box off-screen past ~150%. Don't move it back.

### 9.2 ✅ DONE — context intake

Provider dropdown, masked key field disabled until storage has been read,
"Forget this key", two free-text questions.

Switching provider clears the key — only one `{ provider, apiKey }` pair is
stored, and an Anthropic key sent to OpenAI produces an auth error that reads
like a broken integration.

⚠ **The context answers do real work — and a vague answer costs MORE, not
less.** With a vague situation the model returns `unclear` for name/ID/date and
writes a long Hebrew _field description_ into `value_or_instruction` for each
one. With real data it returns the value itself: `039274865`, `120385`,
`כהן משה` (§8.32). Short strings, and a better answer.

So richer context is both cheaper in output tokens and more useful — which is
the opposite of the usual intuition about context length, and worth saying in
the demo. It is also why §8.40's dense form failed hardest on a sparse context.

⚠ **Not fully proven.** The one direct test of "fuller context → fits" failed
for a different reason (§8.40, zero-character response). Observed reliably on
the fixture; treat the mechanism as measured and the conclusion as likely.

**Test context is in §15.5.**

### 9.3 ✅ DONE AND VERIFIED — the AI call

`getFieldClassifications(payload, context, provider, apiKey)` in `classify.ts`.
Returns `{ id, ref?, fill, value_or_instruction, reason }`.

- Ids validated against the payload; refs validated per line (§8.27).
- **180s timeout** via `AbortController`.
- Every failure path returns a readable message — never a thrown error, never a
  silent hang.
- ⚠ **The JSON parse has its OWN try/catch**, because `callProvider` has already
  returned successfully by then. Removing it turns a malformed reply into an
  unhandled rejection and the panel spins forever.
- Markdown fences stripped before parsing.
- ⚠ **The prompt's structure is load-bearing (§8.35).** The language rule sits
  AFTER the JSON schema on purpose.

⚠ **Current scope: ONE PAGE PER RUN** (§8.30, §8.40).

### 9.4 ✅ DONE (read-only) — markers and the focus band

`viewer/VerdictMarkers.tsx` draws a green marker on every line the copilot said
to FILL IN, at the coordinates `detect-field.ts` computed.

**Only `fill` is drawn.** On a bureaucratic form most lines are skips, and
drawing them buries the two or three things the user must actually do. Nothing
is lost — the panel lists every verdict with its reason.

**Which rect, when a line has six** (`resolveRect`):

1. **Ref wins.** Validated against that line's own refs.
2. Otherwise **highest-priority source**: checkbox → comb → literal → leader →
   gap → calibrated. Measured ink before calculated position.
3. **Unless that is ambiguous** — several rects of the winning source and no
   ref. Then draw NOTHING. A mark on the wrong one of five identical checkboxes
   is invisible to the user and wrong on their form.

Lines with no fields fall back to the per-line calibrated entry — the
`התחלתי לעבוד` case.

✅ **THE FOCUS BAND, new this session.** Markers only draw on `fill`, so every
skip, every unclear and every ambiguous fill had an answer the user couldn't
locate. Clicking a panel row now sets `App`'s `focusedLineId` and paints an
amber wash over that line, read from `FieldGeometry.lineRect` — which exists for
every line because `detect-field` guarantees the per-line fallback entry.

- Amber, not green: green means "act here", and reusing it would make a skip
  look like an action.
- The focused panel row tints amber to match.
- Rendered BEFORE the markers so a marker on the same line draws over it.
- `PdfPage` change is a pure pass-through — one prop in, one prop out. No new
  layer, no ordering change, §6.10 untouched.
- ⚠ `focusedLineId` is cleared in `openFile` — line ids don't survive a
  re-extraction (§8.14).

⚠⚠ **NO CLICK-TO-PREFILL, DELIBERATELY.** The user places the value with the
existing text / symbol / signature tools. The AI's answer and the place you act
on it are still the same interface (§2) — that does not require the tool to type
for you. It also keeps §6.4's never-executed path unexecuted and §8.11's
mirrored-ID risk dead. **Say that in the demo rather than apologising for it.**

### 9.5 ✅ DONE — multi-provider

Anthropic, OpenAI, Groq. One internal function branching on
`PROVIDER_CONFIG.openAiCompatible`. No `if (provider === …)` in UI code.
**Demo runs on Anthropic** (`claude-sonnet-5`).

### 9.6 Web search grounding — CUT

`provider.ts` already takes `timeoutMs` per call, so the plumbing exists.

### 9.7 ✅ DONE — follow-up question box

A free-text box pinned at the bottom of the panel, with the document text
already in context. Markers answer "what goes in this field"; this answers "what
does מס שבירה mean" and "I have a loan against the account, does that change
which box I tick."

- `ask.ts` — prompt, history flattening, prose out. No parsing.
- 45s timeout (not 180 — a user watching a box will reload, and a reload loses
  the extraction AND every annotation).
- 1,200 output tokens. History: last 3 exchanges, answers truncated to 500 chars.
- **English answers, hardcoded**, except a literal value to type.
- ⚠ **`askThread` never holds a half-turn** — the in-flight question lives in
  `pendingQuestion`.
- ⚠ **`ask()` returns a boolean** so the panel clears its textarea only on
  success.
- ⚠ **Independent of classification by design.** Reads no `status`, no
  `classifications`. That independence IS §10's network-failure fallback and it
  earned its keep live (§8.23, §8.28). **It also still works on a document
  classification can't finish** (§8.40). Don't gate the box.
- ⚠ **Not a `<form>`** — a real form on an extension page submits and navigates.

**TODO left:** auto-scroll to the newest turn (LAYOUT effect, not `useEffect`),
and the §6.10 Delete-key check.

### 9.8 Phase 3 — CUT

AcroForm explanation layer. No test document has an AcroForm. **Cut, not
deferred.** Confirming one degrades rather than crashes remains untested and is
the only thing worth doing — `PdfPage` has never rendered pdf.js's own
AnnotationLayer underneath our overlays.

### 9.9 Deferred, with reasons — say these out loud if asked

- **Character-budget chunking (§8.40)** — the real fix for multi-page and dense
  Hebrew. First thing after the demo.
- **Two-column reading order (§8.21)** — panel readability and model context
  only; placement unaffected.
- **Rule-bounded box detection (§8.17)** — placement only; the same geometry
  means opposite things on different documents.
- **`literalBlanks` granularity (§8.24)** — `gap` already finds the same blanks.
- **Absolute size floor for checkbox candidates (§8.7)** — cheap second guard.
- **Sending classifications to `ask.ts`** — token cost.
- **Click-to-prefill (§9.4)** — cut on product grounds, not time.
- **`hasWideGap` run-keying (§8.22)** — redundant where it matters.
- **Splitting `CopilotPanel.tsx`** (~650 lines, five concepts) — readability
  only, no second caller.
- **Moving `assetUrl` out of `copilot/` into `state/`** — layer hygiene.

---

## 10. Pre-demo checklist

**Editor**

- [x] Viewer renders the fixture correctly, all 3 pages, both builds
- [x] Text placement and text-layer selection accurate across zoom (50–300%)
- [x] Signature draws smoothly, resizes without distortion
- [x] Unsaved-changes warning fires
- [x] Exported PDF correct in macOS Preview and Chrome
- [x] **Hebrew + digits export correct in ADOBE READER (§6.1)**
- [x] Large (50+ page) file opens and edits without dying
- [x] Scanned/image-only PDF degrades cleanly — panel message, editor works,
      export works

**Extraction**

- [x] TypeScript compiles (strict, noUnusedLocals)
- [x] §7.2 numbers reproduce in-browser, extension AND web build
- [x] Reading order correct on all three documents
- [x] Corruption gate suppressed on an English document
- [x] An English form — W-9, checkbox detection validated LTR
- [x] Generic smoke report works on any document (§13.3)
- [x] Multi-checkbox rows detected (§8.22)
- [x] Placement validated on screen, both scripts (§7.3)
- [x] **A second Hebrew form from a different issuer (§8.39)**
- [x] **`labelRun` verified on a Hebrew multi-option row (§8.39)**
- [ ] **A 3–5 page ENGLISH form classified page by page (§13.4)** — should fit
      the ceiling Hebrew breaks, and proves multi-page works
- [ ] A non-InDesign PDF where the `hasEOL` guard actually FIRES (§8.15)
- [ ] An AcroForm PDF — confirm it degrades rather than crashes

**Copilot**

- [x] API key flow: first-run prompt, persists, doesn't re-ask
- [x] Visible error if key missing or invalid — never a silent hang
- [x] Verdicts render per line with reason and value; skips carry reasons
- [x] Question box: grounding, history, language, both refusal rules (§8.23)
- [x] Hebrew demo: explanations English, values Hebrew (§8.32)
- [x] Cell counts respected — DDMMYY into 6 cells, 9 digits into 9
- [x] Markers render at verified coordinates (§9.4)
- [x] Multi-field lines produce multiple markers (§8.36)
- [x] §3.1's untagged-clause claim demonstrated live — five runs (§8.31)
- [x] Caption never overflows the page (§8.37)
- [x] Click-to-highlight works, including on a line with no field
- [x] Field-to-line mapping stable across repeated runs — six clean runs
- [ ] Provider switch relabels/clears the key field (implemented, untested)

**Deployment & submission — see §16**

- [x] Static web build works and is deployed
- [x] CORS verified from the deployed origin (§8.19)
- [x] Extension build still works after the storage-adapter change
- [x] Git history checked for leaked keys — clean
- [ ] `dist-web/` added to `.gitignore`
- [ ] README pushed
- [ ] 2-minute video
- [ ] Portfolio link
- [ ] Submitted on the platform

**Overall**

- [x] Network-failure fallback exists (the question box, §9.7)
- [x] `App.openFile` calls `resetResults()` and clears `focusedLineId`
- [x] Paid API credit topped up
- [ ] Full demo rehearsed 3–5+ times on the exact file being presented
- [ ] Tested on a clean Chrome profile
- [ ] `PROVIDER_CONFIG` model name re-verified on demo morning
- [ ] `COPILOT_DEV` set to `false`
- [ ] Geometry overlay OFF and not accidentally toggled on stage (don't press `g`)

---

## 11. Ideas and open questions (not committed)

- **OCR — explicitly cut.** Would be the fallback for §8.4 and scanned pages.
- **`page.getStructTree()`** for reading order on tagged PDFs (§8.14, §8.21).
- **Column detection** for two-column pages (§8.21).
- **`messages` array on `ProviderRequest`** — only if history flattening starts
  losing the thread. It hasn't (§8.23).
- **A token-cost estimate under the classify button** —
  `JSON.stringify(projectLines(payload)).length / 4`. Cheap, and it makes the
  BYOK story concrete. Would also make §8.40's budget visible.
- **`TextLayer.update({ viewport })`** repositions spans instead of rebuilding
  on zoom. Not worth doing until something feels slow.
- **Signature is a raster.** `embedPng` means slightly soft at high zoom.
- **Filled checkboxes** — the size histogram pools stroked and filled
  deliberately. Fix if it trips: prefer the stroked cluster.
- **Chrome Web Store listing** — review takes days; not viable before the demo,
  worth submitting after.

---

## 12. Working conventions

- Explain the file and its non-obvious parts before writing code.
- **One file at a time.** A full-file rewrite when a three-line patch would do
  costs a retest and hides what changed.
- The cancellation pattern in §6.8 is reused for every long-running pdf.js op.
- Comments earn their place by recording _why_, especially where the code looks
  wrong and isn't.
- **Verify claims against the fixture rather than reasoning about them.** Nearly
  every finding in §8 contradicted a confident prior assumption. §8.20 was
  marked ✅ and was false. §8.34 and §8.40 were confident theories and were
  wrong.
- **Build the tool that prints numbers before the feature that needs them.**
  `smoke.ts` deleted a false ✅ on its first run; `GeometryOverlay` validated
  both coordinate branches without an API key.
- **A diagnostic that prints a filtered view must not report an unfiltered
  count (§8.41).**
- **One pass proves nothing about a prompt rule (§8.33).**
- **When a prompt rule is ignored, try MOVING it before rewriting it (§8.35).**
- **Check the bundle hash before believing a result (§8.38).**
- **Test on whatever PDF is lying around.** Six sessions running, the
  non-fixture document produced the session's most important finding.
- **Tag the build before a mechanical refactor.** The worst case becomes one
  checkout.

---

## 13. Generalising beyond the test documents

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

And §3.1 is the larger protection: discovery is text-driven, so a document where
every detector fails still gets every field found, explained and listed. ✅ The
tax-authority form proved this with `boxes: 0`.

### 13.2 What is rule-based but thinly exercised

- **Line splitting (§8.15).** The `hasEOL` guard has NEVER fired on a real
  document. On the fallback path text degrades slightly and **placement degrades
  badly**. Highest-risk unknown.
- **Reading order (§8.14, §8.21).** y-descending. Interleaves on two-column.
  Correct on all three test documents.
- **Checkbox mode needs ≥3 occurrences (§8.7).** A form with two checkboxes
  total gets none — which is the right answer, as the tax form showed.
- **The 15% Latin gate (§8.16).** 1.6% / 100% / 0%. Nothing has landed near the
  boundary; a genuinely bilingual form is untested.
- **Form idiom (§8.17, §8.39).** Three incompatible idioms. Assume a fourth.

### 13.3 ✅ BUILT — the generic smoke report

`copilot/smoke.ts`, called from `run-extraction.ts` behind `COPILOT_DEV`. No
assertions, no expected values, no per-document baseline. Prints a per-page
table (lines, tagged, fields, unreliable, `lineSource`, `quality`, Latin %, raw
shape counts), a mark-source histogram split into real detections and per-line
fallbacks, document facts (checkbox mode, `markOffset`, gate side, `geometryOk`,
`readable`), first and last three lines per page, and a warnings block that only
appears when something is off.

**How to read it:** `lines: 1` = line splitting failed. `tagged: 0` on a real
form = a fourth form idiom. `lineSource: "clustered"` = §8.15 fired for the
first time ever. `checkbox: N` well under the box count = matching is dropping
them. `markOffset: 3.00pt` = nothing was calibrated.

✅ Handles a zero-line document without a special case.

### 13.4 What to collect next

Bring documents from **different producers**, not different languages.

1. **A multi-page ENGLISH form, 3–5 pages.** English tokenises at roughly a
   quarter of Hebrew's cost, so a multi-page English document should fit the
   ceiling that §8.40 breaks — which would show the multi-page story works and
   isolate the limit as language-shaped rather than architectural. Cheapest
   high-value test available, and a good thing to have on the deployed link for
   a visitor with their own key (§16).
2. **Word / Google Docs export** — most likely to fire §8.15's guard for the
   first time. Highest information value, still unclaimed.
3. **An AcroForm PDF** — the one degradation check skipped (§9.8).
4. **A genuinely bilingual document** — tests the 15% gate's boundary.

### 13.5 The rule for what to do with what you find

**A new document's failure is a §8 entry before it is a code change.** Record
the numbers, then decide. Several findings turned out cheaper to document than
to fix, and four are still deliberately unfixed with reasons written down
(§8.8, §8.21, §8.24, §8.40).

Resist adding a constant. Every constant in this codebase that isn't derived
from the document is a per-document tuning knob in disguise.

---

## 14. Next session (17 August) — documentation, polish, rehearsal

No features. No fixes. **Tag the build first** (`git tag demo-working`) — the
cleanup pass touches a dozen files two days out, and a tag makes the worst case
one checkout.

### 1. `EXPLAINER.md` — do this FIRST

Written for the author, not a maintainer. How a PDF becomes lines, how lines
become fields, how a text answer becomes a coordinate, what each file owns, and
the five or six decisions worth defending (§15.2 maps onto its sections).

It comes first because the code cleanup depends on having somewhere to point.

### 2. Code cleanup

⚠ **MOVE the reasoning out of the code, don't delete it.** §12 says comments
earn their place by recording _why_ — so each long header becomes a section of
the explainer, and the code keeps a two-line summary plus a pointer:

```ts
/**
 * Joins lines to drawn shapes. Emits a model payload (text only) and a client
 * map (coordinates only). Geometry enriches, never gates — see EXPLAINER §4.2
 * for why, and what breaks if you invert it.
 */
```

Also: normalise file ordering (types → tuning → entry point → helpers), and no
logic changes. Optional while in there: §8.13's duplication, and moving
`assetUrl` out of `copilot/`.

### 3. Update this document

Fold in whatever the cleanup changes.

### 4. Logo

Favicon, extension icons at 16/32/48/128 with a matching `icons` block in
`manifest.config.ts` (there is none now, so Chrome shows a puzzle piece), and a
README header. The product's idea — the answer and the place you act on it are
the same mark on a page — is a good thing for a logo to be about.

### 5. Testing

Three separate things:

- **Regression after the cleanup:** §7.2's numbers must still reproduce in BOTH
  builds, and the export must still be correct in Adobe Reader.
- **The two skipped §10 items:** an AcroForm PDF, and a clean Chrome profile.
- **A 3–5 page English form, classified page by page** — §13.4 item 1. The
  highest-value untested claim left: that multi-page works and §8.40's ceiling
  is language-shaped, not architectural.
- **More documents through `smoke.ts`** — §13.4. Watch for
  `lineSource: "clustered"`.

### 6. Video (2 minutes)

Rough shape: drop the Hebrew form → the field list appears with **no key
involved** → paste key, classify → land on the untagged clause (worth ~20 of the
120 seconds) → export. The README's "one design decision" section is the script.

### 7. Rehearse

§15. Three to five times, once on a clean profile.

### What NOT to do

- **Don't add click-to-prefill** (§9.4) or character-budget chunking (§8.40).
  Both are post-demo.
- **Don't fix two-column reading order (§8.21) or `literalBlanks` (§8.24).**
- **Don't tidy the prompt's structure (§8.35).**
- **Don't add a constant to fix a per-document surprise** (§13.5).

---

## 15. Demo plan (19 August)

### 15.1 The shape

- **17th** — §14: explainer, cleanup, logo, testing, video, first rehearsals.
- **18th** — spare. Rehearse 3–5 times, once on a clean Chrome profile. No code.

### 15.2 Concepts to know cold

1. **Why no backend** — and what it buys (§3, §4). Easiest and strongest.
   ⚠ The storage claim differs between builds — get it right (§4).
2. **Why the model sees all the text, not a list of blanks** (§3.1). The
   headline. Three documents, three incompatible idioms, one architecture.
3. **How a text answer becomes a coordinate** (§7.1, §8.9, §9.4).
4. **Sizes derived, never hardcoded** (§8.7, §13.1) — why the W-9 and the tax
   form worked with zero code changes.
5. **What it deliberately does NOT do** — no prefill, no OCR, one page at a
   time, each with a reason (§9.4, §9.9). Knowing why you didn't build something
   is stronger than having built it.

**If asked what makes the answers good:** the two context questions. A vague
answer produces `unclear` verdicts with long descriptive values; a specific one
produces the value itself — better AND cheaper in tokens (§9.2). That is the
whole difference between this and pasting a PDF into a chat window.

**If asked about Adobe's PDF assistant:** it summarises and answers questions
about a document. This takes _your stated situation_ and returns a per-field
verdict anchored to coordinates. The untagged clause is the proof — a general
document assistant has no notion that clause nine has no checkbox, because it
never looks at the geometry at all.

### 15.3 Stories worth telling

- **§3.1 / §8.31 / §8.39** — the architecture's central bet, paying off on
  transcript. Discovery survived three simultaneous geometry defects on the W-9;
  on the Hebrew fixture the model returns a verdict on a clause with no checkbox
  drawn beside it; on the tax form geometry found zero boxes and every option
  still got advice.
- **§8.20 and §8.41** — twice, an observation consistent with a claim turned out
  unable to test it. What caught the first was a tool built to print numbers
  rather than assert them; the second was a log that printed a filtered subset.
  An engineering-judgement story, rarer than a working feature.
- **§8.35** — a prompt rule that was being ignored started working when it was
  MOVED, not reworded.

### 15.4 Live-demo hazards

- **Classification takes 60–100 seconds** (§8.30). The waiting state names the
  work, but have something to say — this is the natural moment for §15.2's
  architecture explanation.
- **If a run comes back thin**, the question box is the fallback and it is
  independent by design (§9.7).
- **The demo moment is a `skip`, so it draws no green marker.** It lives in the
  panel. Point at the empty spot on the form, then at the row. Don't build up to
  a marker appearing there.
- **Don't press `g`** on stage (§8.25).
- **Re-verify the model name** that morning (§8.19).
- **Check §3.1's claim on the run you are about to show** (§8.31).

### 15.5 Test context — use these exact strings

**What is this document?**

```
Severance withdrawal form — my employer's pension provider sent it.
```

**What do you need to do?** — the variant that demonstrates §3.1's untagged
clause, and the one to use:

```
I left my job in March 2026 and started a new job in June 2026. I want to
withdraw the severance in full. My name is משה כהן, ID 039274865, born
12/03/1985, bank account at Leumi branch 800.
```

The model then returns a verdict on `התחלתי לעבוד במקום חדש` — a clause with no
checkbox drawn beside it — rejecting it because 3 months is not the 13 months
required. **That is the demo's best single moment**, and it is the only verdict
in the run with no `ref`, because it is the only line with no detected field.

⚠ Replacing "started a new job in June 2026" with "haven't started a new one"
makes the clause irrelevant and the model correctly omits it. Don't.

---

## 16. Deployment & submission

**Live:** https://pdf-copilot.netlify.app/ (Netlify, static, free tier —
**claim the site to an account** or the deploy is tied to an anonymous session).

**What the submission needs:** a deployed project link, a deployed portfolio
link, a 2-minute video, and a GitHub repo. Only deployed, working, submitted
projects are presented.

**What a visitor without an API key sees:** extraction, the field list, badges,
the whole editor and export — everything except verdicts. The panel says the
copilot needs their own key. That is roughly 70% of the project demonstrable
with zero setup.

⚠ **English documents are the safe default for a stranger with their own key** —
the W-9 fits the ceiling comfortably. Hebrew is the showcase to drive yourself
(§8.40).

**Build and deploy:**

```bash
npm run build:web        # → dist-web/ , then flatten-html.mjs copies index.html up
npx serve dist-web       # test LOCALLY first — file:// will not work
```

Test in this order — the first two are the ones that break:

1. Open the Hebrew fixture; §7.2's counts must appear. Zero lines or garbage
   text = a cmap 404 (§3.3). Check the network tab, not the code.
2. Export and open in Adobe Reader — the font path is the other `assetUrl`
   dependency.
3. Paste a key and classify — the real CORS test.
4. Reload — confirms the localStorage branch.

Then drag `dist-web/` onto Netlify Drop.
