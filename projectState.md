# PDF Copilot / DocPilot — Project State

> Paste this at the start of a new chat to restore context.
> Last updated: end of Day 1.

---

## Environment

- **macOS**, zsh. Node 22, npm 10.
- Project folder: `~/Desktop/other projects/pdf-copilot` — **note the space** in
  "other projects"; `cd` needs escaping (`cd ~/Desktop/other\ projects/pdf-copilot`).
- Repo is named **DocPilot**, folder is **pdf-copilot**, manifest name is
  **PDF Copilot**. Not yet reconciled — pick one before the demo.
- **Vite 8.2.1 (Rolldown-based)**, not Vite 6. Builds in ~450ms.
  `build.rollupOptions` still works; `build.rolldownOptions` is the new name and
  will eventually be required.
- Two live deprecation warnings to clear:
  - `vite.config.ts` — import `'./manifest.config.ts'` **with** the extension
  - `manifest.config.ts` — `import pkg from './package.json' with { type: 'json' }`
- Testing: `npm run build`, then `chrome://extensions` → Load unpacked → `dist`.
  **Must click the reload arrow on the extension card after every build** — a
  rebuild alone does not reload it.
- `npm run typecheck` for a fast check without bundling.

---

## What this is

A Chrome extension (MV3) that renders any PDF in-browser, lets you fill and
sign it, and uses an LLM to explain — field by field — what to fill in, what to
skip, and why, based on the user's stated situation.

No backend. No database. No accounts. The user brings their own API key.

**Repo:** https://github.com/EndlessHallucination/DocPilot
**Local folder:** `~/Desktop/other projects/pdf-copilot`

---

## Current status: Day 1 complete

The extension shell works end to end. Click icon → tab opens → drop a PDF →
pdf.js parses it → toolbar shows filename, page count, page nav, zoom.
Page rendering is still a stub.

### Files that exist

| File                               | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `package.json`                     | Deps. Version 0.1.0, `"type": "module"`                  |
| `tsconfig.json`                    | strict, noEmit, `types: ["chrome", "vite/client"]`       |
| `manifest.config.ts`               | MV3 manifest. `permissions: ["storage"]` only            |
| `vite.config.ts`                   | CRXJS + Tailwind 4 + static copy of pdf.js assets        |
| `src/background/service-worker.ts` | Icon click → opens viewer tab                            |
| `src/viewer/index.html`            | Mount point. Script src must be `./main.tsx` (relative!) |
| `src/viewer/main.tsx`              | React root, StrictMode on                                |
| `src/viewer/styles.css`            | `@import "tailwindcss"` + full height chain              |
| `src/viewer/pdf-setup.ts`          | pdf.js config + `loadPdf()`                              |
| `src/viewer/App.tsx`               | State, drop zone, toolbar, `PdfPage` stub                |

### Stack (verified working)

- Vite 8 (Rolldown) + `@crxjs/vite-plugin` 2.7.1
- React 19 + TypeScript 5.8 + Tailwind 4
- `pdfjs-dist` ^6.2.108 — **do not downgrade to 5.x**, it has a high-severity
  advisory for arbitrary JS execution when opening a malicious PDF
- `pdf-lib` (installed, not yet used)
- `zustand` (installed, not yet used)

---

## Decisions made, and why

| Decision                                         | Reason                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **No backend**                                   | Nothing to persist, nothing to authenticate to. BYOK.                                                                                |
| **OCR cut from scope**                           | Demo doc has a text layer. Tesseract under MV3 is a half-day of CSP/wasm bundling for no demo value.                                 |
| **Entry point = own viewer tab, drag-drop**      | Chrome's built-in PDF viewer is a sealed plugin; you cannot overlay it.                                                              |
| **AcroForm explanation layer dropped**           | The demo PDF reports `Form: none`. No interactive fields exist to explain. Revisit only as a stretch goal with a different document. |
| **Blank detection = vector geometry, not regex** | See findings below. There are no underscore characters in the file.                                                                  |
| **pdf.js worker via `?worker` + `workerPort`**   | Module workers fail from `chrome-extension://` URLs. Vite bundles a classic worker instead.                                          |

---

## Findings from the real demo document

Document: Harel קופת גמל withdrawal form (בקשה למשיכת כספים), 3 pages, A4.
**Blank copy obtained and verified** (`test_pdf.pdf`) — zero ArialUnicodeMS
characters, which was the font the previous copy's stamped-in personal data used.

- **Text layer present.** No OCR needed.
- **`Form: none`** — flat PDF, no AcroForm fields.
- **Three kinds of blank, not one:**
  1. **Dashed stroke lines** — `dash=([0, 1.495], 0)`, linewidth 0.5.
  2. **Unfilled 8.00 x 8.00 pt rects** — checkboxes, mostly at `x0 = 544.27`
     or `542.84`.
  3. **Table cells** — solid 0.5pt borders, `dash=None`. Sections א and ה.
- **Solid vs dashed is the discriminator** between table borders and write-on rules.
- **All of this is vector graphics.** `getTextContent()` returns none of it.
  Must use `page.getOperatorList()` and walk ops (`OPS.setDash`,
  `OPS.constructPath`, `OPS.rectangle`, `OPS.stroke`), accumulating the CTM.
- **RTL confirmed twice over:**
  - Label sits to the **right** of the blank. Verified example: blank at
    `x0=376.81 x1=451.55`, label `בתאריך` at `x0=455.05`. Gap 3.5pt.
  - Extracted strings come out **visually reversed** — `פרשתי` extracts as
    `יתשרפ`. Must reverse Hebrew runs to restore logical order before sending
    to the AI, and reverse again before `drawText` on export.
- **Detector baseline — the exact counts to hit on the blank file:**

  | Page | Checkboxes | Dashed rules |
  | ---- | ---------- | ------------ |
  | 1    | 12         | 4            |
  | 2    | 1          | 10           |
  | 3    | 7          | 0            |

  Totals: 20 checkboxes, 14 dashed rules. Plus table-cell blanks in sections
  א, ד and ה, which need a separate rule.

- **Checkbox-dominant.** The AI's value is "which box to tick and why," not
  "type your name." Section ב is the hard case: choosing correctly needs the
  1.1.2008 / 1.1.2005 deposit-date rules, age 60, and 24-months-since-employment.
- **Two extraction artifacts:** Latin mojibake on page 2
  (`httSs://www.harHl-grouS` = broken ToUnicode CMap on one Identity-H font),
  and off-page "Dummy Text" objects at `top ≈ 845.8` on an 841.89pt page.

### Action items from this

- Get a **blank** copy of the form. The current one is pre-filled with real
  personal data (ID number, bank account, signature) and gives the detector
  nothing to detect.
- Keep a second, simpler PDF for demoing the editor.

---

## Roadmap

### Phase 1 — Editor (Week 1)

- [x] Extension shell, MV3, viewer tab, drag-drop, toolbar
- [ ] **`PdfPage.tsx` — real canvas rendering.** Three known problems:
      (a) render race — rendering is async; changing page/zoom mid-render makes
      two renders compete for one canvas and pdf.js throws. StrictMode's
      double-invoke surfaces this immediately.
      (b) devicePixelRatio — backing store must scale by DPR or Retina looks blurry.
      (c) first real test of whether the cmaps render Hebrew.
- [ ] `geometry.ts` — the single place viewport↔PDF-space conversion happens.
      Use `viewport.convertToPdfPoint()` / `convertToViewportPoint()`, plus
      `page.view` origin for non-zero CropBox. Unit-test on a rotated page.
- [ ] Text box tool: click, type, drag/resize
- [ ] Signature tool: draw-to-sign, place/resize
- [ ] Export via pdf-lib. **Hebrew will hard-fail twice here:**
      `StandardFonts.Helvetica` throws on Hebrew codepoints — must
      `registerFontkit()` and embed a Noto Sans Hebrew TTF with `subset: true`.
      And pdf-lib does no bidi reordering — reverse RTL runs before drawing.
- [ ] Polish. This is the fallback demo if AI fails live; it must not break.

### Phase 2 — AI Copilot (Week 2)

- [ ] Context form: provider dropdown + API key + "what is this / what do you need"
- [ ] Operator-list walker → `{id, kind, page, x, y, w, h}`
- [ ] Label resolver — RTL-aware, nearest text run to the right on same baseline
- [ ] `getFieldClassifications(payload)` — one function, branches on provider
- [ ] Web search grounding — Anthropic only, with timeout (see scope note below)
- [ ] Markers wired back into the editor, color-coded

---

## AI call contract (revised for checkbox-dominant forms)

Send: compact list of detected blanks + labels + positions, document summary,
user context. **Never the raw file.**

```ts
interface FieldClassification {
  id: string;
  kind: "checkbox" | "text";
  action: "check" | "write" | "skip";
  value?: string; // in the document's language/script (Hebrew)
  reason: string; // in the user's language (English)
  confidence: "high" | "low";
}
```

Prompt must separate explanation language from value language explicitly.

**Scope: both providers get full field classification.** Only _web search
grounding_ is Anthropic-only — its search is a server-side tool that resolves in
one round trip, while OpenAI's needs a separate implementation for a path that
only fires on low-confidence fields. Selecting OpenAI works fully, minus live
grounding. State that as a known limitation rather than hiding it.

**Provider differences:**

- Anthropic: force a tool call (`tool_choice: {type:'tool'}`), read `input`
  off the `tool_use` block. Headers: `x-api-key`, `anthropic-version:
2023-06-01`, `anthropic-dangerous-direct-browser-access: true` — without the
  last one you get a 401 that reads like a bad key.
- OpenAI: `response_format: {type: 'json_schema', strict: true}`, bearer token.

---

## Gotchas already hit (don't rediscover these)

1. `isEvalSupported` was **removed in pdf.js v6**. It runs PDF scripting in a
   WASM sandbox now (`quickjs-eval.wasm`), which is why the option disappeared.
2. pdf.js v6 needs `wasmUrl` — `jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm`.
   Requires `'wasm-unsafe-eval'` in the manifest CSP.
3. Module workers fail from `chrome-extension://`. Use
   `import W from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'` +
   `GlobalWorkerOptions.workerPort = new W()`.
4. **pdf.js detaches the ArrayBuffer you hand it.** Copy with `.slice()` before
   `getDocument`, or the bytes are empty when pdf-lib needs them.
5. All pdf.js asset URLs need a **trailing slash**.
6. `chrome.tabs.create` needs no permission. The `tabs` permission is for
   _reading_ tab properties (`url`, `title`) — relevant if we add PDF-link detection.
7. `default_popup` and `action.onClicked` are mutually exclusive.
8. Script src in `index.html` must be relative (`./main.tsx`), never `/src/...`.
9. Vite 8 uses Rolldown. `rollupOptions` still works; `rolldownOptions` is the
   new name.

---

## Open questions

- ~~Blank copy of the Harel form~~ — done, `test_pdf.pdf`
- Second simple PDF for the editor demo — chosen? (this form is checkbox-heavy,
  so it doesn't show off the text/signature tools well)
- Final name: repo says DocPilot, folder says pdf-copilot. Pick one.
- Which provider gets live web-search grounding for the demo (recommend Anthropic).

---

## Working agreement

- One file at a time. Explain the purpose and the non-obvious parts before code.
- Basil writes component logic and state; configs come pre-written and explained.
- Skeletons with marked `TODO` blocks, then review.
- Paste errors rather than working around them — two real API changes were
  caught this way already.
