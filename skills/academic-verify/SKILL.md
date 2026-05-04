---
name: academic-verify
version: 0.1.0
description: Verify a research claim or academic citation by tracing it through publication → methodology → raw data → independent replication. Routes through perplexity-research for the actual web lookup, then formats results as a citation-checked brain page. Use when a book/article/conversation cites a study and you want to confirm the claim is real, replicated, and accurately characterized.
triggers:
  - "verify this academic claim"
  - "check this study"
  - "academic verify"
  - "validate citation"
  - "is this study real"
mutating: true
writes_pages: true
writes_to:
  - concepts/
---

# academic-verify — Trace Claims to Source Data

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules; every verdict cites the source data, not just the
> author's claim about the source data.
>
> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain. This skill enforces brain-first by checking
> existing brain pages before issuing a fresh web search.

## What this is

A claim-verification flow for academic / research statements. When a
book, article, or speaker cites a study or quotes a number, this skill
traces the claim through:

```
claim → publication → methodology section → raw data source → independent verification
```

At each step, it answers:

- **Where does this number come from?** (Self-generated? Survey? Government data?)
- **What's the baseline?** (Reduction from what? Over what time period?)
- **Is the raw data available?** (Public? Proprietary? "Available on request"?)
- **Has anyone independently verified it?** (Replication study? Government audit?)
- **Are there confounding factors?** (Other interventions, policy changes, COVID, sampling bias?)
- **Is the comparison fair?** (Cherry-picked comparison group? Survivorship bias?)

The output is a brain page under `concepts/<claim-slug>.md` that records
the claim, the trace, and the verdict — so future references to the
same claim can re-use the verified analysis.

## When to use this

- A book quotes a study and you want to confirm it's real and not
  miscited
- An article makes a quantified claim ("X reduced Y by 40%") that you
  want traced to the source data
- You're writing something that depends on a piece of research and you
  want to verify the underlying paper holds up
- You're updating a brain page that cites a research claim and you want
  to record the verification status alongside

## What this skill is NOT

- Not adversarial / oppo work. The point is rigor, not takedown.
- Not generic web research — use `perplexity-research` directly for
  open-ended topic exploration.
- Not a brain-only lookup — that's `gbrain query`.

## How it works (D7/α: pure routing through perplexity-research)

academic-verify is a thin orchestrator. The actual web search is done
by [perplexity-research](../perplexity-research/SKILL.md). academic-verify's
job is the *workflow*: scoping the claim precisely, sending it through
perplexity-research with citation-mode, then formatting the response
into a verdict-shaped brain page.

```
Step 1: Scope the claim
  Pin down EXACTLY what's being claimed:
    • Quote: who said what?
    • Source: which paper / dataset / survey?
    • Number: what specific quantity is claimed?
    • Period: over what time range?

Step 2: Brain-first lookup
  gbrain query "<paper title> OR <author name> OR <claim keywords>"
  If the brain has prior verification of this claim, reuse it.

Step 3: Invoke perplexity-research with citation-mode prompt
  Send the claim + brain context to perplexity-research with a prompt
  that explicitly asks for:
    • Original publication (title, authors, journal, year, DOI)
    • Methodology section summary
    • Raw data availability (public repo? proprietary?)
    • Independent replication status (Retraction Watch / PubPeer hits)
    • Citations of the paper that critique or contextualize it

Step 4: Format the verdict
  Write the result to concepts/<claim-slug>.md. The verdict is one of:
    • Verified — claim is accurate; raw data available; replication exists
    • Partially verified — claim correct on the underlying paper but
      methodology has known limits; record limits explicitly
    • Unverifiable — no public data, no replication; not enough to act
    • Misattributed — the claim cites a paper but the paper doesn't say that
    • Retracted / disputed — paper has known retraction or
      well-documented critique

Step 5: Cross-link to original sources
  Add the paper authors to people/ if they have brain pages, or create
  one if notable. Iron Law per conventions/quality.md.
```

## Output: brain page format

```markdown
---
title: "[Claim summary] — Verified"
type: research
date: YYYY-MM-DD
verdict: "verified|partial|unverifiable|misattributed|retracted"
brain_context_slugs: ["pages cited as context"]
---

# [Claim summary] — Verified

> One-line: the verdict + the bottom-line reason.

## The Claim

> Exact quote, exactly as stated, with source attribution.

## Trace

| Step | Finding | Source |
|------|---------|--------|
| Original publication | [Title, authors, year, DOI] | [URL] |
| Methodology | [1-line summary; flag obvious limits] | [URL] |
| Raw data | [Public repo / proprietary / available-on-request] | [URL] |
| Independent replication | [Replication studies and their results] | [URL] |
| Critical citations | [Papers that critique this work] | [URL] |

## Verdict

[Verified / Partially verified / Unverifiable / Misattributed / Retracted]

[1-2 paragraphs explaining WHY the verdict, with specific evidence.]

## Caveats

[Honest limits: what we couldn't verify, what would change the verdict.]

## See Also

- Original paper: [Title](DOI URL)
- Authors' brain pages: [Author 1](people/author-1.md), ...
- Related claims (verified or otherwise): [...]
```

## Useful databases (the agent uses these via perplexity-research)

| Database | What it has | URL pattern |
|----------|-------------|-------------|
| Retraction Watch | Retractions, corrections, expressions of concern | retractionwatch.com/?s=NAME |
| PubPeer | Anonymous post-publication peer review | pubpeer.com/search?q=NAME |
| OSF | Pre-registrations, open data, open materials | osf.io/search/?q=QUERY |
| Semantic Scholar | Citation analysis, paper metadata | api.semanticscholar.org |
| OpenAlex | Open citation data, institutional affiliations | api.openalex.org |
| Many Labs | Replication results for social psychology | osf.io/wx7ck/ |

## Standards (the rigor bar)

- **Verified** — only when the underlying paper exists, raw data is
  public OR an independent lab has confirmed the result, and the citing
  source represents the claim accurately.
- **Partial** — paper is real and findings stand, but the citation
  context oversells (e.g., "X causes Y" when the paper shows
  correlation, or "all studies find X" when it's one underpowered study).
- **Unverifiable** — the underlying number can't be traced to source
  data, no replication has been done, no independent confirmation
  exists. Not the same as "wrong" — say "we couldn't verify."
- **Misattributed** — the citation points to a paper, but the paper
  doesn't actually say what the citation claims. Common in policy briefs.
- **Retracted / disputed** — paper has been retracted, has a major
  expression-of-concern, or has well-documented critique that
  contradicts the headline finding.

Never claim a problem without evidence. The verification document
itself is the artifact — if the claim holds up, say so plainly. If it
doesn't, the trace speaks for itself.

## Anti-Patterns

- ❌ Skipping the brain-first lookup. Re-doing verification we've
  already done is wasted Perplexity spend.
- ❌ Bypassing perplexity-research and inventing the lookup. The
  citations from Perplexity are the evidence — without them, the
  verdict is just opinion.
- ❌ Stating "Verified" without confirming raw data availability.
  Replication trumps any single paper.
- ❌ Stating "Unverifiable" when you simply didn't look hard enough.
  The verdict is on the source, not on your search effort.

## Related skills

- `skills/perplexity-research/SKILL.md` — the actual web-search engine
  this skill routes through (D7/α: pure routing, no new infrastructure)
- `skills/citation-fixer/SKILL.md` — fixes citation FORMATTING; this
  skill checks whether the cited claim is true
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
