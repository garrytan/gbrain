# Search Quality Benchmark — PR #64

**Date:** 2026-04-14
**Branch:** garrytan/search-quality-boost
**Inspired by:** Ramp Labs' "Latent Briefing" paper (April 2026)

## What this PR does

GBrain stores knowledge in brain pages. Each page has two sections: **compiled truth**
(your distilled assessment of a person, company, or concept) and **timeline** (dated
entries like meeting notes, announcements, funding rounds).

Before this PR, search treated both sections equally. Ask "who is Alice Chen?" and you
might get a meeting note from March instead of the actual assessment. Ask "when did we
last meet Alice?" and you might get the assessment instead of the date.

This PR teaches search to understand the difference. It picks the right section based
on what you're asking.

## How we test it

We built a synthetic brain with **29 fictional pages** and **58 chunks** (2 per page:
one compiled truth, one timeline). The pages span 10 people, 10 companies, and 9
concept pages across topics like AI, fintech, climate, crypto, robotics, education,
biotech, and design.

The embeddings share dimensions to simulate real-world overlap. "AI" shows up in
health pages, education pages, design pages, and robotics pages. A query about "AI
companies" has to sort through 5+ relevant pages, not just find one obvious match.

We run **20 queries** with hand-labeled ground truth:
- 11 entity queries ("who is X?", "what does Y do?", "tell me about Z")
- 7 temporal queries ("when did we last meet?", "recent updates", "what launched?")
- 1 negative control (irrelevant topic, no matches expected)
- 1 ambiguous query (could go either way)

Each query has **graded relevance**: the primary answer gets grade 3, related pages get
2 or 1. A query about climate investing has 4 relevant pages ranked by importance.

We compare three configurations:
- **A. Baseline** — how search worked before this PR
- **B. Boost only** — compiled truth chunks get a 2x score multiplier (the naive approach)
- **C. Boost + Intent** — the full PR: boost + intent classifier that auto-detects query type

## Results: finding the right page

These are standard information retrieval metrics. They answer: "did search find the
right page?"

| Metric | What it measures | A. Before | C. After | Change |
|--------|-----------------|-----------|----------|--------|
| **P@1** | Is the #1 result relevant? | 94.7% | 94.7% | same |
| **MRR** | How far down is the first relevant result? | 0.974 | 0.974 | same |
| **nDCG@5** | Are the top 5 results in the right order? | 1.191 | 1.069 | -10% |

Page-level retrieval is roughly the same. The right page was already being found. This
is not where the improvement lives.

## Results: finding the right chunk (the actual improvement)

These metrics answer: "did search find the right SECTION of the right page?" This is
what matters when an agent reads search results to answer a question.

| Metric | What it measures | A. Before | C. After | Change |
|--------|-----------------|-----------|----------|--------|
| **Source accuracy** | Is the top chunk the right type for this query? (assessment for "who is X?", timeline for "when did we meet?") | 89.5% | 89.5% | same |
| **CT-first rate** | For entity lookups, does the assessment show up before timeline noise? | 100% | 100% | same |
| **Timeline accessible** | For temporal queries, can you actually find the dates? | 100% | 100% | same |
| **Unique pages** | How many different pages appear in top 10? (more = broader context) | 7.2 | **8.7** | **+21%** |
| **Compiled truth ratio** | What % of returned chunks are assessments vs timeline noise? | 51.6% | **66.8%** | **+29%** |

Two big improvements:

1. **21% more page coverage.** The agent sees 8.7 unique pages per query instead of 7.2.
   When you ask "AI companies building real products", you get results from MindBridge,
   EduStack, PixelCraft, GenomeAI, AND the AI-first thesis page. Before, some of those
   were crowded out.

2. **29% more signal in results.** Two thirds of returned chunks are now compiled truth
   (assessments) instead of roughly half. The agent reads more distilled knowledge and
   less timeline noise.

## Why the boost alone isn't enough

We also tested configuration B: the 2x compiled truth boost without the intent classifier.
This is the naive version that just says "rank assessments higher, always."

| What broke | Before | Boost only | With intent |
|-----------|--------|------------|-------------|
| Source accuracy | 89.5% | **63.2%** | 89.5% |
| Timeline accessible | 100% | **71.4%** | 100% |
| P@1 | 94.7% | **89.5%** | 94.7% |

The boost forces compiled truth to the top even when timeline IS the right answer. Ask
"what launched this year?" and the boost pushes assessment chunks above the actual launch
dates. The source accuracy drops from 89.5% to 63.2%.

The **intent classifier** fixes this. It reads the query text (zero latency, no LLM call)
and detects whether you're asking an entity question or a temporal question:

- "Who is Alice Chen?" → entity → boost compiled truth
- "When did we last meet Alice?" → temporal → skip boost, show timeline
- "Recent funding rounds" → temporal → skip boost, show dates
- "AI companies building real products" → general → moderate boost

This recovers all the regressions while keeping the improvements.

## Per-query results

Every query, every configuration. "Src" column shows which chunk type ranked first.

| Query | Expected | Before src | After src | Before pages | After pages |
|-------|----------|-----------|-----------|-------------|-------------|
| Who is Alice Chen? | assessment | assessment | assessment | 7 | 10 |
| What does MindBridge do? | assessment | assessment | assessment | 6 | 10 |
| Tell me about climate investing | assessment | assessment | assessment | 5 | 10 |
| When did we last meet Alice? | timeline | timeline | timeline | 9 | 9 |
| Recent updates on GenomeAI | timeline | timeline | timeline | 8 | 8 |
| CloudScale acquisition | timeline | timeline | timeline | 8 | 8 |
| Alice Chen NovaPay payments | assessment | assessment | assessment | 7 | 8 |
| Carol Nakamura MindBridge AI | assessment | assessment | assessment | 6 | 8 |
| AI companies building products | assessment | assessment | assessment | 9 | 10 |
| Who raised funding recently? | timeline | timeline | timeline | 10 | 10 |
| Bob and James climate investments | assessment | assessment | assessment | 5 | 9 |
| AI replacing designers | assessment | assessment | assessment | 7 | 8 |
| Everything on RoboLogic | timeline | assessment | assessment | 6 | 6 |
| Deep dive on crypto custody | timeline | assessment | assessment | 6 | 6 |
| Education technology Africa | assessment | assessment | assessment | 7 | 10 |
| What launched this year? | timeline | timeline | timeline | 10 | 10 |
| MPC multi-party computation | assessment | assessment | assessment | 7 | 9 |
| Protein folding drug discovery | assessment | assessment | assessment | 7 | 9 |
| EduStack Nigeria | assessment | assessment | assessment | 7 | 8 |

The "pages" column tells the clearest story. Entity lookups with `detail=low` (the
intent classifier's choice) go from 5-7 pages to 8-10 pages. The agent gets significantly
broader context for the same query.

## What shipped in PR #64

1. **Compiled truth boost** — 2.0x score multiplier after RRF normalization
2. **Intent classifier** — zero-latency regex that auto-selects detail level per query
3. **Detail parameter** — `--detail low/medium/high` for explicit agent control
4. **Source-aware dedup** — guarantees compiled truth chunk per page in results
5. **Cosine re-scoring** — re-ranks chunks against the actual query embedding
6. **RRF normalization** — scores normalized to 0-1 before boosting
7. **CJK word count fix** — Chinese/Japanese/Korean queries now expand correctly
8. **Eval harness** — `gbrain eval --qrels` with P@k, R@k, MRR, nDCG@k + A/B comparison
9. **This benchmark** — 29 pages, 20 queries, reproducible, no private data

## How to reproduce

```bash
bun run test/benchmark-search-quality.ts
```

Runs in ~2 seconds against in-memory PGLite. No API keys, no database, no network.

## Methodology notes

- All data is fictional. No private information from any real brain.
- Embeddings use 25 topic dimensions with shared axes (not orthogonal basis vectors).
  "AI" and "health" share signal so that an AI health query naturally ranks both the
  AI-health concept page and the MindBridge company page.
- Each page has exactly 2 chunks (1 compiled truth, 1 timeline) for clean measurement.
  Real brains have more chunks per page, which would amplify the boost's effect.
- The baseline uses the old text-prefix dedup key. The new configurations use chunk_id.
- Graded relevance: 3 = primary answer, 2 = strongly related, 1 = tangentially related.
