---
name: book-mirror
version: 0.1.0
description: Take any book (EPUB/PDF), produce a personalized chapter-by-chapter analysis with two-column tables. Left column preserves the chapter content; right column maps every idea to the reader's actual life using brain context. Output is a single brain page at media/books/<slug>-personalized.md plus an optional PDF via brain-pdf.
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
summarized in detail on the left and mirrored back to the reader's actual life
on the right, using their own words, situations, people, and patterns from
the brain. Output is a brain page at `media/books/<slug>-personalized.md`.

This is NOT a generic book summary. The right column is the value: it makes
the book read like a therapist who knows the reader is leaving notes in the
margins. If the user wants a flat summary instead, route them to a different
skill.

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
  two-column page, and writes it via a single operator-trust `put_page`.
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

This is the most critical step. The right column is only as good as the
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
  echo "## Topic-relevant brain pages"
  # gbrain query the book's key themes, embed top results
  # ...
  echo
  echo "## Themes & cruxes"
  # A 1-page summary, written by the agent, calling out:
  # - What's currently active in the user's life that this book intersects
  # - Specific quotes from the user that map to book themes
  # - People and dates that should appear in the right column
} > "$CONTEXT"
```

Make this dense. It's read by every chapter subagent.

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
queue level, so retry is cheap.

### Model: Opus by default

The default model is `claude-opus-4-7`. Sonnet works (use `--model
claude-sonnet-4-6`) but the right-column quality drops noticeably — the
texture that makes the analysis read like a therapist who knows the user
needs Opus-grade reasoning.

### Cost gate

The CLI refuses to spend in a non-TTY context without `--yes`. CI / scripted
invocations must pass `--yes` explicitly. TTY users get a `[y/N]` prompt
before submission.

## 5. PDF (optional)

After the brain page is written, render to PDF using `skills/brain-pdf`:

```bash
gbrain put_page  # already done by the CLI; nothing to add here
# Then invoke brain-pdf:
# (see skills/brain-pdf/SKILL.md for the make-pdf invocation)
```

## 6. Fact-check and cross-link

After the page lands, run a fact-check pass on factual claims about the
reader (parents, siblings, marriage history, jobs, heritage). Common error
patterns to look for:

- Conflating the reader's parents' relationship with patterns in extended
  family.
- Inventing therapy backstory ("after his parents' divorce…") when the
  reader's parents are still together.
- Wrong number/age of children, wrong spouse / kid / sibling names.

If you can't verify a claim, remove it. Better to lose texture than to
introduce a falsehood.

Cross-link entities mentioned in the analysis:

- For every person the right column references with a brain page, add a
  back-link from `people/<slug>` to the new `media/books/<slug>-personalized`
  page (per `conventions/quality.md` Iron Law).

## Quality bar (the bar)

The **left column** should:

- Preserve the author's actual stories, statistics, frameworks, examples.
- Quote memorable phrases verbatim.
- Be detailed enough that the reader could skip the book and not lose much.

The **right column** should:

- Use the reader's *actual quoted words* from the context pack.
- Reference *specific* dates, situations, people by name.
- Read like a therapist who knows the reader is leaving notes in the margins.
- Be plain about direct hits ("This is exactly the [name a real situation]").
- Be honest about misses ("This chapter is less directly relevant
  because…"). Don't force connections.

The **whole document** should feel like one coherent voice, calibrated to
the reader's actual life rather than a generic profile, and honest about
where the book's framing breaks down for this specific reader.

## Anti-patterns (do not do these)

- ❌ **Skimming chapters.** Standing instruction: preserve detail.
- ❌ **Generic right column.** "This might apply if you've ever felt…" →
  kill on sight.
- ❌ **Factual errors about the reader's life.** Always fact-check after
  assembly.
- ❌ **Giving the subagent put_page access.** Trust contract is read-only;
  the CLI does the writing.
- ❌ **Forcing connections.** If a chapter doesn't apply, say so plainly.
- ❌ **Sycophancy or moralizing in the right column.** No "you should…",
  no "consider…", no "perhaps it's time to…".
- ❌ **Truncating the LEFT column.** The book's actual content needs to
  survive.

## Output checklist

- [ ] Book file exists locally (path known).
- [ ] Chapter texts under `$WORK/chapters/*.txt` with sane word counts.
- [ ] Context pack at `$WORK/context.md` is dense.
- [ ] `gbrain book-mirror --chapters-dir … --context-file … --slug … --title …` returned exit 0.
- [ ] `media/books/<slug>-personalized.md` exists in the brain.
- [ ] Fact-check pass complete (no errors against USER.md or other source-of-truth pages).
- [ ] Cross-links added from referenced people/companies.
- [ ] Optional: PDF rendered via brain-pdf and delivered.

## Related skills

- `skills/brain-pdf/SKILL.md` — render the personalized page to PDF.
- `skills/strategic-reading/SKILL.md` — read a book through a specific
  problem-lens instead of personalizing to the whole reader.
- `skills/article-enrichment/SKILL.md` — same shape applied to articles
  rather than books.


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
