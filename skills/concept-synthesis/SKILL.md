---
name: concept-synthesis
version: 0.1.0
description: Deduplicate and synthesize raw concept stubs into a tiered intellectual map (T1 Canon to T4 Riff), tracing idea evolution across sources over time. Transforms thousands of raw concept pages into a curated intellectual fingerprint.
triggers:
  - "concept synthesis"
  - "synthesize my concepts"
  - "find patterns across my notes"
  - "build my intellectual map"
  - "trace idea evolution"
mutating: true
writes_pages: true
writes_to:
  - concepts/
---

# concept-synthesis — From Raw Stubs to Intellectual Map

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> back-link enforcement and quote-fidelity requirements.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> output files under `concepts/` per the primary-subject rule.

## What this solves

Many ingestion pipelines (signal-detector, idea-ingest, voice-note-ingest)
create a concept page for every idea mentioned. Over months this produces:

- Thousands of stub pages, many duplicates or near-duplicates
- Timeline entries that repeat the same source across multiple concept pages
- No synthesis — just "the user mentioned X on this date"
- No tier assignments — everything flat
- No clustering — related ideas aren't linked

This skill transforms that raw material into a curated intellectual map.

## Architecture

```
Phase 1: Dedup + merge (deterministic)
  N stubs → ~N/4 canonical concepts
    ├── Jaccard dedup (word-overlap on titles + first-paragraph)
    ├── Substring dedup ("founder mode" vs "founder mode vs manager mode")
    ├── Semantic dedup (LLM: "are these the same idea?")
    └── Merge timelines + aliases from duplicates into the canonical page

Phase 2: Score + tier (deterministic + heuristic)
  Each canonical concept → scored and tiered
    ├── Frequency: distinct sources referencing this concept
    ├── Timespan: first mention → last mention in days
    ├── Breadth: distinct months it appears in
    ├── Engagement: avg engagement on concept-bearing sources (if available)
    └── Tier: T1 Canon | T2 Developing | T3 Speculative | T4 Riff

Phase 3: Synthesize (LLM, T1+T2 only)
  T1 + T2 concepts → rich synthesis
    ├── Evolution narrative: how the idea sharpened over time
    ├── Best articulation: highest-engagement or most precise quote
    ├── Related concepts: cross-links to other concepts
    ├── Context: what was happening when this idea emerged / evolved
    └── Counter-positions: what this idea argues against

Phase 4: Cluster + map (LLM)
  All tiered concepts → intellectual clusters
    ├── Group related concepts into domains (auto-named via LLM)
    ├── Generate cluster summary pages
    ├── Build a master concepts/README.md with the full map
    └── Identify idea genealogies (concept A → evolved into concept B)
```

## Invocation

The skill is markdown agent instructions. The agent uses gbrain's
existing operations + LLM passes:

```bash
# 1. List all concept pages
gbrain query "type:concept" --limit 10000 --json

# 2. Phase 1 dedup — agent applies Jaccard + substring locally,
#    then LLM passes to identify semantic duplicates.

# 3. Phase 2 tier — agent scores each canonical concept based on
#    frequency / timespan / breadth and writes tier into frontmatter.

# 4. Phase 3 synthesis — for each T1/T2, agent reads the timeline
#    + associated source pages and writes a synthesis section
#    onto the concept page via put_page.

# 5. Phase 4 clustering — agent reads the tiered concept list
#    and writes concepts/README.md with the full intellectual map.
```

## Output: concept page format (post-synthesis)

### T1 Canon — full synthesis

```markdown
---
title: "concept name"
type: concept
tier: 1
tier_label: "Canon"
mention_count: 18
distinct_months: 8
first_mention: "YYYY-MM-DD"
last_mention: "YYYY-MM-DD"
composite_score: 78.4
aliases: ["alternate phrasing 1", "alternate phrasing 2"]
related: ["sibling-concept-1", "sibling-concept-2"]
---

# concept name

**Tier 1 — Canon** | 18 mentions across 8 months

## Synthesis

[2-4 paragraph narrative tracing how the idea evolved, what it means in
the user's worldview, why it matters. Third-person analytical voice.]

## Best Articulation

> "Verbatim quote from a source — the most precise or highest-engagement
> expression of this idea." — [Date](source-url)

## Evolution

| Period | Expression | Signal |
|--------|-----------|--------|
| YYYY-MM | "First articulation" | First use — aspiration frame |
| YYYY-MM | "Sharpening" | Anti-pattern emerges |
| YYYY-MM | "Peak form" | Cleanest expression |

## Related Concepts
- [sibling concept](sibling-concept.md) — relationship description
- [sibling concept](sibling-concept.md) — relationship description

## Timeline
[Full timeline with deduped entries, quotes, source links]
```

### T3 / T4 — stub only (no LLM synthesis)

```markdown
---
title: "concept name"
type: concept
tier: 4
tier_label: "Riff"
mention_count: 1
---

# concept name

**Tier 4 — Riff** | 1 mention

> "Quote from the source" — [Date](URL)
```

## Output: cluster map at concepts/README.md

```markdown
# Intellectual Universe

## Canon (T1) — N concepts
The permanent intellectual fingerprint. Ideas that recur across years.

### [Cluster Name]
- [concept-slug](concept-slug.md) — one-line characterization
- ...

### [Other Cluster]
- ...

## Developing (T2) — N concepts
Sharpening. Might become canon.

## Speculative (T3) — N concepts
Testing in public.

## Stats
- Total concepts: N
- T1 Canon: N
- T2 Developing: N
- T3 Speculative: N
- T4 Riff: N
- Earliest source: YYYY-MM-DD
- Latest source: YYYY-MM-DD
```

## Quality gates

### Dedup quality
- No two concept pages should be "the same idea in different words."
- Aliases preserved in frontmatter for search.
- Run `gbrain query "type:concept"` and spot-check the count reduction.

### Tier quality
- T1 should feel like "yes, that IS one of my recurring frameworks" —
  recognizable, recurring, sharp.
- T2 should feel like "I'm working on this; it's getting clearer."
- No concept should be T1 with < 4 months span or < 6 mentions.
- No concept should be T4 with > 3 months span.

### Synthesis quality
- Captures evolution, not just repetition.
- Uses verbatim quotes, not paraphrase.
- Links to related concepts (markdown links, not wiki-links).
- Does NOT hallucinate sources or dates.

## Cron integration

This is heavy work. Run on a cadence, not on every signal:

- After a major ingestion batch completes (signal-detector burst, archive
  crawler run, etc.).
- Weekly cron for incremental synthesis of newly-promoted T1/T2 concepts.
- Manual trigger for a full re-synthesis when the corpus shifts
  significantly.

## Anti-Patterns

- ❌ Running synthesis on T3/T4 — wastes API budget on ideas that may
  never sharpen.
- ❌ Hallucinating quotes or dates. The timeline must be verifiable
  against existing brain pages.
- ❌ Generic cluster names ("Various Topics"). If you can't name the
  cluster, the cluster isn't real.
- ❌ Re-synthesizing already-synthesized T1s without new source material.
  Idempotency-respect.

## Related skills

- `skills/signal-detector/SKILL.md` — creates raw concept stubs from text channels
- `skills/voice-note-ingest/SKILL.md` — same for audio channels
- `skills/idea-ingest/SKILL.md` — same for links / articles


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
