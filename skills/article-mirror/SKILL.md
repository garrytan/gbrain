---
name: article-mirror
version: 0.1.0
description: Take one pre-extracted article text file, personalize it against reader context, and write a two-column mirror page under media/articles/<slug>-personalized.md. Left column preserves the article. Right column maps it to the reader's actual life.
triggers:
  - "mirror this article"
  - "personalized version of this article"
  - "two-column article mirror"
  - "apply this article to my life"
  - "how does this article apply to me"
sources:
  - src/commands/article-mirror.ts
mutating: true
writes_pages: true
writes_to:
  - media/articles/
---

# article-mirror — Personalized Article Mirror

> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for
> the sanctioned `media/articles/<slug>-personalized.md` exception this skill
> writes under.
>
> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, back-link expectations, and output quality bars.
>
> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain the context-gathering phase follows.

## What this does

Given one pre-extracted article text file, produce a personalized mirror page
where the left column preserves the article's real arguments, examples, and
texture, and the right column maps each idea back to the reader's real life
using brain context.

Output is a single brain page at `media/articles/<slug>-personalized.md`.

This is NOT article enrichment. `article-enrichment` rewrites an existing raw
brain page into a structured research artifact. `article-mirror` personalizes a
single source against the reader's actual life, more like `book-mirror` but for
one article.

## Trust contract

article-mirror runs as a CLI command (`gbrain article-mirror`), not as a pure
markdown skill that an agent dispatches via write-capable tools.

What this means:

- The CLI submits exactly 1 read-only subagent job.
- That child has `allowed_tools: ['get_page', 'search']` only.
- The child cannot call `put_page` or any mutating operation.
- The child returns markdown analysis in its final message.
- The CLI assembles the final page and writes the only artifact via one
  operator-trust `put_page`.

This keeps untrusted article text outside the write path.

## The pipeline

```
1. ACQUIRE   → The article text already exists locally as one .txt file.
2. CONTEXT   → Gather reader context into one context pack (optional but strongly recommended).
3. ANALYZE   → `gbrain article-mirror` submits exactly one read-only subagent.
4. ASSEMBLE  → CLI reads the child result and writes one put_page.
5. PDF       → Optional: render the finished page via brain-pdf.
```

## 1. Prepare inputs

You need:

- one article text file
- a slug for the output page
- optional context pack
- optional metadata: title, author, canonical URL

The article text file should already be extracted and reasonably clean:

- plain UTF-8 text
- no HTML tags
- no empty file

## 2. Build a context pack

Same principle as `book-mirror`, just smaller in scope. Pull the reader
context that actually matters for this article:

- `USER.md` and `SOUL.md` if they exist
- recent reflections relevant to the article's subject
- a few targeted brain queries for the themes that matter here
- names, projects, tensions, and quotes that should show up in the right column

Write that into one file, for example:

```bash
CONTEXT=/tmp/article-context.md
```

## 3. Invoke the CLI

```bash
gbrain article-mirror \
  --article-file /tmp/articles/this-piece.txt \
  --context-file "$CONTEXT" \
  --slug this-piece \
  --title "This Piece" \
  --author "Some Author" \
  --url https://example.com/this-piece
```

The CLI:

- validates the input file
- prints a cost estimate and asks for confirmation unless `--yes`
- submits exactly one read-only child job
- waits for the child result
- writes one page to `media/articles/<slug>-personalized.md`

## Output shape

The final page includes:

- frontmatter with title, date, context, and optional author/URL
- a short explanation of the trust boundary
- a two-column mirror:
  - left = what the article actually says
  - right = how it applies to the reader
- a short "questions worth keeping" section

## Quality bar

- The left column preserves specifics from the article instead of flattening it.
- The right column is grounded in real brain context, not generic life advice.
- The page is written under `media/articles/<slug>-personalized.md`.
- The child never gets write tools.
- The CLI is the only writer.

## Related skills

- `skills/book-mirror/SKILL.md` — same personalized mirror shape for books
- `skills/article-enrichment/SKILL.md` — restructure raw article brain pages; not personalized mirror output
- `skills/strategic-reading/SKILL.md` — apply a source to one specific problem instead of to the reader's life broadly
- `skills/brain-pdf/SKILL.md` — render the finished page as PDF

## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above. The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
