# PDF Copilot — Build Plan

## 1. What this is, in one sentence
A browser extension that lets you edit/sign any PDF in-browser, then uses AI
to tell you — field by field — what to fill in, what to skip, and why, based
on your own stated situation. No server, no database, no accounts.

## 2. The problem this solves (the actual use case)
Today, filling a bureaucratic form (example: Israeli Pitsuim / severance
pay forms) looks like this:
1. Upload the PDF to an AI chat, ask "what do I fill in and how"
2. Get a text answer describing which fields apply to you
3. Manually go to a *separate* tool (e.g. ilovepdf) to actually type into
   the PDF and figure out where each field described maps to on the page

This extension collapses steps 1–3 into one flow: the AI's answer and the
place you act on it are the same interface, and the AI's answer is tied to
exact coordinates on the page instead of prose you have to translate
yourself.

## 3. Why not just re-upload the whole PDF to the AI every time?
You can — Claude can read a whole PDF directly. But two things make that
the wrong architecture *for this extension specifically*:

- **The AI's answer alone can't fill anything.** Even if Claude tells you
  "fill in your name here," it has no way to reach into the file and place
  text there — that answer is just a chat message. Something still has to
  map "fill in your name" to an exact x/y position on the page, and that
  something has to be *our* client-side code, not the AI. So we need a
  local text+position extraction step regardless of which option we pick.
- **Token cost.** Sending the whole document (or worse, page images) every
  time you ask something is expensive and slow compared to sending a short
  structured list of just the detected blanks and their labels, plus the
  user's stated context. Since we already need the position-extraction step
  above, we get the cheaper payload for free by using it as the AI input too.

**Conclusion:** extract text + positions locally with pdf.js (free, instant,
no API call) → detect candidate blank fields → send only the compact,
labeled list to the AI, not the raw document.

## 4. Architecture decisions and the reasoning behind each

| Decision | Reasoning |
|---|---|
| **No backend, no database** | Nothing persists across sessions except the API key. Simpler, faster to build, and a legitimately strong privacy story: "no document ever leaves your browser except as text sent directly to Anthropic, and only when you use the copilot." |
| **BYOK (Bring Your Own Key)** | User pastes their own Anthropic API key, stored in `chrome.storage.local`. The extension calls `api.anthropic.com` directly from the client. Zero hosting cost/risk to you, zero backend to build in 2 weeks, and it's a normal, accepted pattern for AI browser extensions. |
| **No auth system** | There's nothing to authenticate *to* — no accounts, no server. The API key itself *is* the authentication, handled entirely by Anthropic when the request lands. |
| **pdf.js for viewing/reading** | Renders any PDF (including scanned/image-only via its layers) and gives you each text chunk's page + x/y coordinates — required for both the editor and the blank-detection step. |
| **pdf-lib for editing/export** | Lets you draw text, place a signature image, and flatten/re-save as a real downloadable PDF — all client-side, no upload required for editing itself. |
| **Native AcroForm rendering left untouched** | True AcroForms already render as real interactive fields via pdf.js's AnnotationLayer. We don't rebuild a fill mechanism for these — we only add an explanation layer (tooltip/modal) on top. Building a duplicate fill system here would be wasted effort for zero added value. |
| **Two separate blank-detection systems** | (1) Flat/scanned PDFs — no real form fields, blanks are underscores/lines/boxes detected via text + geometry heuristics. (2) AcroForms — fields already exist structurally, just need label resolution. These are different problems solved by mostly-shared code (the label resolver), kept as separate modules so cutting scope on one doesn't break the other. |

## 5. How the AI copilot actually works, step by step

1. **Context intake (first thing the user sees):**
   - API key field (only shown if not already stored) — short note: *"stored locally on your device only, used to call Anthropic directly, never sent to us"*
   - Two short questions: *"What is this document?"* and *"What do you need to do?"* (free text)
2. **Upload PDF** → parsed entirely in-memory, nothing written to disk
3. **Extraction:**
   - pdf.js pulls all text chunks with page + x/y coordinates
   - If a page has no text layer (scanned image) → **out of scope for the
     copilot.** No OCR. Detect and say so; the editor still works on that
     page. See §14.7.
4. **Blank detection (flat PDFs):**
   - Regex for underscore runs, dotted lines, empty boxes near labels
   - Label = text immediately preceding the blank on the same line
   - **RTL-aware for Hebrew:** "preceding" means to the *right* of the blank,
     not the left — this needs explicit handling, it's an easy bug to get
     backwards and not notice until you test with a real Hebrew form
5. **AI call** — send a compact structured payload, not the raw file:
   ```json
   {
     "detected_blanks": [
       { "id": "b1", "page": 2, "label": "שם העובד", "position": {...} },
       { "id": "b2", "page": 2, "label": "סכום הפיצויים", "position": {...} }
     ],
     "document_text_summary": "...",
     "user_context": "trying to get my Pitsuim, situation: ..."
   }
   ```
   Ask for structured JSON back, one entry per blank:
   ```json
   { "id": "b1", "fill": true, "value_or_instruction": "...", "reason": "..." }
   ```
6. **Web search grounding** — only triggered when the model flags genuine
   uncertainty (e.g. a legal eligibility rule it isn't confident about), not
   on every field. Keeps latency and demo risk down. Add a timeout so a slow
   search never hangs the UI.
7. **Wire back into the editor** — each classified blank becomes a
   clickable, color-coded marker (fill / skip / unclear) at its real
   coordinates. Clicking one opens the text-box tool, pre-filled with the
   AI's suggested value if confident.
8. **AcroForm variant (last, optional):** same detection → same AI
   classification call, but the output feeds a small tooltip/modal on
   hover/click instead of an editor marker. The native field stays native —
   you type into it yourself, the extension only explains it.

## 6. Multilingual documents (e.g. Hebrew forms, English conversation)

This works without architecture changes, but a few things need to be
handled deliberately:

- **Text extraction is language-agnostic.** pdf.js pulls whatever text is
  in the PDF as-is — no special handling needed to read Hebrew, English,
  or mixed-language documents. *(Confirmed on the Harel fixture: Hebrew,
  including vertical margin text, extracts correctly. See §12 for the
  Latin-run caveat.)*
- **Claude reads Hebrew natively and can respond in whatever language the
  user is using.** Send Hebrew labels + English user context, ask for the
  explanation in English — this is a normal multilingual call.
- **Explanation language vs. value language must be kept separate in the
  prompt.** The AI's *explanation* of a field can be in the user's
  language (English), but the *value* it suggests writing into the form
  usually needs to stay in the document's language/script (Hebrew) — e.g.
  a name or address should be written in Hebrew, since that's what the
  form/authority expects. Prompt for this explicitly: "explanation in
  [user's language], but the filled value must match the document's
  language/script."
- ~~**OCR must load the correct language pack.**~~ **Out of scope** — no OCR
  in this build. Kept only as a note for any future scanned-document work:
  Tesseract would need `heb` loaded explicitly, not just the default English
  pack, or scanned Hebrew forms come out as garbage.
- **RTL is a UI/extraction concern, not an AI concern.** The blank-label
  resolver's "text immediately preceding the blank" logic needs to look
  right-to-left for Hebrew (i.e. the label is to the *right* of the blank,
  not the left) — independent of how the AI call itself is made.

## 7. Multi-provider AI support (Anthropic + OpenAI)

Users provide their own key for whichever provider they choose — same
BYOK model, just for two providers instead of one.

**Scope decision:** implement **Anthropic and OpenAI fully**, stop there
for the demo. Both have solid structured-JSON output, so the same
classification schema (blanks in → `{fill, value_or_instruction, reason}`
out) works on either with minor prompt-format differences. A third
provider mostly adds another API shape to handle for a "nice to have
choice" line, not something that strengthens the core differentiator
(the blank-detection + editor pipeline).

**How to structure it:**
- One internal function, e.g. `getFieldClassifications(payload)`, that
  branches internally on the selected provider — never scatter
  `if (provider === 'openai')` checks through UI code
- Settings: dropdown (Anthropic / OpenAI) + a single API key field that
  relabels depending on which is selected
- Stored as `{ provider: 'anthropic' | 'openai', apiKey: string }` in
  `chrome.storage.local`

**Known complication — web search grounding differs per provider.**
Anthropic's web search tool and OpenAI's are wired differently. It's fine
to scope live search-grounding to one provider for the demo and say the
other needs slightly different wiring — just decide this ahead of time,
don't let it surface as a surprise on the final build day.

## 8. Storage & security model (know this cold for demo day)

| Data | Where | Persists? |
|---|---|---|
| PDF content, annotations, AI classifications | In-memory (JS state) | No — gone on tab close/refresh |
| API key | `chrome.storage.local` | Yes (deliberately, so you don't re-paste it every time) |
| Context form answers | In-memory | No |

- **No database, anywhere.** `chrome.storage.local` is sandboxed to the
  extension by Chrome, not readable by other extensions or sites, and not
  synced to any server — it's the extension-scoped equivalent of a cookie.
- **Not encrypted at rest.** Fine for this scope, but don't claim it's
  encrypted if asked — say "sandboxed locally by Chrome," which is accurate.
- **No auth system, because there's no backend to authenticate to.** The
  user's own API key is the only credential in the system, and it goes
  directly to Anthropic — never through any server of ours, because there
  isn't one.
- **Never log the API key** anywhere, including `console.log` during debugging.
- **Minimal `host_permissions`** in the manifest: `api.anthropic.com` plus
  whatever web-search API is used — nothing else.
- One line of UI copy to add: don't use this on a shared computer, since
  anyone with access to that Chrome profile could read the stored key.

## 9. Repo layout
```
extension/          MV3 extension — React + TypeScript + Vite + Tailwind
  src/
    viewer/          pdf.js rendering
    editor/           annotation overlay (text box, signature) + pdf-lib export
    copilot/         AI panel — direct client calls to Anthropic API
    context-form/    first-run API key + "what is this / what do you need"
    state/           in-memory session store (Zustand)
```
No `server/` directory — this build has no backend.

**As actually built so far** — `src/` sits at the repo root (no `extension/`
wrapper), with `background/`, `state/`, and `viewer/` present. Either update
this section or the folder structure so they stop drifting.

```
src/
  background/     MV3 service worker — no DOM, nothing canvas-related can live here
  state/          shared across contexts — must stay free of DOM and React imports
  viewer/         App.tsx, pdf-setup.ts, PdfPage.tsx, PdfTextLayer.tsx
```

## 10. Build order

### Phase 1 — Editor (Week 1)
1. **[DONE]** Extension shell (MV3) + pdf.js viewer rendering any PDF
   - [x] MV3 shell, Vite build, worker wiring (`pdf-setup.ts`)
   - [x] Drag-drop / file-picker intake, in-memory only
   - [x] `PdfPage.tsx` — canvas render at devicePixelRatio, page nav, zoom 50–300%
   - [x] `PdfTextLayer.tsx` — selectable/copyable transparent text overlay
   - [x] **Decided:** page-at-a-time, no continuous scroll. See §14.2.

2. **[DONE]** Hebrew export spike — passed. Both Hebrew and English export
   correctly via bidi-js + an LTR-forced fontkit. See §14.3; the finding there
   (fontkit silently reverses digits) is load-bearing for the text tool.

3. Coordinate model — annotations stored in **PDF points**, not screen pixels.
   Must be settled before step 4, retrofitting means rewriting everything the
   text tool touches. See §14.4.

4. Text box tool: click anywhere, type, edit, delete, drag/resize
5. Signature tool: draw-to-sign, place/resize
6. Symbol tool: checkmarks. The Harel fixture is almost entirely checkboxes —
   likely the highest-value editor feature for this specific demo, and it
   sidesteps the Hebrew font problem completely.
7. Export via pdf-lib: flatten annotations → real downloadable PDF
8. Unsaved-changes warning + buffer/polish — this is the fallback demo if AI
   has issues, it must not break

### Phase 2 — AI Copilot for flat/scanned PDFs (Week 2, days 8–13)
6. Inline context form (provider dropdown + API key + two questions) on first run, provider+key persisted after
7. pdf.js text + position extraction
   - Note: `PdfTextLayer` already proves the extraction path works. That
     component *positions* runs; this step *reassembles* them. Separate file,
     e.g. `extract-text.ts` — do not entangle it with the layer.
8. Blank-detection heuristics — test against a real demo document immediately, don't wait
9. Direct client → Claude API call, structured JSON response
10. Scoped web search grounding (uncertain fields only, with timeout)
11. Wire results into editor as clickable, color-coded markers
12. Full rehearsal on the real demo document, repeatedly

### Phase 3 — AcroForm explanation layer (only if time remains)
13. AcroForm field detection + label resolution (reuse Phase 2's resolver)
14. Same classification call, reused — output feeds a tooltip/modal
15. Hover/click → guidance modal; native field stays native, no custom fill logic

## 11. Pre-demo checklist

**Editor**
- [ ] Opens text-based and multi-page PDFs without crashing
      *(multi-page text-based: confirmed on the 3-page Harel form. Single-page
      and large 50+ page files: untested.)*
- [ ] Scanned/image-only PDF degrades cleanly: page renders, empty text layer
      doesn't throw, copilot states plainly that it can't read this page
- [ ] Text box placement stays accurate across different zoom levels
- [x] Text layer selection stays accurate across zoom levels (50%–300% verified)
- [ ] Signature draws smoothly, resizes without distortion
- [ ] Exported PDF opens correctly in Chrome, Adobe Reader, and Preview
- [ ] "Unsaved changes" warning fires on tab close

**Copilot**
- [ ] API key flow: first-run prompt, persists correctly, doesn't re-ask every session
- [ ] Graceful, visible error if the key is missing or invalid — never a silent hang
- [ ] Blank detection catches the real blanks on the actual demo PDF (no false positives/negatives on that specific file)
- [ ] RTL label resolution verified explicitly on a real Hebrew form
- [ ] Field-to-blank mapping stays correct on repeated runs
- [ ] Web search has a timeout and doesn't stall the UI if slow
- [ ] Both providers (Anthropic and OpenAI) produce correctly-structured JSON on the same test document
- [ ] Provider switch in settings correctly relabels/clears the key field and doesn't mix up stored keys
- [ ] On the Hebrew demo document: explanations render in English, suggested values render in Hebrew, and no mojibake/garbled text appears anywhere in the UI
      **⚠ This item currently fails on the Harel fixture — see §12.1. Decide
      how to handle it before demo day rather than being surprised by it.**

**AcroForm (if reached)**
- [ ] Native field rendering still works normally
- [ ] Modal/tooltip appears reliably without blocking the field itself

**Overall**
- [ ] Full demo script rehearsed start-to-finish 3–5+ times on the exact file being presented
- [ ] Fallback plan if AI/network fails live: demo the editor alone, narrate the copilot via screenshots/recording
- [ ] Tested on a clean Chrome profile to catch anything working only due to local dev state

---

## 12. Findings from the Harel fixture (`test_pdf.pdf`)

Things learned building the viewer against the real demo document. Recorded
so they don't get rediscovered as "bugs" later.

### 12.1 Latin runs extract garbled — file defect, not ours ⚠
Extracted text on some pages returns `httSs://www.harHl-grouS.co.il` and
`uQsubscribH1@harHl-iQs.co.il`. The pattern is a constant shift of 29
character codes (`p→S`, `e→H`, `n→Q`): a subset-embedded font with a broken
or missing `ToUnicode` table.

- Canvas rendering is **unaffected** — drawing needs glyph outlines, which
  are intact. Only text extraction is broken. Same file, two data paths.
- Not fixable in our code. Acrobat produces the same mush.
- Hebrew runs on the same document extract **correctly**, and different
  pages of the same file differ in quality.

**Implication for the demo:** the pre-demo checklist promises "no garbled
text anywhere in the UI." Options, pick one deliberately:
1. Detect and disclose — flag low-confidence extraction to the user
   ("text extraction looks unreliable on this page") rather than silently
   feeding garbage to the model. Cheap heuristic: ratio of uppercase letters
   appearing mid-word; `harHl` / `grouS` / `uQsubscribH` trip it instantly,
   clean text almost never does.
2. Let the model repair it — works for prose, since the shift is obvious.
   **Scope it carefully:** this document contains an account number, a tax
   file number (935921908) and phone numbers. A model asked to "fix spelling"
   will happily normalise digits that were never corrupted. Never apply
   repair to anything the user acts on financially.
3. Pick a different demo page. The garbled runs are concentrated in the
   fine print, not the field labels, so blank detection may be unaffected.

Recommendation: (1) for correctness, and check whether (3) makes it moot.

### 12.2 Text runs are fragmented by design
A PDF has no concept of a line or paragraph — only positioned glyph runs. A
new run starts on any change of font, weight, size, colour, or a horizontal
position jump. One visual line is routinely 3+ items.

Directly affects two later steps:
- **Search** will miss terms straddling a run boundary. Standard fix:
  concatenate all items into one string, search that, map matches back to
  span index + offset.
- **Blank detection and copilot context** (§5.4, Phase 2 step 8) — raw item
  order on a boxed form like this is close to arbitrary. Needs grouping into
  lines by y-coordinate and blocks by gap width before anything downstream
  is meaningful. This is the reassembly step noted in Phase 2 step 7.

### 12.3 Scale-factor bugs will recur in the editor
The text layer's spans are positioned in **CSS pixel space** using a viewport
built at plain `scale` — *not* `scale * dpr` like the canvas. Mixing the two
puts everything at double offset on a retina display.

The annotation overlay in Phase 1 step 2 has exactly the same problem, and
the checklist item "text box placement stays accurate across zoom levels" is
the same bug wearing a different hat. Reuse the CSS-space viewport approach.

Also: pdf.js emits spans with percentage positions plus `--font-height` and
`--scale-x` custom properties, and relies on `pdfjs-dist/web/pdf_viewer.css`
to turn those into real sizes. Hand-writing that CSS silently produces
fixed-size spans that only look right at one zoom level. Import the real
stylesheet.

### 12.4 Alignment is approximate and that's final
pdf.js measures each run and applies a horizontal `scaleX` to stretch the
substitute system font to the width the embedded font produced. Small
residual drift is inherent — not a bug, not improvable, every browser PDF
viewer does this. Do not spend time on it.

### 12.5 Ownership rules established
- `page.cleanup()` lives in **`PdfPage` only**. Both components call
  `doc.getPage()` and get the *same cached proxy*; a second cleanup call can
  free fonts out from under a live render.
- If text-layer failures ever appear in the console only on fast page
  changes, the suspect is `PdfPage`'s `cleanup()` racing the text stream.
  Fix is to drop the call — pdf.js reclaims on proxy eviction anyway.
- Canvas render lifecycle stays **local component state**. Wanting to hoist
  "which page is rendering" into `state/` is a signal something else is
  wrong — that store is shared with the DOM-less background worker.

### 12.6 Cancellation pattern (reuse this)
Every long-running pdf.js operation follows the same three beats, because
React re-triggers effects faster than these complete:
1. `cancel()` — a request, not an instant stop. Returns immediately.
2. `await …promise.catch(() => {})` — wait for the real teardown.
3. Null the refs.

Plus a `cancelled` boolean flipped in effect cleanup, checked after **every**
`await` — that guards against stale results, which is a different problem
from cancellation. Skipping beat 2 gives "Cannot use the same canvas during
multiple render() operations" on the canvas, and duplicate stacked spans on
the text layer.

---

## 13. Ideas / open questions (not committed)

- **OCR — explicitly cut.** Would have been the fallback for both §12.1 and
  scanned pages, and the canvas is always correct regardless of font defects,
  so Tesseract over the rendered bitmap sidesteps everything. But it's a whole
  subsystem, not a tweak. Revisit only after the demo, if at all.
- **`TextLayer.update({ viewport })`** repositions existing spans instead of
  rebuilding on zoom. Cheaper on every zoom step. Not worth doing until
  something feels slow.
- **Canvas blanks on every zoom step** because assigning `canvas.width`
  clears it. Fix if it bothers anyone: render to a detached canvas, swap on
  completion. Cosmetic.
- **Extraction-quality signal as a first-class concept.** §12.1 needs it,
  scanned pages need it (no text layer at all), and the copilot needs to know
  when not to trust its own input. Might be one shared function feeding both
  a UI warning and the AI payload.
- **`page.getOperatorList()`** can sometimes recover characters when
  `ToUnicode` is broken, by matching glyph IDs against the font program.
  Fiddly, rarely worth it — noted only so it isn't rediscovered as a bright idea.

---

## 14. Session handoff — start here

### 14.1 State of play
Phase 1 step 1 is complete. The viewer renders, paginates, zooms 50–300%, and
supports text selection and copy. Two files were built and tested against the
real demo document (`test_pdf.pdf`, a 3-page Hebrew Harel severance form):

- **`src/viewer/PdfPage.tsx`** — renders one page to canvas. Viewport built at
  `scale * devicePixelRatio` for the backing store; CSS box set to `scale`.
  Full render-task cancellation so fast zoom/page-change can't collide on the
  same canvas. Errors show as an overlay, never replacing the canvas (that
  would unmount the ref and dead-end recovery).
- **`src/viewer/PdfTextLayer.tsx`** — transparent positioned spans over the
  canvas for selection/copy. Viewport built at plain `scale` (CSS pixel
  space). Sets `--scale-factor` and `--total-scale-factor` on its container.
  Requires `import "pdfjs-dist/web/pdf_viewer.css"` — see §12.3.

Both typecheck clean. pdf.js is v6-era (`page.render()` requires `canvas`,
`TextLayer` is exported from the core entry, not the viewer bundle).

### 14.2 Decision: page-at-a-time, no continuous scroll
Scroll doesn't affect copilot correctness — markers anchor to page +
coordinates either way. It affects *discoverability*: a user on page 1 can't
see that page 3 has eight more fields.

**Consequence, now mandatory rather than optional:** the copilot panel must be
a navigable list. One row per classified blank (label, fill/skip/unclear,
page number); clicking sets `pageNumber` and highlights the marker. That's the
scroll substitute, and it demos better than scrolling — the AI's reasoning
becomes a scannable list rather than something the presenter hunts for.
Folded into Phase 2 step 11.

### 14.3 RESOLVED: Hebrew + English export works — spike complete
Ran the spike against `test_pdf.pdf`. **Both scripts export correctly.** The
solution is two lines, but neither alone is sufficient, and the failure mode
of getting it wrong is silent.

**The finding.** `fontkit` (which pdf-lib uses internally for custom fonts)
*already* reverses Hebrew glyph order — but naively, reversing the whole
string rather than running the bidi algorithm. Consequences:

| input | fontkit alone | correct |
|---|---|---|
| `שם משפחה` | ✅ right by accident | ✅ |
| `רחוב הרצל 45` | ❌ `54` | `45` |
| `חשבון 935921908 בבנק HSBC` | ❌ `809129539` / `CBSH` | unchanged |

**Pure Hebrew looks perfect, so this passes casual inspection.** Digits and
Latin inside Hebrew get silently reversed — an account number written
backwards onto a severance form, by someone who reads the Hebrew fine and
never scrutinises the numbers. This is the single most dangerous bug the
project could have shipped, and it is invisible without deliberate testing.

**The fix — both halves required:**
1. `bidi-js` `getReorderedString()` for correct logical→visual ordering.
   Handles digits, Latin runs, and bracket mirroring. Latin-only strings pass
   through untouched, so English needs no special case.
2. Force fontkit to `"ltr"` so it doesn't reverse our already-correct output a
   second time. pdf-lib exposes no direction option, but `registerFontkit()`
   takes the module — patch `layout()` there.

**The code. Both pieces belong in the export path only** (the spike itself was
deleted; this is all that survived it):

```js
import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";

const bidi = bidiFactory();

/** Logical order (as typed) -> visual order (as drawn). */
const toVisualOrder = (text) =>
    bidi.getReorderedString(text, bidi.getEmbeddingLevels(text));

/**
 * DO NOT REMOVE. pdf-lib delegates glyph layout to fontkit, which reverses
 * RTL strings naively — reversing digits and Latin runs along with the
 * Hebrew. We already ordered the string correctly with bidi-js above, so
 * fontkit must be told not to reorder again. Without this, account numbers
 * silently export backwards and nobody notices.
 */
const ltrFontkit = {
    create(bytes, postscriptName) {
        const font = fontkit.create(bytes, postscriptName);
        const originalLayout = font.layout.bind(font);
        font.layout = (str, features, script, language, direction) =>
            originalLayout(str, features, script, language, direction || "ltr");
        return font;
    },
};

// usage
pdfDoc.registerFontkit(ltrFontkit);
const font = await pdfDoc.embedFont(fontBytes, { subset: true });
page.drawText(toVisualOrder(userText), { x, y, size, font });
```

Keep that comment block on `ltrFontkit`. Without it the patch reads as
mysterious cruft and someone deletes it, and the bug returns silently.

**Verified end to end:** built a PDF, read it back with pdf.js, confirmed
round-trip. All five cases (pure Hebrew, Hebrew+digits, mixed script,
parenthesised, pure Latin) return exactly what was typed.

**Copy-out is fine.** Earlier concern was unfounded — pdf.js applies bidi
during extraction and recovers logical order from visual glyphs. No
`/ActualText` needed.

**Font:** static `NotoSansHebrew-Regular.ttf` from the notofonts GitHub
release — *not* Google Fonts, which serves a variable font that fontkit
subsetting handles poorly:

```bash
curl -sSL -o noto.zip "https://github.com/notofonts/hebrew/releases/download/NotoSansHebrew-v3.001/NotoSansHebrew-v3.001.zip"
unzip -q noto.zip   # static TTFs are in NotoSansHebrew/full/ttf/
```

Glyph coverage verified: Hebrew, Latin, digits, brackets, `@`, `.`, `₪` all
present, so **one font covers both languages** — no per-script font switching
needed. Lives in `public/fonts/` (Vite copies it verbatim; load via
`chrome.runtime.getURL()`, same pattern as the pdf.js cmaps in
`pdf-setup.ts`). OFL licensed — `OFL.txt` must ship beside it.

**Dependencies:** `pdf-lib`, `@pdf-lib/fontkit`, `bidi-js` — these ship in the
extension, so they belong in `dependencies`, not `devDependencies`.

**Carry into the text tool:** store text in **logical order** (what the user
typed). Convert to visual only at export. Never store visual order — it would
corrupt editing, search, and anything sent to the AI.

### 14.4 Decision: annotations stored in PDF points
Every annotation is `{ page, x, y, width, height, ... }` in PDF points.
Convert to CSS pixels only at render time, using the same viewport approach as
the text layer.

Storing screen pixels instead breaks three things: annotations placed at 120%
land wrong at 300%, page changes scramble them, and export needs a conversion
that's easy to get subtly wrong. pdf.js provides
`viewport.convertToPdfPoint(x, y)` and `convertToViewportPoint(x, y)` — they
handle the y-axis flip (PDF origin is bottom-left, y up; canvas is top-left,
y down) and rotation.

Bonus: pdf-lib draws in PDF points natively, so storing correctly makes export
nearly free. This single choice decides the checklist item "text box placement
stays accurate across different zoom levels."

### 14.5 Immediate next actions, in order
1. Settle the coordinate model (§14.4) — types + convert helpers.
2. Then Phase 1 step 4, the text box tool. Store logical order; convert to
   visual only at export, using the two-part fix from §14.3.

### 14.6 Working conventions established
- Explain the file and its non-obvious parts before writing code.
- One file at a time.
- Skeletons with TODO blocks; the human writes the component logic.
- The cancellation pattern in §12.6 is reused for every long-running pdf.js
  operation. It will come up again in the annotation and export layers.

### 14.7 Decision: scanned / image-only PDFs are editor-only, no copilot
The copilot requires a text layer. Scanned pages have none, and OCR is cut
(§13). So the product line is:

| PDF type | Viewer | Editor | Copilot |
|---|---|---|---|
| Text-based (incl. the Harel fixture) | ✅ | ✅ | ✅ |
| Scanned / image-only | ✅ | ✅ | ❌ — states why |

This costs almost nothing to support, because **the editor never needed text.**
Canvas rendering already works on scanned pages, and placing a text box or
signature is pure coordinate work (§14.4) that doesn't care what's underneath.
So "editor works, copilot doesn't" falls out of the existing architecture
rather than being a separate build.

**What is required: degrading cleanly.** Someone will drop a scanned PDF in
during the demo. Needed behaviour:
- Page renders normally (already true)
- Empty text layer doesn't throw — `streamTextContent()` on a page with no
  text should yield an empty stream, but this is **untested**; verify
- Copilot panel says plainly that it can't read this page and the editor still
  works — not a silent empty panel that looks broken

A few lines, but deliberate ones. **Not Phase 1 work** — tracked as a pre-demo
checklist item (§11, Editor) so it gets verified before demo day without
sitting in the build path.