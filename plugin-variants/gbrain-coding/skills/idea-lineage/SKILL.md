---
name: idea-lineage
version: 0.1.0
description: |
  Trace one idea's evolution through the brain: first mention, best
  articulation, related concepts, reversals, contradictions, abandoned
  branches, and the current live version. Use for single-idea conceptual
  lineage, not broad concept-map synthesis or structured entity metrics.
triggers:
  - "idea lineage"
  - "trace the lineage of this idea"
  - "how my thinking about"
  - "how has my thinking about"
  - "current version of this idea"
  - "what is my current version of"
  - "show reversals in my thinking about"
  - "where did this idea come from"
tools:
  - search
  - query
  - get_page
  - list_pages
  - takes_search
  - find_contradictions
  - find_trajectory
mutating: false
---

# idea-lineage - Single-Idea Evolution Through the Brain

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, quote fidelity, and source-backed claims.
>
> **Boundary:** see [docs/takes-vs-facts.md](../../docs/takes-vs-facts.md) for
> the distinction between holder-attributed takes and the brain owner's hot
> facts. Do not collapse those layers when summarizing lineage.

## What this solves

Users often want to understand how one idea changed across time: when it first
appeared, when it became sharp, what it displaced, what it contradicted, and
what version is alive now. That is different from building a whole concept map
and different from charting an entity's metric trajectory.

Use this skill when the user asks about one idea, topic, phrase, or concept
page and wants its evolution through the brain.

Canonical examples:

- "Run idea lineage on founder-led sales."
- "How has my thinking about compounding trust changed?"
- "What is my current version of this idea?"
- "Where did this idea come from, and what did I abandon along the way?"

## What this is not

- Not `concept-synthesis`: that skill deduplicates many concept stubs, tiers
  them, writes concept pages, and builds a broad intellectual map.
- Not `find_trajectory`: that operation charts typed facts or event rows for
  an entity, such as MRR, role, location, or status over time.
- Not a contradiction-probe runner: this skill may read cached contradiction
  findings when available, but it does not launch expensive probes.
- Not a writing mode by default: do not write a lineage page unless the user
  explicitly asks for a saved artifact after seeing the read-only answer.

## Contract

This skill guarantees:

- A single-idea scope is preserved. Broad corpus or "map my concepts" prompts
  route to `skills/concept-synthesis/SKILL.md` instead.
- Every lineage claim cites existing brain evidence: page slug, source id when
  present, date, and short quote or snippet.
- Missing evidence is labeled as a gap, not patched with plausible narrative.
- Contradictions, reversals, and abandoned branches are separated from normal
  temporal evolution.
- The default mode is read-only and does not mutate brain pages.

## Phases

### Phase 1: Resolve the idea target

1. Restate the idea in one sentence.
2. Search for exact phrase variants with `search`.
3. Run one semantic `query` for the natural-language version.
4. Check `list_pages` for concept pages when the idea has an obvious concept
   slug or title.
5. If results point to an entity/metric/status trajectory rather than a concept,
   hand off to `find_trajectory` or the normal query/think trajectory path.

If multiple distinct ideas share the same phrase, ask the user to choose the
intended one before synthesizing.

### Phase 2: Gather evidence

Collect enough evidence to support or reject each output bucket:

- Search chunks with dates and source slugs.
- Full pages via `get_page` for the top relevant concept, note, transcript,
  meeting, article, or project pages.
- Related concept pages through backlinks, `related` frontmatter, or repeated
  co-occurrence in search results.
- Takes via `takes_search` when the idea appears as a belief, bet, hunch, or
  attributed claim.
- Cached contradiction findings via `find_contradictions` when the user asks
  about inconsistency or the search results show obvious conflict.
- `find_trajectory` only when the evidence is entity/attribute-shaped, such as
  a role/status/metric evolution that is relevant to the idea's story.

Prefer fewer high-quality sources over a long unsorted pile. Read full pages
when snippets imply a lineage milestone.

### Phase 3: Classify lineage moments

Classify evidence into these buckets:

1. **First mention** - earliest dated evidence where the idea appears.
2. **Best articulation** - the clearest or most complete expression, not
   necessarily the newest.
3. **Current live version** - the most recent high-authority version that still
   appears active.
4. **Reversals** - places where the user's stance changed direction.
5. **Contradictions** - claims that cannot both be true at the same time or
   under the same assumptions. Distinguish these from legitimate temporal
   supersession.
6. **Abandoned branches** - promising variants that appear and then disappear,
   lose support, or are explicitly rejected.
7. **Related concepts** - nearby ideas that shaped or inherited part of the
   original idea.

When a bucket has no evidence, write "No clear evidence found" with a brief note
about what was checked.

### Phase 4: Synthesize the lineage

Write the answer in the output format below. Keep the synthesis proportional to
the evidence. Do not overfit a smooth evolution if the evidence is sparse,
messy, or contradictory.

### Phase 5: Suggest optional next action

If useful, offer one concrete follow-up:

- Save the lineage as a brain page.
- Run broad `concept-synthesis` if the user actually wants the whole concept
  map refreshed.
- Run or inspect trajectory data if the idea turned out to depend on structured
  entity facts.
- Run a contradiction probe only when stale cached findings are insufficient
  and the user explicitly wants that heavier pass.

## Output Format

Use this shape for normal answers:

```markdown
## Current Live Version
[1-3 sentences. Include confidence: high / medium / low.]

## Lineage
- First mention: [date] - [claim] ([source-id:slug], "short quote")
- Best articulation: [date] - [claim] ([source-id:slug], "short quote")
- Turning point: [date] - [what changed] ([source-id:slug])

## Reversals and Contradictions
- Reversal: [what changed, with before/after evidence]
- Contradiction: [what conflicts, or "No clear evidence found"]

## Abandoned Branches
- [branch] - [why it appears abandoned, with evidence]

## Related Concepts
- [concept slug or title] - [relationship]

## Evidence Gaps
- [bucket or claim] - [what was checked and what is missing]
```

For short answers, collapse sections, but keep the same distinctions. Always
cite the source for each non-gap claim.

## Quality Rules

- Quote exact text when naming first mention or best articulation.
- Include dates when the source has dates. If no date is available, say
  "undated" rather than guessing.
- Treat the user's direct statements as highest authority for the user's own
  current view.
- Treat holder-attributed takes as beliefs by that holder, not automatically
  as facts about the world or the brain owner.
- Mark confidence low when evidence comes from a single weak snippet, an
  undated page, or a fuzzy semantic match.
- Preserve source ids in citations when search or page payloads include them.

## Anti-Patterns

- Running `concept-synthesis` for a single-idea question.
- Presenting an entity's MRR, ARR, role, or status trajectory as conceptual
  lineage without explaining the distinction.
- Treating normal temporal evolution as contradiction.
- Inventing abandoned branches because the story would be more interesting.
- Saving or rewriting brain pages without explicit user instruction.
- Using real names, companies, funds, or fork-specific examples in bundled
  fixtures or documentation.

## Related Skills and Operations

- `skills/concept-synthesis/SKILL.md` - broad mutating concept-map synthesis.
- `skills/query/SKILL.md` - general brain search and cited answers.
- `skills/brain-ops/SKILL.md` - source attribution and brain-first behavior.
- `find_trajectory` - structured typed-fact and event timelines for entities.
- `find_contradictions` - cached suspected contradiction findings.

## Tools Used

- `search` - keyword search for exact phrase variants and dated mentions.
- `query` - semantic search for conceptual matches.
- `get_page` - full context for candidate source pages.
- `list_pages` - concept-page discovery and scoped page enumeration.
- `takes_search` - holder-attributed beliefs, bets, hunches, and facts.
- `find_contradictions` - cached contradiction findings when relevant.
- `find_trajectory` - optional structured entity trajectory side-channel.
