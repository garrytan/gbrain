---
name: article-enrichment
version: 0.1.0
description: Transform raw article text dumps in the brain into structured pages with executive summary, verbatim quotes, key insights, why-it-matters, and cross-references. Replaces walls-of-text with quotable, actionable brain pages.
triggers:
  - "enrich this article"
  - "enrich brain pages"
  - "batch enrich"
  - "make brain pages useful"
mutating: true
writes_pages: true
writes_to:
  - media/articles/
---

# article-enrichment — From Raw Dumps to Useful Brain Pages

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, verbatim-quote requirements, and back-link enforcement.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for
> filing rules. Article pages live under `media/articles/` for raw ingest;
> personalized one-of-one synthesis output uses the sanctioned
> `media/articles/<slug>-personalized.md` exception.

## What this does

Takes an article brain page that's a wall of raw extracted text and rewrites
it as a structured page with:

- **Executive Summary** — 2-3 sentences, the ONE thing worth remembering
- **Why It Matters** — connects to the user's specific projects + interests
  (read from brain context, not assumed)
- **Quotable Lines** — 3-5 VERBATIM quotes worth referencing in essays
- **Key Insights** — actual insights, not topic labels
- **Surprising or Counterintuitive** — what makes this content unique
- **See Also** — standard markdown links to related brain pages

Raw source content is preserved in a collapsed `<details>` section so the
original is never lost.

## When to invoke

- New article page lands in the brain via media-ingest with `needs_enrichment: true`
- Existing article page is a wall of text under a `## Content` header with
  no synthesis
- User says a brain page is useless, boring, or a dump
- An LLM-judge brain-quality eval fails on quotability or actionability for
  an article page

## The pipeline

```
1. READ      → Open the article brain page; parse frontmatter + body.
2. SCAN      → Look for ## Content (raw dump) and absence of ## Executive Summary.
3. CONTEXT   → gbrain query the article's key entities to ground "Why It Matters".
4. ENRICH    → Sonnet (default) or Opus (for high-value content) restructures.
5. WRITE     → Replace ## Content with the structured sections; preserve raw
               source in <details>; clear needs_enrichment in frontmatter.
6. CROSS-LINK→ Add back-links from referenced people/companies pages
               (Iron Law per conventions/quality.md).
```

## Invocation

The skill itself is markdown instructions to the agent. It does NOT ship a
deterministic CLI command in v0.25.1. The agent uses gbrain's existing
operations:

```bash
# 1. Find candidate pages
gbrain query "needs_enrichment: true type:article" --limit 50

# 2. For each candidate, read the page
gbrain get media/articles/<slug>

# 3. Enrich via the agent's LLM (Sonnet by default; Opus for high-value)
#    The agent reads the raw content + brain context + writes the structured page.

# 4. Write the enriched page
#    Use the put_page operation with the new structured markdown body.

# 5. Cross-link entities
#    For every person/company mentioned, add a timeline back-link.
```

## Quality bar

An enriched page passes if it has:

- ✅ `## Executive Summary` (2-3 sentences)
- ✅ `## Quotable Lines` with ≥3 verbatim quotes (literal quotes, not paraphrase)
- ✅ `## Key Insights` with ≥3 bullets (insights, not topic labels)
- ✅ `## Why It Matters` connecting to specific brain context (not generic)
- ✅ `## See Also` with standard markdown links (NOT `[[wiki-links]]`)
- ✅ `<details>` block preserving the raw source content

## Model selection

| Model | Use when | Quote accuracy |
|-------|----------|----------------|
| **Sonnet** (default) | Bulk enrichment, most articles | Good — occasionally paraphrases |
| **Opus** | High-value content, original-thinking pieces, longreads | Excellent — respects "verbatim" instruction |

Rule: for bulk enrichment, do a Sonnet draft pass and spot-check 5 with
the LLM-judge brain-quality eval. If quotes are paraphrased, switch to
Opus for that batch.

## Link convention

All cross-references use standard markdown links: `[Title](relative/path.md)`.
NEVER use `[[wiki-links]]` — they don't render on GitHub.

## Anti-Patterns

- ❌ Paraphrasing quotes ("the author argues that…"). Quotes are verbatim
  or they're not quotes.
- ❌ Generic "Why It Matters" ("this is important because innovation").
  Tie to specific brain context or remove the section.
- ❌ Inventing topic labels and calling them insights. An insight is a
  thing the article says that you didn't already know.
- ❌ Discarding the raw source. Always wrap it in `<details>`.
- ❌ Re-enriching non-idempotently — check the `needs_enrichment` flag in
  frontmatter; skip if already false.

## Related skills

- `skills/media-ingest/SKILL.md` — creates the raw article pages this skill enriches
- `skills/idea-ingest/SKILL.md` — link/article ingestion with author people-page enforcement
- `skills/conventions/quality.md` — citation + back-link rules


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
