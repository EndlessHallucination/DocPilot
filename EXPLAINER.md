# PDF Copilot — Explainer

Why the code is shaped the way it is.

This is the companion to `PROJECT-STATE.md`. That document tracks _what is done
and what is left_; this one explains _how the thing works and why each decision
went the way it did_. Code comments point here by section number
(`EXPLAINER §4.1`), so the numbering is stable — add sections, don't renumber.

Read §1 and §2 for the shape of the whole thing. Read §9 before presenting.

---

## 1. The one-sentence version

**A PDF is a bag of positioned glyphs and vector strokes. It contains no
sentences, no lines, no fields, and no forms — those are things a human infers
from ink. This program reconstructs enough of that inference to hand the model
text it can reason about, and to hand the user a coordinate they can act on.**

Everything in the codebase is a consequence of that sentence. The model is good
at "which of these clauses applies to someone who left their job in March"; it
is useless at "x: 544.3". Our code is the reverse. So the work is split along
that line, and the interesting engineering is all in the seam.

### 1.1 The product claim, precisely

The AI's answer and the place you act on it are **the same interface**.

That is the whole difference from pasting a PDF into a chat window. A chat gives
you prose you then have to map onto the page yourself; this gives you a verdict
attached to a rectangle.

Note what the claim does _not_ include: typing for you. See §9.5.

---

## 2. The pipeline, end to end

```
   a PDF file
       │
       ├─ pdf.js ──────────────────────────────────────────────┐
       │                                                        │
   extract-text.ts            extract-geometry.ts               │  render
   ordered lines,             checkboxes, comb cells,           │  to canvas
   logical order,             dashed leaders                    │
   PDF points                 (document-level)                  │
       │                              │                         │
       └──────────┬───────────────────┘                         │
                  │                                             │
            detect-field.ts                                     │
       joins them, produces TWO things:                         │
                  │                                             │
        ┌─────────┴──────────┐                                  │
        │                    │                                  │
   PAYLOAD              GEOMETRY MAP                            │
   text + tags          coordinates only                        │
   no coordinates       never leaves the browser                │
        │                    │                                  │
   classify.ts               │                                  │
   provider.ts               │                                  │
        │                    │                                  │
   verdicts keyed by ref     │                                  │
        │                    │                                  │
        └─────────┬──────────┘                                  │
                  │                                             │
          VerdictMarkers.tsx ◄──── coordinates.ts ──────────────┘
          markers + focus band     (the only points↔pixels
                                    conversion in the codebase)
```

Two things to notice in that diagram.

**The split at `detect-field.ts` is the privacy boundary.** One branch is
uploadable and carries no coordinates by construction; the other never leaves
the browser. §5.1.

**The two branches rejoin at a rectangle.** The model answers about a _line_;
the geometry map knows where that line's fields _are_. Reuniting them is what
makes a marker possible, and it is the whole reason local extraction exists —
if we just uploaded the PDF and asked for prose, there'd be nothing to attach
the answer to.

---

## 3. Reading a PDF (`extract-text.ts`)

### 3.1 There are no lines in a PDF

A PDF's content stream is a sequence of "draw these glyphs at this transform".
Nothing marks where one line ends and the next begins. pdf.js reconstructs
_some_ of this, and the reconstruction is the first thing to understand.

**pdf.js emits an invisible zero-width item with `str === ""` and
`hasEOL: true` at the end of each line.** Those items _are_ the line breaks —
50, 47 and 23 of them across the fixture's three pages. Filter them out before
grouping and you have thrown away the line structure and must rebuild it from
y-coordinates.

**Why the y-coordinate route is worse, measured rather than assumed:**

- Superscripts sit about 3pt off the baseline. Any tolerance tight enough to
  keep adjacent table cells apart will split a superscript onto its own line.
  The content stream keeps them together correctly.
- On page 2 a rotated margin word shares a baseline with an unrelated heading.
  Geometry cannot separate two things that happen to sit at the same y. The
  stream can.

So: split on `hasEOL`, and there is no tolerance constant anywhere in the
primary path.

**⚠ Two different empty-ish strings, and the distinction is load-bearing.**
`str === ""` is a delimiter — drop it. `str === " "` is _real whitespace printed
on the page_ and must survive, because every blank on the Hebrew fixture is a
whitespace run followed by a large positional jump, and that jump is Phase 2's
only signal for a write-in field. Widening the filter to `!str.trim()` looks
tidier and silently deletes the signal.

### 3.2 The guard, and why it took three attempts

A PDF from Word, LaTeX or a scanner may emit **no `hasEOL` at all**. Then line
splitting returns one line per page, the payload becomes three enormous strings,
and _nothing looks broken_ — no error, no warning, plausible-looking output.
That is the worst failure mode available, so it needs a detector.

Three versions, and the two failures are more instructive than the fix:

1. **Items-per-line ratio.** Wrong, and do not restore it. It false-positived on
   ordinary documents, because items-per-line measures how aggressively the
   _producer_ merged glyph runs — not whether line splitting worked.
2. **The right measurement with `some()`.** One odd group failed a whole page.
3. **Current:** a line is text sharing a baseline, so measure exactly that — a
   group's vertical spread against its own tallest glyph. Fall back to
   y-clustering only when more than 25% of a page's groups exceed 3×.

**The lesson worth keeping:** version 1 measured something correlated with the
thing it cared about. Version 3 measures the thing itself. When a heuristic
false-positives, ask what it is actually measuring.

⚠ This guard has **never fired on a real document**, only on a forced
threshold. `smoke.ts` warns loudly if `lineSource` ever reads `"clustered"`.
It remains the highest-risk unknown in the codebase, because on the fallback
path text degrades slightly and _placement degrades badly_ (§3.3's merge case).

### 3.3 Reading order, at two scales

**Within a line**, pdf.js emits runs in x-ascending order — which for Hebrew is
backwards. The fixture's table header arrives as
`[birth date] [ID no.] [first name] [family name]` and reads in the reverse
order. Every line must be re-sorted by its own direction.

**Across a page**, the content stream is _not_ in reading order either. pdf.js
emits items in the order the producer wrote them, and InDesign writes one text
frame at a time, in creation order. Measured on the fixture: page 1 gives
section א, then ג, then ב.

Fix: **sort each page's lines by y descending.** A stable sort, so lines sharing
a baseline keep stream order for free. Correct on all three test documents.

⚠ **Frame grouping was tried and fails.** Grouping consecutive lines while y
descends, then sorting the groups, produces 6 groups on page 1 and 4 on page 2,
none aligned to the real sections. Don't re-attempt.

⚠ **Known limit: two-column pages interleave.** On the W-9 the right-hand
column's lines splice between the left column's, starting at line 0 — even the
masthead arrives shuffled. This is deliberately unfixed, and the reason is worth
knowing: a real fix means clustering lines into column bands, which needs a rule
for _when a page is two-column_, and getting that wrong scrambles a
single-column form — the common case. Blast radius measured, not assumed:
placement unaffected (coordinates come from the geometry map, never from list
position), panel readability degraded, model context degraded and survivable —
the model classified the interleaved page correctly.

### 3.4 Deciding a line's direction — and why there are two different rules

`extract-text.ts` decides direction by **"does this line contain any strong RTL
character"**. `editor/export.ts` decides it by **"is the first strong character
RTL"**. The second is the textbook rule. They differ on purpose.

The textbook rule requires the string to already be in logical order. But
logical order is exactly what `extract-text.ts` is trying to produce. Circular.
So it uses presence instead. Export escapes the circle legitimately, because by
then the string _is_ in logical order.

**Don't "unify" them.** They answer different questions at different stages.

Digits and punctuation count as neither direction in both rules — lines
routinely start with a lone space, a stray `.`, or the digits of a date, and
pdf.js reports `dir: "ltr"` for all of them. None is evidence.

### 3.5 Text corruption, and why it can only be disclosed

Some PDFs have a partially-populated `ToUnicode` table, so _some glyphs_ extract
as the wrong character. On the fixture: every Hebrew character is correct, and
five Latin words are broken.

Three facts that shaped the code:

- **It is per-glyph, not per-font.** The same font gives `HSBC` correctly and
  `Qo` (truly `QR`) wrongly, on the same page.
- **The offset isn't consistent in sign** — `p→S` is −29, `R→o` is +29. So no
  repair is possible. Only disclosure.
- **It must be reported as character ranges, not a per-run boolean.** pdf.js v6
  merges adjacent runs, so corrupted Latin now sits _inside_ otherwise-perfect
  Hebrew items. A boolean would either condemn forty good words to flag two bad
  ones, or clear the bad ones because the run is mostly fine.

**The detection rule:** an uppercase letter immediately after a lowercase one,
inside a single alphabetic word. Flags `httSs`, `harHl`, `uQsubscribH`. Passes
`HSBC`, `www`, `co`, `il`.

⚠ **The tokenizer must be `/[A-Za-z]+/g`, not `\b`-anchored.** The corrupted
text is `il.co.iQs-harHl@1uQsubscribH`, and a `\b` boundary can't start at `u`
because a digit precedes it. The `\b` version silently finds 4 of the 5 words.

⚠ **And the rule cannot survive an English document.** It flagged `SaaS`,
`JavaScript`, `macOS`, `iPhone` — 22 false positives. So it is **gated on the
Latin share of the document's letters**: suppressed above 15%. Fixture 1.6%,
W-9 100%, tax form 0%.

Note where the gate lives: `extract-text.ts` computes the ranges
unconditionally and reports letter counts; `detect-field.ts` decides whether to
surface them. **Extraction reports evidence; the layer above draws the
conclusion.** That separation is why the gate could be added later without
touching the detector.

---

## 4. Finding what can be filled in (`extract-geometry.ts`, `detect-field.ts`)

### 4.1 ⚠ Geometry ENRICHES. It never GATES. This is the central bet.

The obvious design — and the one originally planned — is: find the blanks and
checkboxes geometrically, then ask the model about each one. **That design is
wrong, and three documents prove it.**

- **The Hebrew fixture** has nine eligibility clauses and eight checkboxes. The
  printer left one off. A gated design never shows clause nine to the model, so
  it silently drops a real option — and with the right context the model returns
  a correct verdict on exactly that clause.
- **The W-9** draws no rectangles at all. Its field boxes are four unconnected
  line segments meeting at corners. Line 1, "Name of entity/individual", has no
  detectable affordance of any kind — and the model returns "fill in" for it.
- **The tax form** has no drawn checkboxes either; they are `❑` characters in
  the text. Geometry finds zero boxes, and every option still gets a verdict.

And no geometric rule can ever handle a heading that says _"mark the relevant
options below"_, which creates fields that exist only in language.

**So the model sees the whole document text and decides what the fields are.
Geometry answers only "where exactly does a mark go, and how much room is
there."**

The consequence to protect: **if every detector in `extract-geometry.ts`
returned nothing, the copilot would still work.** Every field found, explained
and listed; only placement degrades. That property is why the riskiest,
most-private-API code in the project is safe to have.

**Corollary — absence is never asserted.** A line carries a tag or carries
nothing, and nothing means _unknown_, not "no checkbox here". If geometry broke
wholesale, every line would be untagged and the model would reason from the text
alone. Telling it "no checkbox on this line" when the detector merely failed
would have it confidently instruct the user to write on a line that has a box.
This is rule 2 of the system prompt.

### 4.2 Sizes are derived by repetition, never hardcoded

**A form repeats its furniture; nothing else on the page does.** That single
observation replaces every tuning constant that would otherwise be needed.

- **Checkbox size** = the mode of this document's own histogram of square-ish,
  low-complexity shapes, requiring at least 3 occurrences. On the fixture 8.0pt
  occurs 20 times and the runner-up 5. On the W-9, 8.0pt occurs 8 times. On the
  tax form nothing qualifies — and `null` is the correct answer there.
- **Comb cell width** = runs of ≥3 consecutive _equal_ gaps between thin
  vertical ticks sharing a y-band.
- **Gap threshold** for a write-in = one em of the adjacent text, so it scales
  with type size.
- **Mark offset** = calibrated from the boxes this document actually drew.

Two details that look like fussiness and aren't:

**Squareness and gap tolerance must be proportional, not absolute.** The ID
field's first comb cell is genuinely 0.49pt narrower than its neighbours
(15.31 vs 15.80). A flat 0.4pt tolerance reports 8 cells for a 9-digit ID —
which would produce an 8-digit ID number on someone's tax form.

**Pooling is document-level, not per page.** Page 2 of the fixture has exactly
one checkbox, so in isolation there is no mode to find. Pooled with pages 1 and
3 it classifies correctly. Doc-level pooling plus the ≥3 rule is also what
excludes ~20 tiny vector shapes on that page (the ✎ pen glyphs, 0.57–2.37pt)
which pass a naive squareness test; without it, page 2 reports 21 checkboxes.

**Why this matters beyond correctness:** it is why the W-9 and the tax form both
worked on the first attempt with zero code changes. Every constant that isn't
derived from the document is a per-document tuning knob in disguise.

### 4.3 The calibrated mark offset — the prettiest part of the design

Checkboxes sit a stable distance from the text they label: median 2.75 / 2.44 /
2.75 across the fixture's pages, 5.60 on the W-9.

So: **learn that distance from the boxes that exist, then apply it to a line
where no box was drawn.** The clause with no checkbox printed beside it gets its
mark exactly where a box would have been — because the document told us where
that is.

⚠ It measures to each box's **own label run**, not to the line's edge. This had
to change when checkbox matching became run-keyed (§4.4): `line.minX` is the
leftmost point of the _whole_ line, so on a row carrying five options, boxes two
through five would each report a wildly negative offset and drag the median.
While only one box per line survived, the two measurements were identical — so
this was a silent dependency between two apparently unrelated pieces of code.

⚠ **`markOffset: 3.00pt` means nothing was calibrated** — that value is
`FALLBACK_MARK_OFFSET`. Seen on the tax form (no drawn boxes) and on a scan.

### 4.4 ⚠ A line can carry several fields — the bug with four heads

The fixture's table puts four column labels on **one extracted line**, with a
6-cell comb and a 9-cell comb beneath it. The W-9's line 3a is one line carrying
**five checkboxes**.

**Affordances belong to runs, not lines.** Any map keyed by line id will
silently keep one and drop the rest — and "silently" is the operative word,
because a form with one field per line looks perfectly fine.

This exact bug appeared **four times, in four places**, each time surviving
review:

1. **Combs.** Keying by line dropped the ID number field entirely.
2. **Checkboxes.** `matchCheckboxes` kept one box per line, losing four of five
   options on the W-9. Invisible on the fixture, because no fixture line carries
   two boxes.
3. **The store.** `classifications` was keyed by line id, so three verdicts on
   one row collapsed to one — true for as long as classifications had existed.
4. **React keys.** `key={verdict.id}` collided for three verdicts on one line.

**The rule: when a line can carry several of something, check every map keyed by
line id.** One remains deliberately unfixed — `hasWideGap` emits one write-in
per line however many gaps it finds — because the checkbox fields on that line
already carry the placement, so the extra tag is redundant rather than wrong.

Each field gets a **ref**: `"p1l17f0"`, a line index plus a field index. That
ref is what lets the model say _which_ of five identical checkboxes it means.

### 4.5 Matching shapes to lines

**Checkboxes need a horizontal tiebreak, not just nearest-baseline.** A real
case: the box beside one field is 2.4pt from that line's baseline and 2.3pt from
a sidebar advert's. The advert wins on distance and steals the checkbox. So
among lines within the vertical band, pick the one whose **text edge** is
nearest — the advert's edge is 352pt away.

On an RTL line the relevant edge is the **right** one. Using the wrong edge puts
every mark on the far side of the page, which looks like a coordinate bug and
isn't.

**A box's label is the nearest run on the side the text runs toward** — LTR look
right, RTL look left. Getting this backwards labels every box with its
_neighbour's_ text, which reads perfectly plausibly on a row of similar options.
That is the class of bug this codebase most has to fear: silently wrong, and
convincing.

**A comb's label is NOT the nearest line above it.** One section of the fixture
lays each row out as three lines — labels, signature text, tick marks — so the
nearest line above a comb is the signature text, in a different column,
horizontally disjoint. The rule that works on both layouts: **walk upward and
take the first line containing a run that horizontally overlaps the comb.**
Nearest-above gets page 2 wrong three times out of three.

And `overlappingRun` returns the _run_, not a boolean — because both combs on
the table row match the same line, and only the individual run distinguishes
"birth date" from "ID number".

### 4.6 Three form idioms, and assume a fourth

|             | Hebrew fixture            | W-9                      | Tax form            |
| ----------- | ------------------------- | ------------------------ | ------------------- |
| Checkboxes  | drawn rects (20)          | drawn rects (8)          | `❑` in the text     |
| Field boxes | none                      | four unconnected strokes | table rules         |
| Blanks      | whitespace + 48–105pt gap | region bounded by rules  | literal underscores |
| Detected by | `hasWideGap`, leaders     | `gap`                    | `literal`, `gap`    |

Note the row that matters most: **the same geometry means opposite things on
different documents.** A solid horizontal rule is decoration on one form and the
field boundary on another. Distinguishing table furniture from a field boundary
probably needs the model, not more geometry — which is why the rule-bounded-box
detector was never built.

### 4.7 ⚠ `extract-geometry.ts` reads a private API

`getOperatorList()` is public; the _shape_ of what it returns is not, and it
changed substantially between pdf.js v4 and v6:

- v4 emitted separate `stroke`/`fill` ops. **v6 emits none** — the paint
  operation moved into `constructPath`'s first argument.
- v4 had a `rectangle` opcode carrying `[x,y,w,h]`. v6 emits rectangles as
  moveTo + 3×lineTo + close, in a flat coordinate array.

**Both changes yield zero results rather than an error.** That is why
`extractDocumentGeometry` never throws, and why §4.1's property matters so much:
if a pdf.js upgrade turns every geometry count to zero, the copilot still works
and this one file is the whole cause.

Inside the flat array, path opcodes are **local** (`0`=moveTo, `1`=lineTo,
`2`=curveTo, `4`=close), _not_ the `OPS` constants. An unknown opcode must bail
rather than step by a default stride — otherwise the walk desynchronises and
returns plausible-but-wrong numbers, silently.

---

## 5. Asking the model (`classify.ts`, `provider.ts`, `ask.ts`)

### 5.1 The privacy boundary is one function

`projectLines` in `classify.ts` is the **only** serialisation of document data
in the codebase. `ask.ts` imports it rather than writing its own — one function,
one audit.

It rebuilds each line **field by field** rather than spreading it:

```ts
// NOT { ...line } — a coordinate added to PayloadLine later would upload
// itself, silently and forever.
{ id, page, text, fields: [{ ref, kind, count?, label? }], unreliableText? }
```

**What crosses, and why each one earns it:**

- **Text** — obviously.
- **Cell counts.** They change the answer: "nine cells, one character each"
  produces nine digits; a six-cell date wants DDMMYY where an eight-cell one
  wants DDMMYYYY. The model cannot know this, and the text layer doesn't contain
  it. ✅ Confirmed live: `120385` into six cells, `039274865` into nine.
- **Refs.** A line index and a field index. No coordinate, and nothing derived
  from one — the payload already states a field was detected on that line, and
  the ref only numbers them.

**What never crosses: coordinates.** Not markRect, not cells, not `lineRect`,
not the mark source, not `dir`. All of those live on `FieldGeometry`, which is
client-side by construction.

### 5.2 The prompt — and the most useful thing learned all project

Two problems appeared together and looked like one: **the language rule leaked**
(Hebrew reasons on Hebrew-dense rows, intermittently), and **classification
under-returned** (9 verdicts on a form with ~12 real fields, with an address
line answered and the city/ZIP line beneath it silently omitted).

The obvious theory was token capacity — Hebrew costs roughly 4× per character,
so the budget must be exhausted. **That was wrong**, and the measurement that
killed it was one log line: `stop_reason` was never `max_tokens`, and a failing
run was 2,700 characters against an 8,000-token ceiling. The model was _choosing_
to stop, not running out of room. Two separate problems that happened to
co-occur.

The fix was five changes to the system prompt, and one of them is the finding:

1. **The language rule moved out of the numbered list**, to _after_ the JSON
   schema, under its own `CRITICAL` heading. Same words, different position.
2. `reason` hardcoded to English rather than "the language the person used" —
   removing an inference step the model was getting wrong.
3. Rule 1 given a **numeric floor**: "a page typically has 15–25 lines worth
   answering; if you have written fewer than 10, go back through the lines you
   passed over," plus "never stop early because the answer is getting long."
4. Reasons capped at **25 words**, one sentence — attacks omission from the
   other side, and drifts less than a paragraph does.
5. Never leave the value empty on a `fill`.

**⚠ The lesson: the same requirement, stated as rule 4 of 8, drifted on 2 of 5
rows. Stated after the schema under its own heading, it has held on every run
since. When a prompt rule is being ignored, try MOVING it before rewriting it.**

Corollary, learned the hard way: **one pass proves nothing about a prompt rule.**
English and Hebrew alternated across identical builds.

**Two languages, on purpose.** The _explanation_ is English because the user
needs to understand it. The _value_ is in the form's language and script,
because a name written in English on a Hebrew form gets the submission rejected.
This failure is invisible to an audience who can't read Hebrew, which is exactly
why it needed an explicit rule and repeated verification.

### 5.3 Validation: drop the bad, keep the good

`parseResponse` distinguishes two severities:

- **A hallucinated line id → drop the row.** It has no geometry entry, so a
  marker for it has nowhere to go.
- **An invalid ref → strip the ref, keep the row.** The verdict and its reason
  are the valuable part and are usually right even when the identifier isn't. A
  stripped ref degrades to the behaviour from before refs existed.

⚠ **Refs are validated against that line's own refs, not a global set.**
`p1l7f0` returned against line `p1l3` is a perfectly real ref and a completely
wrong answer — a global check waves it through and the mark lands on another
line.

⚠ **The JSON parse needs its own try/catch**, because `callProvider` has already
returned successfully by then. Without it, a malformed reply becomes an unhandled
rejection and the panel spins forever.

⚠ **Ref emission is high-variance.** Measured across runs on the same build and
document: 19/20, 16/20, 5/21. It swings with the context, not the code — so any
behaviour that depends on refs being present must degrade gracefully.

### 5.4 ⚠ The output ceiling, and why pages are the wrong unit

Hebrew tokenises at roughly one token per character. 124 verdicts with prose
reasons do not fit in 8,000 output tokens, no matter how long you wait — a
180-second run completes generation and is still truncated.

**Current workaround: classify the current page only.** 52 lines fits
comfortably.

**But pages are an accident of the document, not a unit of anything.** A
one-page form of 61 dense Hebrew lines exceeded the ceiling _twice_, in two
different ways: a sparse context truncated mid-JSON at 3,315 characters, and a
full context returned **zero characters** with `stop_reason: max_tokens`. Per-page
chunking has no smaller fallback for a one-page form.

**The real fix, deferred until after the demo:** chunk by _character budget_ —
`JSON.stringify(projectLines(chunk)).length`, capped around 2,500 — fired in
parallel with a concurrency cap, merged into the store as each returns. The store
is already keyed per field, so merging is nearly free, and the panel renders
whatever is in the map, so partial results appear while later chunks run.

**⚠ Embeddings and retrieval do not apply here**, and it's worth being able to
say why. The _input_ already fits — about 7,700 tokens against a 200k window —
so there is nothing to retrieve, and selecting a "relevant" subset would
re-create the gated design §4.1 disproves. The ceiling is on the **output**,
whose length scales with the number of fields on the form. No retrieval scheme
shrinks the thing you're asking the model to produce.

### 5.5 A counterintuitive result: vague context costs MORE

With a vague situation, the model returns `unclear` for most fields and writes a
long descriptive label into each value — "ID number", "family name, first name,
marital status, number of children". With real data it writes the value itself:
`039274865`, `120385`.

**So a specific context is both cheaper in output tokens and more useful.** That
inverts the usual intuition about context length, and it's the sharpest possible
answer to "what makes this better than pasting the PDF into a chat" — the two
context questions aren't a nicety, they're the mechanism.

(Stated honestly: the mechanism is measured; the conclusion that a fuller context
always fits is not — the one direct test failed for a different reason.)

### 5.6 The question box, and why it is independent

`ask.ts` answers free text about the form, with the document already in context.
Markers answer "what goes in this field"; this answers "what does this term
mean" and "I have a loan against the account — does that change which box I
tick". Those questions have no coordinate to attach to, and they are the ones
that actually stop someone filling a form.

⚠ **It reads no `status`, no `error`, no `classifications`.** That independence
is deliberate and has earned its keep three times: it answered correctly about a
line classification had silently omitted, and it works on a document
classification cannot finish at all. **Do not gate it behind a successful
classification.**

Two smaller invariants: the thread never holds a half-turn (the in-flight
question lives in `pendingQuestion`, because `ask.ts` resends the thread as
history and a turn with an empty answer would upload `A:` followed by nothing);
and `ask()` returns a boolean so the panel clears its textarea only on success —
clearing on failure deletes what the user typed at the moment they want to retry.

---

## 6. Putting the answer back on the page

### 6.1 Two coordinate systems, one conversion

**Everything stored is in PDF points**, origin bottom-left, y growing upward.
**Everything rendered is in CSS pixels**, origin top-left, y growing downward.

`viewer/coordinates.ts` is the **only** place the two meet. Every overlay calls
`pdfRectToCss` and does no arithmetic of its own — a caption that did its own
conversion could drift from the box it describes at some zoom levels only, which
is the worst kind of bug to find.

⚠ **And there are two viewports from the same page, one line apart in
`PdfPage.tsx`:** the canvas backing store at `scale × devicePixelRatio` so it's
sharp on retina, and everything in the DOM at plain `scale`. Mixing them gives
every overlay a double offset.

### 6.2 Which rect does a verdict point at?

A verdict names a _line_; a line can have six fields. `resolveRect` decides, and
the third rule is the interesting one:

1. **A ref wins.** It was validated against that line's own refs.
2. Otherwise, the **highest-priority source present**: checkbox → comb → literal
   → leader → gap → calibrated. Measured ink before calculated position.
3. **Unless that is ambiguous** — several rects of the winning source and no ref
   to choose between them. **Then draw nothing.**

Rule 3 is a real answer, not a failure. A mark on the wrong one of five
identical checkboxes is invisible to the user and wrong on their form; an absent
mark is merely unhelpful, and the panel row still carries the advice.

**Only `fill` verdicts draw a marker.** On a bureaucratic form most lines are
skips, and drawing them buries the two or three things the user must actually do
under a page of grey boxes.

### 6.3 The focus band — a gap the design created

Because only `fill` draws, and because rule 3 sometimes draws nothing, there
were lines the copilot had a real answer for that had **no mark on the page at
all**: every skip, every unclear, every ambiguous fill. For those the panel said
"this line" and left the user to find it — which is §1.1's problem surviving in
miniature.

So clicking a panel row now paints an amber wash over that line, read from
`FieldGeometry.lineRect`.

Three details:

- **It exists for every line**, because `detect-field` guarantees a per-line
  calibrated fallback entry for every line — including the clause no detector
  tagged.
- **`lineRect` grows upward from the baseline.** `line.y` is the _baseline_, not
  the top; drawing from y downward puts the highlight under the text.
- **Amber, not green.** Green means "the copilot says act here". Reusing it for
  "you clicked a row" would make a skip look like an action.

### 6.4 Captions, and how direction gets to the marker

A caption is positioned in CSS pixels from the rect's already-converted
position, and three things keep it on the page: it anchors on the side the text
comes from, its max width is clamped to the room actually remaining, and it
flips below the rect when there's no room above.

⚠ **Direction comes from `entry.dir`, copied off the line in `detect-field.ts`
— not derived from the coordinate.** `markRect.x > pageWidth / 2` was the
obvious cheap proxy and it is wrong on exactly the row that matters: the 9-cell
ID comb spans a wide band, so its left-hand cells sit on the other side of the
midpoint from the rest of the same comb, and would anchor the opposite way.

⚠ **The caption must not depend on the model.** The prompt rule "never leave the
value empty on a fill" does not hold consistently — one run returns labels
everywhere, the next returns empty strings, same prompt and context. So the
caption branches on field kind: for a **checkbox** the field's own label wins
(the action is a tick; the content is worthless), for **cells or a write-in** the
model's value wins (`039274865` is the entire point). Each falls back to the
other.

### 6.5 Layer order and pointer events

Bottom to top in `PdfPage`: canvas → text layer → geometry overlay → verdict
markers → **annotation layer, which must stay last**.

The reason is a chain worth following. `AnnotationLayer` is _transparent to the
mouse_ in select mode, so the text layer keeps its native selection. Because it
is transparent, deselect-on-background-click can't be a click handler on the
layer — it has to be a **document-level** listener that identifies background by
exclusion: anything not inside `[data-annotation-id]` or
`[data-editor-chrome]`.

Which means: **every panel, form and input in the app needs
`data-editor-chrome`**, or clicking it — or typing in it — deselects whatever
annotation the user is holding. It reads as a random, intermittent bug. Both
branches of the collapsible context form carry it; so does every early-return
branch of the panel.

And it means the two read-only overlays are `pointerEvents: "none"` throughout,
which is why they need no such attribute. If anything in them ever becomes
clickable, it does.

**One more, non-obvious:** at the layer level everything binds `click`, never
`pointerdown`. Pointerdown fires _before_ an open textarea's blur, so the new
box's `editingId` gets cleared by the old box's blur.

---

## 7. The editor and the export

### 7.1 ⚠ The most dangerous bug in the project

`fontkit` — which pdf-lib delegates glyph layout to — reverses RTL strings
**naively**: the whole string, not the bidi algorithm. Pure Hebrew therefore
comes out right _by accident_. But `רחוב הרצל 45` exports as `54`, and an
account number exports backwards.

This is the worst kind of failure: correct-looking on the common case, silently
wrong on the case that costs money. And the copilot now hands the user
`039274865` to type.

**The fix needs both halves:** `bidi-js`'s `getReorderedString()` to produce
correct logical→visual order, _then_ force fontkit to `"ltr"` so it doesn't
reverse the already-correct output again.

⚠ **The `ltrFontkit` patch looks like cruft and isn't.** The published
`@pdf-lib/fontkit` types declare `layout(str, features?)` while the real
function takes five arguments, so the patch needs two casts. **Keep the DO NOT
REMOVE comment** — it is the only thing standing between that patch and a tidy-up.

**Test it in Adobe Reader, not Chrome.** Chrome is forgiving, and pure Hebrew
proves nothing. Export Hebrew _with digits inside it_ and check they read
left-to-right in order.

### 7.2 pdf-lib anchors every primitive differently

- `drawText` — `y` is the **baseline**. For a multi-line box the first line's
  baseline sits near the top: `rect.y + rect.height - ascent`, then subtract a
  line height per line.
- `drawSvgPath` — anchors **top-left**, and SVG y grows _downward_, so pass
  `rect.y + rect.height` and let pdf-lib handle the flip. Passing `rect.y` draws
  it a full box-height too low.
- `drawImage` — anchors **bottom-left**, the same convention as our stored rect.
  No adjustment.

### 7.3 The text box grows, it never wraps

A browser soft-wrap inserts no `\n`. Export splits on `\n`. So a visually
wrapped box exports as one long line running off the page. Fixed by making the
box grow instead: `white-space: pre` plus `wrap="off"`, both dimensions measured
from content.

**That is why there is no resize handle on the text box** — a manual width would
be overwritten on the next edit and reintroduce the bug.

Three React/DOM traps live in that measurement, all producing the same symptom
(a committed box showing only its first line), each masking the next: measure
both axes before writing either; read from a ref in `handleBlur`, because blur
fires after the layout effect ran with `isEditing` false; and never clear inline
styles when leaving edit mode, because React wrote height and width from the
style prop in the same commit and clearing them afterwards wipes what React
believes it applied.

### 7.4 Ownership, and one race that was avoided rather than solved

`doc.getPage(n)` returns a **cached** proxy — every caller gets the same object.
`PdfPage` calls `page.cleanup()` on it after canvas render resolves, which frees
parsed font data. The text layer streams from the same proxy. Extraction would
have been a third consumer.

**Rather than coordinate three consumers, extraction was moved to the one moment
when nothing else holds a page proxy:** inside `App.openFile`, after `loadPdf()`
resolves and _before_ `setPdf()` — so before `PdfPage` has mounted. It costs no
locks, no shared state, and no new coordination.

That is the general principle: wanting to coordinate render lifecycle through
shared state is a signal something else is wrong. `page.cleanup()` lives in
`PdfPage` only.

Related: the **cancellation pattern** for any long-running pdf.js operation is
(1) `cancel()`, which is a request not an instant stop, (2)
`await …promise.catch(() => {})` to wait for real teardown, (3) null the refs —
plus a `cancelled` boolean flipped in effect cleanup and checked after _every_
`await`. Skipping step 2 gives "Cannot use the same canvas during multiple
render() operations" and duplicate stacked text spans.

---

## 8. Storage, privacy, and two builds

### 8.1 What persists, and what deliberately doesn't

**Exactly one thing persists: `{ provider, apiKey }`.** Everything else — the
two context answers, and the entire question thread — is in memory and gone on
refresh or tab close.

That is not an oversight. The thread is a transcript of someone's questions
about their own severance withdrawal; it is the most sensitive thing the app
touches.

⚠ **The invariant that keeps it true is a function signature.** `persist()`
takes a `StoredCredentials`, not a partial state. Widen it to accept arbitrary
state and the privacy claim breaks with nothing to flag it.

### 8.2 ⚠ The storage claim differs between builds — get this right out loud

- **Extension:** `chrome.storage.local`. Sandboxed by Chrome from other
  extensions and from web pages, not synced.
- **Web:** `localStorage`. Scoped to the origin, and readable by any script
  running on it.
- **Neither is encrypted.**

`STORAGE_DESCRIPTION` in `copilot/storage.ts` picks the right sentence per build
so the UI cannot overclaim. **Rehearse the web version** — that's the link
people click. Claiming Chrome's sandbox guarantee on a website is exactly the
kind of overclaim that unravels in a Q&A.

And: the API key is never logged, anywhere, including error paths. Several
diagnostic logs exist; none touches it.

### 8.3 One source, two builds

```
npm run build       → dist/      Chrome extension (crx plugin + manifest)
npm run build:web   → dist-web/  static site
```

The **only** environment-specific file is `copilot/storage.ts`, which branches
at runtime on `chrome.runtime?.id` and provides the storage functions plus
`assetUrl`. There is no forked code and no second entry point.

⚠ **`assetUrl` is load-bearing for Hebrew.** pdf.js cmaps decode CID fonts, and
a wrong path there doesn't throw — Hebrew simply extracts as garbage or not at
all, indistinguishable from an extraction bug. `editor/export.ts` uses it too,
for the export font. **If the line counts go to zero after a build change, check
the network tab before the code.**

Worth noting what the extension shell actually buys: no content script, nothing
intercepts PDFs on the web, and `host_permissions` exists only to reach three
API endpoints — which the `anthropic-dangerous-direct-browser-access` header
replaces on the web. So the extension buys exactly one thing today:
`chrome.storage.local` instead of `localStorage`.

---

## 9. The decisions worth defending

Six things, in the order they're most likely to be asked about.

### 9.1 Why no backend

Nothing to authenticate to, nothing to breach, nothing to pay for. The document
never leaves the browser; only its extracted _text_ goes anywhere, only to the
provider the user chose, only when they use the copilot, and only with their own
key. §8.

The honest limits stated alongside: the key is unencrypted in browser storage,
and on the web it's origin-scoped rather than sandboxed. §8.2.

### 9.2 Why the model sees all the text, not a list of blanks

**This is the headline.** §4.1. Three documents, three incompatible form idioms,
one architecture, zero code changes between them. The evidence is a transcript:
the model returns a correct verdict on a clause with no checkbox drawn beside
it — the ninth of nine, where the printer left the box off — and it is the only
verdict in that run with no field reference, because it is the only line where
geometry found nothing.

A design that looks for boxes first never asks the question.

### 9.3 How a text answer becomes a coordinate

§2, §4.3, §6.2. The model answers about a line; the geometry map knows where
that line's fields are; `coordinates.ts` converts once. And when a line offers
five identical rects and the model didn't say which, the honest answer is to
draw nothing.

### 9.4 Nothing is hardcoded per document

§4.2. Checkbox size is the mode of _this_ document's histogram. Comb width comes
from repetition. The gap that counts as a blank is one em of adjacent text. The
offset from label to box is calibrated from the boxes this form drew — and then
used to place a mark where a box _wasn't_.

That's why two documents nobody designed for worked on the first attempt.

### 9.5 What it deliberately does NOT do

**No autofill.** The copilot tells you what belongs in each field and marks where
it goes; it does not type into the form. Those are different claims, and the
second isn't needed for the first to be useful. It is also the more honest answer
about what an AI should be trusted to do with someone's tax form.

Two hazards die with that decision, which is a fair way to defend it: the "text
box mounts with content already in it" path (three documented React traps, never
executed), and the mirrored-ID risk — comb cells are indexed left to right
geometrically, so on a Hebrew form a 9-digit ID fills index 8 down to 0, and
filling 0 upward writes the number backwards _and looks entirely plausible on
screen_.

**No OCR.** A scan is editor-only, and the panel says so.

**One page per request.** §5.4 — with the reason, the cost, and the fix.

### 9.6 Two lessons about verification, which are the best stories

**A claim marked ✅ turned out to be false.** A detector was recorded as working
because two observations were consistent with it — dots visible in the extracted
text, and a badge on the row. Neither could _test_ it: the badge came from a
different detector that emits the same tag. What caught it was a tool built to
print numbers rather than assert them — a mark-source histogram — on its first
run.

**And then almost the same mistake again.** A diagnostic logged a header saying
"20 verdicts" followed by an array of 19, because it printed a _filtered_ subset
while reporting an _unfiltered_ count. The missing entry was always the ref-less
one — which on this document is the single most important verdict in the demo. It
read as a targeted silent data loss for three debugging rounds, and two wrong
theories were built on it before the log itself was suspected.

**The rules that came out of it:** a tag with no provenance cannot confirm the
detector that produced it; a diagnostic that prints a filtered view must not
report an unfiltered count; and build the tool that prints numbers _before_ the
feature that needs them.

---

## 10. Where it stops, and why

Every one of these is deliberate, with the reason attached — which is a stronger
position than not knowing.

| Limit                                            | Why it's acceptable                                                                      | The fix, if it mattered                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| One page per classification request              | Hebrew costs ~4× the tokens; the output budget, not the input, is the binding constraint | Chunk by character budget, in parallel, merged into the store (§5.4) |
| Cross-page reasoning lost                        | Follows from the above; the fixture's page 3 depends on a page 1 choice                  | Same fix                                                             |
| Two-column pages interleave in the list          | Placement unaffected; the model classified an interleaved page correctly                 | Column-band clustering, or `getStructTree()` on tagged PDFs          |
| Solid-rule field boxes undetected                | Placement only; the same geometry means opposite things on different forms               | Probably needs the model, not more geometry                          |
| Literal-blank detector matches per run           | The same blanks are found by the gap detector; only the exact rect differs               | Match against the joined line text, map offsets back to runs         |
| A form with fewer than 3 checkboxes gets no size | `null` is the correct answer; marks fall back to calibration                             | Nothing — this is right                                              |
| Scans are editor-only                            | Honest, and stated in the UI                                                             | OCR, explicitly cut                                                  |
| No autofill                                      | §9.5                                                                                     | Not a bug                                                            |

**And one genuine unknown:** the line-splitting guard (§3.2) has never fired on a
real document. If it ever does, text degrades slightly and _placement degrades
badly_. That is the thing most worth finding a document for.
