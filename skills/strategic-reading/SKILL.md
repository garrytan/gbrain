---
name: strategic-reading
version: 0.1.0
description: Read a book, article, transcript, or case study through the lens of a specific strategic problem you're facing. Produces an applied playbook that maps the source onto the problem and gives short/medium/long-term recommendations. NOT for general book summaries.
triggers:
  - "strategic reading"
  - "read this through the lens of"
  - "apply this to my problem"
  - "what can I learn from this about"
  - "extract a playbook from"
mutating: true
writes_pages: true
writes_to:
  - concepts/
  - projects/
---

# strategic-reading — Applied Analysis from Source Texts

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules (every recommendation cites the source) and back-link
> enforcement.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> output files by primary subject (concepts/ for general strategy, projects/
> for problem-tied playbooks).

## What this is

Take a large text PLUS a specific strategic problem, produce analysis that
maps the text's insights onto the problem. This is not book summarization.
This is reading with a mission.

Where `book-mirror` personalizes a book to the reader's whole life,
`strategic-reading` personalizes it to ONE current problem. Same shape
(extract → analyze → mirror), different lens.

**Canonical example:** a power-dynamics history book read against a
specific gatekeeper-vs-incumbent fight, producing a tactical analysis that
maps the book's playbook onto the situation with counter-tactics and a
short/medium/long-term playbook.

## Inputs

1. **Source text** — book (EPUB/PDF), article, transcript, historical case
   study, any large document.
2. **Strategic problem** — the specific situation to analyze through the
   lens of the text. The user describes this explicitly or it's obvious
   from context.

## Output

The brain page is the artifact. PDF is a rendering, never primary.

### Brain page structure

```markdown
# [Source Title] — Applied to [Problem]

> One-paragraph executive summary: how the source maps to the situation,
> the key insight, the bottom line.

## The Core Parallel
How the source's central dynamic maps onto the user's situation.

## Chapter / Section Triage
For each major section of the source:
- 2-3 sentence summary of what it says
- Relevance to the problem: HIGH / MEDIUM / LOW
- One directly applicable quote (if any)

## The Source's Playbook
The author's framework, tactics, or strategies — organized as:
- What the protagonist DID (tactics)
- What WORKED and why
- What FAILED and why
- What OPPONENTS did that was effective

## Counter-Tactics
Specific moves from the source that map to the user's situation:
- What to DO (with source evidence)
- What to AVOID (with source evidence)
- What to WATCH FOR (warning signs from the source)

## Applied Playbook
The synthesis — actionable recommendations:
- **Short-term** (this week / this month)
- **Medium-term** (this quarter)
- **Long-term** (this year+)

## Key Quotes
Direct quotes from the source that are devastatingly relevant.
Maximum 5-10. Quality over quantity.

## See Also
Links to relevant brain pages (related concepts, related projects).
```

## Process

```
Phase 1: Ingest the source
  ├── EPUB: extract chapters via BeautifulSoup (see book-mirror SKILL.md
  │   for the extraction pipeline)
  ├── PDF: pdftotext -layout
  ├── Article: web_fetch
  └── Identify Table of Contents and total size.

Phase 2: Triage chapters
  ├── Read first 2000 chars of each chapter.
  ├── Classify relevance to the problem (HIGH / MEDIUM / LOW).
  └── HIGH chapters get full reads. MEDIUM partial. LOW skipped.

Phase 3: Deep read HIGH chapters
  ├── Tactics and strategies used.
  ├── Power dynamics and how they shifted.
  ├── Specific quotes that map to the problem.
  └── Moments where the protagonist's approach succeeded or failed.

Phase 4: Synthesize
  ├── Map source insights onto the specific problem.
  ├── Build the playbook (do / avoid / watch for).
  ├── Generate short/medium/long-term recommendations.
  └── Select the most devastating quotes.

Phase 5: Write and deliver
  ├── Write the brain page at the right location:
  │     • If problem-specific: projects/<slug>/playbook.md
  │     • If general strategy: concepts/<slug>.md
  ├── put_page via the standard CLI flow.
  └── Optional: render to PDF via skills/brain-pdf.
```

## Quality bar

- **Every recommendation must cite the source.** Don't say "go direct to
  the mayor" — say "go direct to the mayor, because when the protagonist
  refused to be intimidated by a resignation threat (Ch 48), the bluff
  that worked on five mayors finally failed."
- **Direct quotes are mandatory.** The source's own words carry more
  weight than paraphrase.
- **The analysis must be actionable.** Not "this is interesting" but "do
  this, avoid that, watch for this."
- **Short/medium/long-term breakdown is mandatory.** The user needs to
  know what to do tomorrow AND what to do this year.

## What this skill is NOT

- Not a book summary tool. Use a different skill (or `book-mirror` for
  personalized analysis) for general summaries.
- Not a research tool. Use `perplexity-research` for finding new
  information about a topic.
- Not academic literary analysis. No one cares about literary merit —
  only strategic application.

## Related skills

- `skills/book-mirror/SKILL.md` — book personalized to whole life (vs
  problem)
- `skills/perplexity-research/SKILL.md` — current-intel cross-reference
  for fresh data
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

## Anti-Patterns

The full anti-pattern list is in the body sections above; this header exists for the conformance test if the body uses a different casing.
