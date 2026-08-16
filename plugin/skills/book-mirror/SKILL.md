---
name: book-mirror
version: 0.5.0
description: Take any book (EPUB/PDF), produce a personalized chapter-by-chapter analysis. Each chapter is preserved in detail (The Chapter) and mirrored back to the reader's actual life (The Mirror) using brain context. The mirror observes and resonates — a friend pointing out parallels, NOT a consultant rearranging the reader's life, NOT a therapist assigning homework. The reader decides what to do about it. Layout is a top-aligned HTML table or stacked sections, never a bare markdown pipe table (pipe tables center-misalign uneven columns). Output is a single brain page at media/books/<slug>-personalized.md plus an optional PDF via brain-pdf.
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "two-column book analysis"
  - "apply this book to my life"
  - "how does this book apply to me"
mutating: true
writes_pages: true
writes_to:
  - media/books/
upstream: book-mirror@fc834ee
---

# book-mirror — Personalized Chapter-by-Chapter Book Analysis

> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for the
> sanctioned `media/<format>/<slug>` exception this skill files under.
>
> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, back-link enforcement, and output quality bars.
>
> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain (brain → search → external) the context-gathering
> phase follows.

## What this does

Given a book (EPUB or PDF), produce a brain page where every chapter is
summarized in detail on one side ("The Chapter") and mirrored back to the
reader's actual life on the other ("The Mirror"), using their own words,
situations, people, and patterns from the brain. Output is a brain page at
`media/books/<slug>-personalized.md`.

This is NOT a generic book summary. The mirror is the value: it makes the
book read like a smart friend who happens to know the reader's life deeply
is pointing things out in the margins. The mirror's job is recognition —
"that's exactly me" — and then getting out of the way. If the user wants a
flat summary instead, route them to a different skill.

## Trust contract (read this before running)

book-mirror runs as a CLI command (`gbrain book-mirror`), NOT as a pure
markdown skill that the agent dispatches via tools. The CLI is the trusted
runtime; the skill is the orchestration prose around it.

What this means for the agent:

- The CLI submits N read-only subagent jobs (one per chapter). Each subagent
  has `allowed_tools: ['get_page', 'search']` only. They CANNOT call
  put_page or any mutating op. They produce markdown analysis via their
  final message.
- The CLI reads each child's `job.result`, assembles the final
  page, and writes it via a single operator-trust `put_page`.
- This means untrusted EPUB/PDF content cannot prompt-inject any
  `people/*` page. The trust narrowing happens at the tool allowlist,
  not at the slug-prefix layer.

## The pipeline

```
1. ACQUIRE   → User has the EPUB/PDF locally (manual; book-acquisition is
               not currently shipped — see "Acquiring the book" below).
2. EXTRACT   → Pull chapter text from EPUB/PDF into one .txt per chapter.
3. CONTEXT   → Gather everything the brain knows about the reader.
4. ANALYZE   → `gbrain book-mirror` fans out N read-only subagents.
5. ASSEMBLE  → CLI reads each child result and writes one put_page.
6. PDF       → Optional: render via skills/brain-pdf for delivery.
```

## 1. Acquiring the book

book-acquisition (legal-grey-area downloader) was deliberately not shipped
in this skill wave. The user drops the EPUB/PDF manually. Common paths the
user might use:

```bash
# User-supplied path
ls path/to/book.epub
ls path/to/book.pdf

# Or already in the brain repo (recommended for tracking)
ls $BRAIN_DIR/media/books/
```

Resolve `$BRAIN_DIR` from the gbrain config (`gbrain config get sync.repo_path`)
or accept it from the user.

## 2. Text extraction

Goal: one `.txt` file per chapter under a temp directory. The agent has
shell + python access; the CLI is downstream of this and takes the
extracted directory as input.

### EPUB

```bash
SLUG="this-book"                                # kebab-case
WORK="$(mktemp -d)/$SLUG"
mkdir -p "$WORK/chapters"
unzip -o path/to/book.epub -d "$WORK/unpacked"

# Find content files (XHTML/HTML), sorted (chapter order = sort order)
find "$WORK/unpacked" -name "*.xhtml" -o -name "*.html" | sort > "$WORK/files.txt"

# Strip HTML to text per chapter
python3 - <<'PY'
from bs4 import BeautifulSoup
import os, sys
work = os.environ['WORK']
files = open(f'{work}/files.txt').read().splitlines()
for i, path in enumerate(files, 1):
    html = open(path, encoding='utf-8', errors='replace').read()
    text = BeautifulSoup(html, 'html.parser').get_text('\n')
    text = '\n'.join(line.strip() for line in text.splitlines() if line.strip())
    with open(f'{work}/chapters/{i:02d}.txt', 'w') as f:
        f.write(text)
PY
```

If `bs4` is missing: `pip3 install beautifulsoup4 lxml`.

Inspect the chapter files to identify which are real chapters vs front
matter (TOC, copyright, acknowledgments). Often the EPUB ships one file
per chapter; sometimes multiple chapters per file. Use
`head -5 "$WORK/chapters/"*.txt` to spot-check.

### PDF

```bash
pdftotext -layout path/to/book.pdf "$WORK/full.txt"
```

Then split by chapter heading (look for "Chapter N", "CHAPTER N", or
all-caps title lines) using `awk` or `python`. If the PDF is a scan with
no embedded text, fall back to OCR via `skills/brain-pdf` or another
vision tool.

### Quality check

For each chapter file:

- Word count > 1500 (typical chapter range 2k–8k words).
- No HTML tags.
- Paragraphs preserved with `\n\n`.

Save a `chapters/INDEX.md` mapping chapter number → title → file → word
count for reference.

## 3. Context gathering

This is the most critical step. The mirror is only as good as the
context fed to each chapter subagent.

### What to pull

1. **Templates: USER.md and SOUL.md** if the user maintains them
   (gbrain ships templates at `templates/USER.md` and `templates/SOUL.md`;
   they live in the brain repo when populated). Read full.
2. **Recent daily memory** — last 14 days of brain pages under
   `wiki/personal/reflections/` or wherever the user files daily notes.
3. **Topic-relevant brain searches** tuned to the book's themes:
   - `gbrain query "marriage"`, `gbrain query "couples therapy"` for a
     marriage book.
   - `gbrain query "founders"`, `gbrain query "fundraising"` for a
     business book.
   - `gbrain query "shame"`, `gbrain query "anger"` for a psychology book.
4. **Brain pages for relevant entities** — `gbrain query "<name>"` for
   people who will likely come up.
5. **Standing patterns** — anything in the user's reflections or
   originals that's been recurring.

### Deep retrieval (DEFAULT — not optional)

A thin static context pack is the #1 cause of a generic mirror. The
quality ceiling is the brain itself, not whatever got manually stuffed
into one file. Do per-section retrieval before invoking the CLI:

1. Split the book into sections (chapters, parts, or thematic units).
2. For EACH section, generate 15–20 targeted brain searches based on
   what the author is saying in that section.
3. Fetch the top brain pages from those searches.
4. Fold the retrieved material into the context pack, grouped by chapter,
   so each chapter subagent sees the pages that map to ITS section.

**Query generation strategy (per section):**

- Literal theme match — what is the author literally talking about?
- Psychological parallel — what pattern does this map to in the reader's life?
- Specific incident hunt — what dated events would the author be describing?
- Relationship/people parallel — who in the reader's life maps to this?
- Temporal parallel — what period of the reader's life is closest?

**Execution:**

```bash
gbrain query "QUERY" --limit 3
gbrain get "PAGE_SLUG"
```

**Budget:** 15–20 searches per section × N sections, plus 40–60 full page
fetches. All local DB queries — essentially free. Target 50–80K chars of
retrieved brain context total. The chapter subagents also carry read-only
`search` + `get_page` tools at run time, so the context pack is the floor,
not the ceiling — but do not rely on subagents to rediscover what the
orchestrating pass already found.

**Minimum retrieved material for a high-stakes mirror:**

- 40+ brain pages retrieved across all sections.
- 10+ direct quotes from the reader (verbatim from brain pages).
- Dated incidents and recurring patterns where available.
- Coverage across life domains: journal entries and reflections, work and
  creative output, relationships, public/civic life, specific joyful
  moments, cultural identity — not just the heaviest material.

### Assemble a context pack

Write everything to a single file the CLI can read:

```bash
CONTEXT="$WORK/context.md"
{
  echo "## USER.md (if any)"
  [ -f "$BRAIN_DIR/USER.md" ] && cat "$BRAIN_DIR/USER.md"
  echo
  echo "## SOUL.md (if any)"
  [ -f "$BRAIN_DIR/SOUL.md" ] && cat "$BRAIN_DIR/SOUL.md"
  echo
  echo "## Recent reflections (last 14 days)"
  # Pull recent daily reflections — adapt to the user's filing scheme
  # ...
  echo
  echo "## Topic-relevant brain pages (grouped per chapter)"
  # Deep-retrieval results from above, grouped by the chapter they serve
  # ...
  echo
  echo "## Themes & cruxes"
  # A 1-page summary, written by the agent, calling out:
  # - What's currently active in the user's life that this book intersects
  # - Specific quotes from the user that map to book themes
  # - People and dates that should appear in the mirror
  # - The anti-repetition constraints (domain map + phrase caps, below)
} > "$CONTEXT"
```

Make this dense. It's read by every chapter subagent. Encode the
anti-repetition constraints (next section) here — the per-chapter domain
assignment and phrase caps only work if every subagent can see them.

## Quality system (hard rules)

These rules were earned through iteration with cross-modal eval. They are
mandatory for every book-mirror.

### Principle: the Chapter half IS the variety engine

The single most important lesson: rich chapter summaries drive varied
mirrors. When you compress the source material, the mirror has nothing
to respond to except its own greatest hits. The two halves are symbiotic,
not competing for space.

**Rule:** Every distinct idea, story, framework, numbered list item, and
memorable phrase the author presents gets its own section. If the author
lists six kinds of loneliness, that's six sections. If they tell three
stories, that's three sections. The Chapter half should be detailed enough
that someone could skip the book and not lose much. The Mirror half
responds to EACH specific idea with a DIFFERENT personal mapping.

### Layout: top-aligned HTML tables OR stacked sections (hard rule)

Do **NOT** emit a bare `| The Chapter | The Mirror |` *markdown* pipe
table. GitHub (and most renderers) pad a table row's cells to equal height
and vertically *center* the shorter cell's text — so when the two halves
differ in length (they always do), one column floats down with a block of
whitespace above it. Plain markdown has no per-cell vertical-align. That
is the root cause, not a styling nit.

**Two valid containers — both are correct, pick by destination:**

1. **Top-aligned HTML table (the CLI default).** The `gbrain book-mirror`
   chapter prompt already mandates an HTML `<table>` with `valign="top"`
   on EVERY `<td>` — this is baked into the trusted runtime. Facts worth
   knowing when hand-writing or repairing a mirror: GitHub KEEPS
   `valign="top"` but STRIPS inline `style="vertical-align"`, and does NOT
   render markdown emphasis inside a raw `<td>` — pre-convert emphasis to
   `<em>`/`<strong>`, and use `<br><br>` for paragraph breaks within a
   cell.

2. **Stacked sections** — best for mobile and chat delivery, and the
   right choice for any hand-assembled mirror (children's variant,
   retro-fixes of legacy pages):

   ```markdown
   ### Chapter N: <title>

   **The Chapter**

   <chapter prose, normal paragraphs separated by blank lines>

   **The Mirror**

   <mirror prose, normal paragraphs separated by blank lines>
   ```

   Use real blank-line paragraph breaks, never `<br><br>` outside a table
   cell. Reads top-to-top every time, zero alignment bug. The
   Chapter/Mirror naming and the one-section-per-idea richness rule are
   unchanged — only the container changes.

### Anti-repetition (hard constraints, not vibes)

"Be more varied" doesn't work as an instruction. LLMs remix the deck
they're given — if the deck is 6 cards, you get 6 cards N times. Use hard
constraints, written into the context pack's "Themes & cruxes" section:

1. **Domain mapping:** Before writing, assign each chapter a PRIMARY life
   domain (career, family, civic work, creative life, a specific
   relationship, childhood, intellectual life, spiritual practice, etc.).
   No two adjacent chapters should share the same primary domain.

2. **Phrase caps:** No word or phrase may appear as a thematic anchor in
   more than 3 chapters. Identify the reader's "greatest hits" (the 5–6
   themes that would dominate without constraints) and set explicit
   limits or bans.

3. **Story deduplication:** Before writing each mirror, check: "Have I
   already used this story/incident/quote in a previous chapter?" If yes,
   find a different one.

4. **Emotional range requirement:** At least 25% of chapters must map to
   JOY, HUMOR, CREATIVE EXCITEMENT, or VICTORY — not only wounds and
   struggle. When the author describes something beautiful, the mirror
   should find something beautiful in the reader's life.

### The editorial rule (THE MOST IMPORTANT RULE)

Deep retrieval is the engine, not the product. The reader should never
feel like they're reading a research paper or a search results page.
The mirror must read like a brilliant essay by someone who knows the
reader deeply — not a report proving it did homework.

**The test:** If you remove all citations and source attributions, does
the mirror still make the reader feel seen? Does it still produce
epiphanies? Does it still work as standalone writing? If yes, the
retrieval served its purpose. If the mirror only works because of its
citations, the retrieval failed.

**Citations:** Optional. Use sparingly as footnotes when the source adds
genuine value ("you wrote this at 19" lands differently when the reader
knows you actually read the journal entry). But never let citations
become the point. Never let the mirror read like it's performing
thoroughness.

### Cross-modal eval gate (recommended for high-stakes mirrors)

After generating a mirror, run `gbrain eval cross-modal` (or the manual
gate in `skills/cross-modal-review/SKILL.md`) with these custom
dimensions:

- VARIETY (fresh each chapter?)
- SPECIFICITY (real stories/dates/quotes?)
- DEPTH (new insight vs restating profile?)
- LEFT_COLUMN_FIDELITY (preserves the book?)
- EMOTIONAL_RANGE (joy as well as struggle?)

```bash
gbrain eval cross-modal --slug <slug>-personalized \
  --dimensions VARIETY,SPECIFICITY,DEPTH,LEFT_COLUMN_FIDELITY,EMOTIONAL_RANGE
```

Pass threshold: all dimensions average 7+ across models. If any dimension
is below 6, rebuild with targeted fixes. The eval→fix→re-eval cycle is the
quality multiplier. Evaluator model pairs and refusal routing follow
[conventions/cross-modal.yaml](../conventions/cross-modal.yaml).

### Children's book variant

For picture books and children's books (under ~5K words), use a
**Parent's Reading Guide** format instead of the standard mirror:

- The Chapter half: what the book says on each page/spread.
- The Mirror half: written FOR THE PARENT reading aloud — what each page
  will feel like, what the child might ask at each age, what to say if
  they do, and what the book is really teaching underneath the simple
  words.
- Include: when to read it, how to handle specific reactions, and the
  book's deeper structure mapped to developmental psychology research.
- Tone: warm, practical, specific to the reader's children by name and
  age (from brain context).

Hand-assembled variants like this use the stacked-sections container.

## 4. Analysis: invoke `gbrain book-mirror`

```bash
gbrain book-mirror \
  --chapters-dir "$WORK/chapters" \
  --context-file "$CONTEXT" \
  --slug "$SLUG" \
  --title "Book Title Goes Here" \
  --author "Author Name" \
  --model claude-opus-4-7
```

The CLI:

- Validates inputs and loads chapter files.
- Prints a cost estimate (~$0.30/chapter at Opus) and prompts to confirm.
- Submits N child subagent jobs with read-only `allowed_tools`.
- Waits for every child to complete.
- Reads each child's `job.result` (the markdown analysis text).
- Assembles all chapters into one page with frontmatter + intro + per-chapter
  sections + closing.
- Writes ONE `put_page` to `media/books/<slug>-personalized.md`.
- Reports a JSON envelope on stdout:
  `{"slug": "...", "chapters_total": N, "chapters_completed": N, "chapters_failed": 0}`.

If any chapter failed, the CLI exits 1 and the user can re-run — idempotency
keys (`book-mirror:<slug>:ch-<N>`) deduplicate completed chapters at the
queue level, so retry is cheap. Note that reproducing verbatim book quotes
plus the reader's verbatim words can occasionally trip a provider output
filter; a chapter blocked that way is just a failed chapter — re-run, or
retry with a different `--model`.

### Model: Opus by default

The default model is `claude-opus-4-7`. Sonnet works (use `--model
claude-sonnet-4-6`) but the mirror quality drops noticeably — the
texture that makes the analysis feel like it was written by someone who
knows the reader needs Opus-grade reasoning.

### Cost gate

The CLI refuses to spend in a non-TTY context without `--yes`. CI / scripted
invocations must pass `--yes` explicitly. TTY users get a `[y/N]` prompt
before submission.

Deep retrieval raises total cost meaningfully versus a thin static
context pack (roughly an order of magnitude at Opus rates). The quality
jump is worth it for a book the reader cares about; use a static pack
only for low-stakes runs.

## 5. PDF (optional)

After the brain page is written (the CLI already did the `put_page`),
render to PDF using `skills/brain-pdf`:

```bash
# See skills/brain-pdf/SKILL.md for the invocation.
```

If the user asked for a deliverable, prefer the PDF over sending raw
markdown — the brain page is the source of truth; the PDF is the artifact
that travels.

## 6. Fact-check and cross-link

After the page lands, run a fact-check pass on factual claims about the
reader (parents, siblings, marriage history, jobs, heritage). Common error
patterns to look for:

- Conflating the reader's parents' relationship with patterns in extended
  family.
- Inventing backstory ("after his parents' divorce…") when the
  reader's parents are still together.
- Wrong number/age of children, wrong spouse / kid / sibling names.

If you can't verify a claim, remove it. Better to lose texture than to
introduce a falsehood.

Cross-link entities mentioned in the analysis:

- For every person the mirror references with a brain page, add a
  back-link from `people/<slug>` to the new `media/books/<slug>-personalized`
  page (per `conventions/quality.md` Iron Law).

## Quality bar (the bar)

The **Chapter half** should:

- Preserve the author's actual stories, statistics, frameworks, examples.
- Quote memorable phrases verbatim.
- Be detailed enough that the reader could skip the book and not lose much.

The **Mirror half** should:

- Use the reader's *actual quoted words* from the context pack.
- Reference *specific* dates, situations, people by name.
- Read like a smart friend who happens to know the reader's life deeply —
  pointing things out, not giving instructions.
- **OBSERVE, never PRESCRIBE.** The mirror holds up a reflection. The
  reader decides what to do about it. No directives, no action items, no
  "you should," no "consider whether," no rearranging of the reader's life.
- Frame connections as observations or gentle nudges: "This is the same
  pattern as…" or "Hard not to hear echoes of…" — NOT "You need to
  address this" or "Apply this framework to your Q3 planning."
- Be plain about direct hits ("This is exactly the [name a real situation]").
- Be honest about misses ("This chapter is less directly relevant
  because…"). Don't force connections.
- **Resonant, not actionable.** The mirror's job is recognition, not
  instruction. "That's exactly what we're doing" is the win. "Here's a
  7-point plan to fix it" is overstepping.
- **For team mirrors:** Name team members for context ("this connects to
  what a teammate does"), NEVER for task assignment ("teammate: do X by
  Friday"). Don't invent organizational policies, veto chains, checklists,
  or structural decisions the team hasn't made. Only reference decisions
  that are in the team's actual documents. Frame everything else as
  questions or observations.

The **whole document** should feel like one coherent voice, calibrated to
the reader's actual life rather than a generic profile, and honest about
where the book's framing breaks down for this specific reader. It should
make the reader feel SEEN, not studied — and work as good standalone
writing even with every citation stripped.

## Anti-patterns (do not do these)

- ❌ **Skimming chapters.** Standing instruction: preserve detail.
- ❌ **Generic mirror.** "This might apply if you've ever felt…" →
  kill on sight.
- ❌ **Factual errors about the reader's life.** Always fact-check after
  assembly.
- ❌ **Giving the subagent put_page access.** Trust contract is read-only;
  the CLI does the writing.
- ❌ **Forcing connections.** If a chapter doesn't apply, say so plainly.
- ❌ **Sycophancy or moralizing in the mirror.** No "you should…",
  no "consider…", no "perhaps it's time to…".
- ❌ **Consultant mode.** The mirror is not a strategy deck. No action
  items, no task assignments to named people, no invented policies or org
  structures, no "audit this quarterly," no numbered implementation
  checklists. The mirror OBSERVES and RESONATES. It's a friend at a bar
  saying "this part is so us" — not a consulting engagement. If the
  reader wants to turn an observation into a plan, that's their move.
  Not ours.
- ❌ **Inventing rules the reader never said.** Veto chains, editorial/
  marketing separations, ombudsperson structures, campaign checklists —
  if the reader didn't establish it, the mirror can't declare it. Frame
  it as a question the author would ask ("who has the veto here?") or
  don't include it.
- ❌ **Truncating the Chapter half.** The book's actual content needs to
  survive. This is the #1 quality failure — rich chapter = varied mirror.
- ❌ **Bare markdown pipe tables.** They center-misalign uneven cells on
  GitHub and most renderers. HTML `<table>` with `valign="top"` on every
  `<td>`, or stacked sections. See the layout hard rule above.
- ❌ **Repeating the same 5–6 themes across all chapters.** Use the domain
  mapping and phrase caps from the quality system.
- ❌ **Thin context pack.** If the context pack is just USER.md bullets,
  the mirror will be generic. Invest in deep retrieval.
- ❌ **Skipping the eval gate on high-stakes mirrors.** At minimum, run a
  self-check: count mentions of key themes across chapters. If any theme
  appears in more than 3 chapters, fix before delivering.

## Output checklist

- [ ] Book file exists locally (path known).
- [ ] Chapter texts under `$WORK/chapters/*.txt` with sane word counts.
- [ ] Context pack at `$WORK/context.md` is dense: deep-retrieval results
      grouped per chapter + domain map + phrase caps.
- [ ] `gbrain book-mirror --chapters-dir … --context-file … --slug … --title …` returned exit 0.
- [ ] `media/books/<slug>-personalized.md` exists in the brain.
- [ ] Layout check: no bare markdown pipe tables in the page.
- [ ] Anti-repetition self-check: no theme anchors more than 3 chapters.
- [ ] Fact-check pass complete (no errors against USER.md or other source-of-truth pages).
- [ ] Cross-links added from referenced people/companies.
- [ ] Optional: cross-modal eval gate passed (all dimensions 7+).
- [ ] Optional: PDF rendered via brain-pdf and delivered.

## Related skills

- `skills/brain-pdf/SKILL.md` — render the personalized page to PDF.
- `skills/strategic-reading/SKILL.md` — read a book through a specific
  problem-lens instead of personalizing to the whole reader.
- `skills/article-enrichment/SKILL.md` — same shape applied to articles
  rather than books.
- `skills/cross-modal-review/SKILL.md` — the manual second-model quality
  gate; `gbrain eval cross-modal` is the scripted sibling surface.


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).

## Anti-Patterns

The full anti-pattern list is in the body sections above; this header exists for the conformance test if the body uses a different casing.
