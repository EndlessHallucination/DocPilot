# PDF Copilot

Fill and sign any PDF in the browser — and get told, field by field, what to
put where and why, based on your own situation.

**Live:** https://pdf-copilot.netlify.app/

No backend, no database, no accounts. The document never leaves your browser.

---

## The problem

Filling in a bureaucratic form today means uploading the PDF to an AI chat,
asking what to fill in, getting prose back, then switching to a *separate* tool
to type into the PDF — working out for yourself where each described field
actually sits on the page.

PDF Copilot collapses that into one flow. The AI's answer and the place you act
on it are the same interface, and the answer is tied to real coordinates
instead of prose you have to translate.

The main test document is a severance-withdrawal form from an Israeli pension
provider: three pages, Hebrew, right-to-left, with comb fields, checkboxes and
dotted leaders. An IRS W-9 serves as the Latin/left-to-right counterpart.

---

## What it does

- **Read and edit any PDF** — text boxes, tick marks, drawn signatures, and an
  export that flattens them into a real PDF. Hebrew and English both export
  correctly, including digits inside right-to-left text.
- **Explain the form field by field** — a verdict per line (fill in / skip /
  unclear), with a reason, and the literal value to write where one can be
  known.
- **Show you where** — a marker on the page at the exact coordinates of each
  field you need to fill, and a highlight for any line you click in the panel.
- **Answer follow-up questions** about anything on the form, with the
  document's text already in context.

Explanations come back in English; values come back in the form's own language
and script, because that is what the receiving authority expects.

---

## The one design decision worth knowing

**The model sees the whole document text and decides what the fields are.
Geometry only answers "where exactly does a mark go".**

The obvious design is the opposite: find the blanks and checkboxes
geometrically, then ask the model about each one. That fails on real forms.

Because discovery is text-driven, a document where every detector fails still
gets every field found, explained and listed. Only mark placement degrades.

---

## Privacy

- **No backend and no database.** Everything runs client-side.
- **Bring your own API key.** It is stored in this browser only — extension
  storage in the extension build, `localStorage` on the web — and is sent only
  to the provider you chose. It is not encrypted; don't use this on a shared
  computer.
- **Your document is never uploaded.** Only the extracted *text* is sent to the
  model, and only when you use the copilot. Coordinates never leave the
  browser: one function (`projectLines`) is the sole serialisation of document
  data in the codebase, and it rebuilds each line field by field rather than
  spreading it, so a coordinate cannot start being uploaded by accident.
- **Nothing persists but the key.** Your stated situation and the whole
  question thread are in memory and gone on refresh.

---

## Running it

Requires Node 20+ and an API key from Anthropic, OpenAI or Groq.

```bash
npm install

npm run dev            # development
npm run build          # Chrome extension  -> dist/       (load unpacked)
npm run build:web      # static site       -> dist-web/
```

Both builds come from the same source. The only environment-specific code is
`src/copilot/storage.ts`, which picks a storage backend and resolves bundled
asset URLs at runtime.

---

## How it works

```
PDF ─ pdf.js ─┬─ extract-text.ts ──── ordered lines, logical order, PDF points
              └─ extract-geometry.ts ─ checkboxes, comb cells, dashed leaders
                        │
                  detect-field.ts ─┬─ payload  → the model   (text only)
                                   └─ geometry → the client  (coordinates only)
                        │
                  classify.ts ───── a verdict per field
                        │
                  VerdictMarkers ── markers drawn at real coordinates
```

**Nothing is hardcoded per document.** Checkbox size is the mode of *this*
document's own size histogram. Comb cell width comes from repetition. The gap
that counts as a blank is one em of the adjacent text. The offset from a label
to its checkbox is calibrated from the boxes this document actually drew — and
then used to place a mark on the clause where no box was printed.

Line direction, and the corruption check's on/off threshold, are likewise
derived from the document's own content.

---

## Known limits

Stated rather than hidden — each has a reason.

- **One page per request.** Hebrew tokenises at roughly one token per
  character, so a page of verdicts with prose reasons fills the output budget.
  A dense single Hebrew page can exceed it on its own. The fix is chunking by
  character budget rather than by page.
- **Cross-page reasoning is lost** as a result: the pension form's page 3 lists
  which documents to attach depending on which option was ticked on page 1.
- **Two-column pages interleave** in the field list. Marker placement is
  unaffected — coordinates come from the geometry map, not from list order.
- **Scanned or image-only PDFs** are editor-only. The panel says so.
- **No autofill, deliberately.** The copilot tells you what belongs in each
  field and marks where it goes. It does not type into the form for you. Those
  are different claims, and the second is not needed for the first to be
  useful.

---

## Built with

React · TypeScript · Vite · Tailwind · zustand · pdf.js (viewing and reading) ·
pdf-lib + fontkit + bidi-js (editing and export)