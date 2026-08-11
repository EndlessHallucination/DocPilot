# PDF Copilot — Build Plan & Session Handoff

**Status: Phase 1 (editor) is COMPLETE.** Next session starts on Phase 2, the
AI copilot. Read §1–3 for what this is, §5 for what's actually built, §6 for
findings that cost real time to discover, and §7 for what to do next.

---

## 1. What this is

A browser extension that lets you edit and sign any PDF in-browser, then uses
AI to tell you — field by field — what to fill in, what to skip, and why,
based on your own stated situation. No server, no database, no accounts.

## 2. The problem it solves

Filling a bureaucratic form today (example: Israeli Pitsuim / severance
forms) means uploading the PDF to an AI chat, asking what to fill in, getting
a prose answer, then going to a _separate_ tool to actually type into the PDF
— and working out yourself where each described field maps to on the page.

This extension collapses that into one flow: the AI's answer and the place you
act on it are the same interface, and the answer is tied to exact coordinates
instead of prose you have to translate.

## 3. Core architecture decisions

**No backend, no database.** Nothing persists across sessions except the API
key. Simpler, faster to build, and a strong privacy story: no document ever
leaves the browser except as text sent directly to the AI provider, and only
when the copilot is used.

**BYOK (bring your own key).** The user pastes their own API key, stored in
`chrome.storage.local`. The extension calls the provider directly from the
client. Zero hosting cost, zero backend, and a normal pattern for AI
extensions.

**No auth system,** because there's nothing to authenticate _to_. The API key
is the only credential and it goes straight to the provider.

**pdf.js for viewing/reading.** Renders any PDF and gives each text chunk's
page plus x/y coordinates — needed for both the editor and blank detection.

**pdf-lib for editing/export.** Draws text, places images, flattens and
re-saves as a real downloadable PDF, all client-side.

**Don't re-upload the whole PDF to the AI.** Two reasons. First, the AI's
answer alone can't fill anything — something still has to map "fill in your
name" to an x/y position, and that has to be our client-side code. So local
text+position extraction is needed regardless. Second, sending the whole
document every time is expensive and slow compared to a short structured list
of detected blanks. Since extraction is needed anyway, the cheap payload is
free.

**Native AcroForm rendering left untouched.** True AcroForms already render as
interactive fields via pdf.js's AnnotationLayer. Don't rebuild a fill
mechanism — only add an explanation layer on top.

---

## 4. Storage & security (know this cold for demo day)

Everything except the API key is in-memory JS state and is gone on tab
close or refresh: PDF content, annotations, AI classifications, context form
answers. The API key lives in `chrome.storage.local` deliberately, so it
doesn't need re-pasting every session.

- **No database, anywhere.** `chrome.storage.local` is sandboxed to the
  extension by Chrome — not readable by other extensions or sites, not synced
  to any server. It's the extension-scoped equivalent of a cookie.
- **Not encrypted at rest.** Fine for this scope, but don't claim encryption
  if asked. Say "sandboxed locally by Chrome," which is accurate.
- **Never log the API key**, including `console.log` while debugging.
- **Minimal `host_permissions`**: the provider APIs and nothing else.
- UI copy to add: don't use this on a shared computer, since anyone with
  access to that Chrome profile could read the stored key.

---

## 5. What is actually built (Phase 1 — DONE)

### 5.1 Repo layout as built

```
src/
  background/     MV3 service worker — no DOM, nothing canvas-related
  state/          shared across contexts — must stay free of DOM and React
    annotations.ts        pure types, no imports
    annotationStore.ts    zustand/vanilla store
  viewer/
    App.tsx               session state, file intake, beforeunload guard
    pdf-setup.ts          worker + cmap wiring, loadPdf()
    PdfPage.tsx           canvas render, owns the page wrapper
    PdfTextLayer.tsx      selectable transparent text overlay
    coordinates.ts        the ONLY place points and pixels convert
    useAnnotationStore.ts React binding for the vanilla store
    AnnotationLayer.tsx   overlay: placement, keyboard, deselect
    TextAnnotation.tsx    one text box
    SymbolAnnotation.tsx  one check / cross / dot
    SignatureAnnotation.tsx  one placed signature
    SignaturePad.tsx      modal drawing canvas
    Toolbar.tsx           tools, symbol picker, delete, export
  editor/
    export.ts             pdf-lib flatten + download
public/fonts/     NotoSansHebrew-Regular.ttf + OFL.txt
```

No `server/` directory — this build has no backend.

**Drift to resolve:** the original plan put the annotation components in
`editor/`, and only `export.ts` ended up there. Either move them or accept
`viewer/` as the home and stop referring to `editor/` as the annotation
layer. Doing it before Phase 2 starts importing from these files is cheaper
than doing it after.

### 5.2 Features working end to end

- Viewer: any PDF, page-at-a-time nav, zoom 50–300%, text selection and copy
- Text tool: click to place, type, commit on click-away, discard on Escape,
  drag, delete. Box grows with content; empty boxes self-destruct
- Symbol tool: check / cross / dot, sticky so several can be placed in a row,
  centred on the cursor, drag, delete
- Signature tool: draw in a modal, place, drag, resize proportionally,
  reusable across pages without redrawing
- Export: flattens everything into a real downloadable PDF, Hebrew and
  English both correct
- Unsaved-changes warning on refresh/close, cleared after a successful export

### 5.3 Invariants that must not be broken

**Geometry is stored in PDF points**, y = bottom edge, origin bottom-left.
Screen pixels never enter the store. `coordinates.ts` is the only place the
two systems meet: `cssPointToPdf`, `cssRectToPdf`, `pdfRectToCss`,
`cssLengthToPdf`, `fontSizeToCss`. All take the viewport first.

**Text is stored in logical order**, exactly as typed. Visual reordering
happens once, in the export path. Storing visual order would corrupt editing,
search, and anything sent to the AI.

**Annotations are a flat array**; filter by page at render time. Array order
is z-order — the export path must iterate in the same order, so don't sort.

**Selection is two fields, not one.** `selectedId` means the box has handles
and Delete removes it. `editingId` means the caret is inside it and Delete
types a character. Collapsing them makes Backspace delete the box you're
typing in.

**`state/` stays free of DOM and React imports** so the background worker can
import it. That's why the store uses `zustand/vanilla` and the React binding
lives in a separate one-line file in `viewer/`.

---

## 6. Findings — recorded so they aren't rediscovered as bugs

### 6.1 fontkit silently reverses digits inside Hebrew ⚠ LOAD-BEARING

The single most dangerous bug this project could have shipped, and it is
invisible without deliberate testing.

`fontkit` (which pdf-lib uses for custom fonts) already reverses Hebrew glyph
order — but naively, reversing the whole string rather than running the bidi
algorithm. Pure Hebrew comes out right by accident, so it passes casual
inspection. But `רחוב הרצל 45` exports as `54`, and
`חשבון 935921908 בבנק HSBC` exports with the account number backwards and
`HSBC` as `CBSH`. An account number written backwards onto a severance form,
by someone who reads the Hebrew fine and never scrutinises the numbers.

**The fix needs both halves.** `bidi-js` `getReorderedString()` for correct
logical→visual ordering (it handles digits, Latin runs, and bracket
mirroring, and passes Latin-only strings through untouched). Then force
fontkit to `"ltr"` so it doesn't reverse the already-correct output a second
time. pdf-lib exposes no direction option, but `registerFontkit()` takes the
module, so patch `layout()` there.

This lives in `editor/export.ts`. **Keep the DO NOT REMOVE comment on
`ltrFontkit`** — without it the patch reads as mysterious cruft, someone
deletes it, and the bug returns silently. Note that the published
`@pdf-lib/fontkit` types declare `layout(str, features?)` while the real
function takes five arguments, so the patch needs two casts to compile. That
makes it look even more like cruft. The comment is what saves it.

**Test that proves it:** export a box containing
`חשבון 935921908 בבנק HSBC`, open in **Adobe Reader** (not Chrome, which is
more forgiving), and confirm the digits read left-to-right in the right
order. Pure Hebrew proves nothing.

### 6.2 RTL export alignment ⚠ NEW THIS SESSION

`drawText` always runs left-to-right from `x`. The editor right-aligns RTL
text because of `dir="auto"`, so a Hebrew value in a box wider than its
content sits at the right edge on screen and at the left edge in the export.

Export mirrors the editor: measure with `font.widthOfTextAtSize`, and start
from `rect.x + rect.width - width` when the line's first strongly directional
character is Hebrew or Arabic. The direction test must run on the **logical**
string, not the reordered one — after reordering, the first character may be
from a different run.

Consequence: box width now affects where text lands, not just where it wraps.
If placement looks off, check the box width before suspecting the alignment
code.

### 6.3 The text box grows, it never wraps ⚠ NEW THIS SESSION

A browser soft-wrap inserts no `\n`. The string stays one line, so the export
— which splits on `\n` — draws a wrapped box as one long line running off the
page. Narrowing the box makes it obvious: the editor rewraps, the stored
string never changes, and the export is unaffected.

Fixed by making the box grow instead: `white-space: pre` plus `wrap="off"`,
and both dimensions measured from content. Now the only line breaks in the
string are ones the user typed with Enter, and editor and export agree by
construction rather than by two independent measurements happening to match.

This is why there is **no resize handle on the text box**. A manual width
would be overwritten on the next edit and would reintroduce exactly this bug.
Signatures do have a proportional resize handle; symbols have none.

Wrapping at export was the alternative and was rejected: it can't match the
browser's wrap points unless the editor also renders in the export font, so
it's half a fix without §6.6 as well.

### 6.4 Three React/DOM traps in the auto-grow measurement ⚠ NEW THIS SESSION

All three produced the same visible symptom — a committed box showing only its
first line — and each masked the next. Worth reading before touching
`TextAnnotation.tsx`.

**Measure both axes before writing either.** Setting height to `auto`,
reading `scrollHeight`, writing it back, then doing the same for width
measures the second axis against a box the first write already resized. It
comes out a line short on multi-line content. Write both to `auto`, read both,
then write both back.

**`handleBlur` must read the measurement from a ref, not state or the DOM.**
Blur fires _after_ the layout effect has run with `isEditing` false. State is
already null and the inline styles are already gone, so both reads return the
collapsed element and the box commits at its creation height.

**Do not clear inline styles when leaving edit mode.** This one is
counter-intuitive: React writes height and width from the style prop in the
same commit, and clearing `el.style.height` afterwards wipes it while React
still believes it applied it — so the element renders with no height at all
and never gets one on later renders. Only the editing branch touches inline
styles.

Also: the wrapper `<div>` needs an explicit height. It only had left, top, and
width, so it collapsed and clipped its child. The symbol and signature
wrappers always set height; this one didn't, and it only became visible once
boxes could be more than one line tall.

And `rows={1}` on the textarea — the default of 2 gives a minimum height that
fights the auto measurement.

### 6.5 pdf-lib anchoring differs per primitive ⚠ NEW THIS SESSION

Three drawing calls, three conventions. Getting these wrong puts things a full
box-height off, which reads like a coordinate-system bug and isn't.

- `drawText` — `y` is the text **baseline**, not the box bottom. For a
  multi-line box the first line's baseline sits near the **top**, so work
  downward: `rect.y + rect.height - ascent`, then subtract
  `fontSize * LINE_HEIGHT` per line. Ascent is
  `font.heightAtSize(size, { descender: false })`.
- `drawSvgPath` — anchors at the path's **top-left** and treats SVG y as
  growing downward, so pass `rect.y + rect.height` and pdf-lib does the flip.
- `drawImage` — anchors **bottom-left**, the same convention as our stored
  rect, so no adjustment at all.

Symbol paths are authored in a 0–100 viewBox in both the viewer component and
the export, with the same stroke width, so the two stay in step. They're
duplicated rather than shared because the viewer file imports React and
`editor/` must not.

### 6.6 Editor font doesn't match export font — OPEN

The editor renders in `sans-serif`; the export renders in Noto Sans Hebrew.
Different character widths, so a line that fits on screen may not fit in the
PDF.

Now that the box grows instead of wrapping, this is cosmetic rather than
correctness-affecting — but it means the on-screen box width is a slight lie.
Fix is an `@font-face` pointing at the TTF already in `public/fonts/`, named
in the textarea's `fontFamily`. In an MV3 extension the path may need
`chrome.runtime.getURL()` at runtime rather than a static CSS URL. The TODO
is in place in `TextAnnotation.tsx`.

### 6.7 Latin runs extract garbled on the Harel fixture — file defect ⚠

Extracted text on some pages returns `httSs://www.harHl-grouS.co.il` and
similar. It's a constant shift of 29 character codes (`p→S`, `e→H`, `n→Q`) —
a subset-embedded font with a broken or missing `ToUnicode` table.

- Canvas rendering is **unaffected**. Drawing needs glyph outlines, which are
  intact. Only extraction is broken. Same file, two data paths.
- Not fixable in our code. Acrobat produces the same mush.
- Hebrew on the same document extracts **correctly**, and different pages
  differ in quality.

**This matters for Phase 2**, since the copilot feeds extracted text to the
model. Options, pick one deliberately:

1. **Detect and disclose.** Flag low-confidence extraction rather than
   silently feeding garbage to the model. Cheap heuristic: ratio of uppercase
   letters appearing mid-word — `harHl` / `grouS` trip it instantly, clean
   text almost never does.
2. **Let the model repair it.** Works for prose since the shift is obvious,
   but scope it carefully: this document contains an account number, a tax
   file number (935921908), and phone numbers. A model asked to "fix
   spelling" will happily normalise digits that were never corrupted. Never
   apply repair to anything the user acts on financially.
3. **Pick a different demo page.** The garbled runs are concentrated in the
   fine print, not the field labels, so blank detection may be unaffected.

Recommendation: (1) for correctness, and check whether (3) makes it moot.

### 6.8 Text runs are fragmented by design

A PDF has no concept of a line or paragraph — only positioned glyph runs. A
new run starts on any change of font, weight, size, colour, or a horizontal
position jump. One visual line is routinely three or more items.

This directly shapes Phase 2. Raw item order on a boxed form like the Harel
fixture is close to arbitrary; it needs grouping into lines by y-coordinate
and into blocks by gap width before anything downstream is meaningful. That's
the reassembly step. Search would also miss terms straddling a run boundary —
standard fix is to concatenate everything into one string, search that, and
map matches back to span index plus offset.

### 6.9 Scale-factor discipline

Two viewports get built from the same page, one line apart in `PdfPage.tsx`,
and the distinction is load-bearing:

- The **canvas backing store** is built at `scale * devicePixelRatio` so it's
  sharp on retina.
- **Everything in the DOM** — text layer, annotation layer, every annotation
  — is built at plain `scale`. Mixing them puts overlays at double offset.

`PdfPage` builds the CSS-space viewport once and passes it to
`AnnotationLayer`. A `PageViewport` is plain data, so it stays valid after
`page.cleanup()`.

Also: pdf.js emits text-layer spans with percentage positions plus
`--font-height` and `--scale-x` custom properties and relies on
`pdfjs-dist/web/pdf_viewer.css` to turn those into real sizes. Hand-writing
that CSS silently produces spans that only look right at one zoom level.
Import the real stylesheet.

### 6.10 Alignment in the text layer is approximate and that's final

pdf.js measures each run and applies a horizontal `scaleX` to stretch the
substitute system font to the width the embedded font produced. Small residual
drift is inherent — not a bug, not improvable, every browser PDF viewer does
this. Don't spend time on it.

### 6.11 Pointer-events toggling is what keeps text selection alive

`AnnotationLayer` is transparent to the mouse (`pointerEvents: none`) while
the select tool is active and nothing is being edited, so `PdfTextLayer` keeps
its selection behaviour. It becomes opaque when a placement tool is active or
a box is in edit mode. Individual annotations always set `pointerEvents: auto`
on themselves, so they stay grabbable either way.

Because the layer is transparent in select mode, background clicks never reach
it — so deselect-on-background-click is a **document-level** listener that
identifies background by exclusion: anything not inside
`[data-annotation-id]` or `[data-editor-chrome]`. Every annotation root
carries the first; the toolbar and header carry the second, or their buttons
would deselect before their own handlers could read `selectedId`.

### 6.12 Everything is `click`, never `pointerdown`, at the layer level

Pointerdown fires _before_ an open textarea's blur. Creating an annotation on
pointerdown means the new box's `editingId` gets cleared by the old box's
blur, and the new box mounts un-editable. Placement uses `click`. Individual
annotations still use pointerdown for drag, since a click fires at the end of
a drag too and would reselect on every drop.

### 6.13 Cancellation pattern for pdf.js (reuse this)

Every long-running pdf.js operation follows three beats, because React
re-triggers effects faster than these complete:

1. `cancel()` — a request, not an instant stop. Returns immediately.
2. `await …promise.catch(() => {})` — wait for the real teardown.
3. Null the refs.

Plus a `cancelled` boolean flipped in effect cleanup and checked after **every**
`await` — that guards against stale results, a different problem from
cancellation. Skipping beat 2 gives "Cannot use the same canvas during
multiple render() operations," and duplicate stacked spans on the text layer.

### 6.14 Ownership rules

- `page.cleanup()` lives in `PdfPage` **only**. Both components call
  `doc.getPage()` and get the same cached proxy; a second cleanup call can
  free fonts out from under a live render.
- If text-layer failures ever appear in the console only on fast page changes,
  the suspect is `PdfPage`'s `cleanup()` racing the text stream. Fix is to
  drop the call — pdf.js reclaims on proxy eviction anyway.
- Canvas render lifecycle stays local component state. Wanting to hoist "which
  page is rendering" into `state/` is a signal something else is wrong.

### 6.15 Decisions that shaped the UI

**Page-at-a-time, no continuous scroll.** Scroll doesn't affect copilot
correctness — markers anchor to page plus coordinates either way. It affects
_discoverability_: a user on page 1 can't see that page 3 has eight more
fields.

**Consequence, now mandatory rather than optional:** the copilot panel must be
a navigable list. One row per classified blank (label, fill/skip/unclear, page
number); clicking sets `pageNumber` and highlights the marker. That's the
scroll substitute, and it demos better than scrolling — the AI's reasoning
becomes a scannable list rather than something the presenter hunts for.

**Scanned / image-only PDFs are editor-only, no copilot.** The copilot
requires a text layer; scanned pages have none, and OCR is cut. The viewer and
editor work on them regardless, because **the editor never needed text** —
canvas rendering already works, and placing a box or signature is pure
coordinate work that doesn't care what's underneath. So "editor works, copilot
doesn't" falls out of the existing architecture rather than being a separate
build.

What _is_ required is degrading cleanly, since someone will drop a scanned PDF
in during the demo: the page renders normally (already true), the empty text
layer doesn't throw (**untested — verify**), and the copilot panel says
plainly that it can't read this page rather than showing a silent empty panel
that looks broken.

---

## 7. Phase 2 — AI copilot (next session)

### 7.1 How it works, step by step

1. **Context intake, first thing the user sees.** Provider dropdown, API key
   field (only if not already stored) with a short note that it's stored
   locally and used to call the provider directly, and two free-text
   questions: "What is this document?" and "What do you need to do?"
2. **Text + position extraction.** `PdfTextLayer` already proves the
   extraction path works — but that component _positions_ runs, while this
   step _reassembles_ them (§6.8). Separate file, e.g. `extract-text.ts`. Do
   not entangle it with the layer.
3. **Blank detection.** Regex for underscore runs, dotted lines, empty boxes
   near labels. Label is the text immediately preceding the blank on the same
   line — and **for Hebrew, "preceding" means to the right**, not the left.
   Easy to get backwards and not notice until tested on a real Hebrew form.
   Test against the actual demo document immediately, don't wait.
4. **AI call** with a compact structured payload — detected blanks with id,
   page, label and position, a document text summary, and the user's stated
   context. Ask for structured JSON back, one entry per blank:
   `{ id, fill, value_or_instruction, reason }`.
5. **Web search grounding**, only when the model flags genuine uncertainty
   (e.g. a legal eligibility rule), not on every field. Keeps latency and demo
   risk down. Needs a timeout so a slow search never hangs the UI.
6. **Wire results into the editor** as clickable, colour-coded markers
   (fill / skip / unclear) at real coordinates, plus the navigable list panel
   from §6.15. Clicking a marker opens the text tool pre-filled with the AI's
   suggested value where it's confident.

### 7.2 Multilingual handling

Extraction is language-agnostic — pdf.js pulls whatever text is in the PDF,
Hebrew included (confirmed on the fixture, including vertical margin text).
The model reads Hebrew natively and can answer in whatever language the user
is using.

**Explanation language and value language must be separated in the prompt.**
The _explanation_ of a field can be in the user's language, but the _value_
suggested for the form must stay in the document's language and script — a
name or address goes in Hebrew, because that's what the authority expects.
Prompt for this explicitly.

RTL is a UI and extraction concern, not an AI concern.

### 7.3 Multi-provider support

Anthropic and OpenAI, both fully, then stop. Both have solid structured-JSON
output, so the same schema works on either with minor prompt-format
differences. A third provider adds another API shape for a "nice to have
choice" line without strengthening the core differentiator.

Structure it as one internal function — e.g. `getFieldClassifications(payload)`
— that branches internally on the provider. Never scatter
`if (provider === 'openai')` through UI code. Settings is a dropdown plus a
single API key field that relabels. Stored as
`{ provider, apiKey }` in `chrome.storage.local`.

**Known complication:** web search grounding is wired differently per
provider. It's fine to scope live search to one provider for the demo — just
decide that ahead of time rather than discovering it on the final build day.

### 7.4 Phase 3, only if time remains

AcroForm explanation layer: field detection and label resolution reusing
Phase 2's resolver, the same classification call, output feeding a
hover/click tooltip or modal. The native field stays native — the user types
into it, the extension only explains it.

---

## 8. Pre-demo checklist

**Editor**

- [x] Text box placement stays accurate across zoom levels
- [x] Text layer selection stays accurate across zoom levels (50–300%)
- [x] Multi-page text-based PDFs open without crashing (3-page Harel form)
- [x] Signature draws smoothly, resizes without distortion
- [x] "Unsaved changes" warning fires on refresh/close
- [x] Exported PDF opens correctly in Chrome
- [ ] Exported PDF opens correctly in Adobe Reader and Preview
- [ ] Single-page and large (50+ page) files
- [ ] Scanned/image-only PDF degrades cleanly: page renders, empty text layer
      doesn't throw, copilot states plainly it can't read the page

**Copilot**

- [ ] API key flow: first-run prompt, persists, doesn't re-ask every session
- [ ] Graceful visible error if the key is missing or invalid — never a silent
      hang
- [ ] Blank detection catches the real blanks on the actual demo PDF
- [ ] RTL label resolution verified explicitly on a real Hebrew form
- [ ] Field-to-blank mapping stays correct on repeated runs
- [ ] Web search has a timeout and doesn't stall the UI
- [ ] Both providers produce correctly-structured JSON on the same document
- [ ] Provider switch relabels/clears the key field, doesn't mix up keys
- [ ] On the Hebrew demo document: explanations in English, suggested values
      in Hebrew, no garbled text anywhere in the UI —
      **⚠ currently fails on the Harel fixture, see §6.7. Decide how to handle
      it before demo day rather than being surprised by it.**

**Overall**

- [ ] Full demo script rehearsed start-to-finish 3–5+ times on the exact file
      being presented
- [ ] Fallback if AI or network fails live: demo the editor alone, narrate the
      copilot from screenshots or a recording
- [ ] Tested on a clean Chrome profile, to catch anything working only because
      of local dev state

---

## 9. Ideas and open questions (not committed)

- **OCR — explicitly cut.** Would have been the fallback for both §6.7 and
  scanned pages, and the canvas is always correct regardless of font defects,
  so Tesseract over the rendered bitmap sidesteps everything. But it's a whole
  subsystem, not a tweak. Revisit only after the demo, if at all. (If it ever
  happens: Tesseract needs `heb` loaded explicitly, not the default English
  pack, or scanned Hebrew forms come out as garbage.)
- **Extraction-quality signal as a first-class concept.** §6.7 needs it,
  scanned pages need it, and the copilot needs to know when not to trust its
  own input. Possibly one shared function feeding both a UI warning and the AI
  payload.
- **`TextLayer.update({ viewport })`** repositions existing spans instead of
  rebuilding on zoom. Cheaper per zoom step. Not worth doing until something
  feels slow.
- **Canvas blanks on every zoom step** because assigning `canvas.width` clears
  it. Fix if it bothers anyone: render to a detached canvas, swap on
  completion. Cosmetic.
- **`page.getOperatorList()`** can sometimes recover characters when
  `ToUnicode` is broken, by matching glyph IDs against the font program.
  Fiddly, rarely worth it — noted only so it isn't rediscovered as a bright
  idea.
- **Signature is a raster.** `embedPng` means it's slightly soft at high zoom
  in the exported PDF. Capturing stroke points and using `drawSvgPath` would
  make it vector. Not a demo problem.
- **Placing the same signature on three pages embeds the PNG three times.** A
  few KB each, so irrelevant — but that's where to cache by data URL if it
  ever matters.

---

## 10. Working conventions

- Explain the file and its non-obvious parts before writing code.
- One file at a time.
- Skeletons with TODO blocks; the human writes the component logic.
- The cancellation pattern in §6.13 is reused for every long-running pdf.js
  operation.
- Comments earn their place by recording _why_, especially where the code
  looks wrong and isn't. The `ltrFontkit` block and the inline-style rules in
  `TextAnnotation.tsx` are both in that category.
