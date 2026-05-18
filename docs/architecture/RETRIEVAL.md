# Why the hybrid + graph stack works

Vector search alone underdelivers on real personal-knowledge queries. This doc explains why gbrain layers four strategies together and how they compound.

## The four strategies in concert

1. **Vector (HNSW on pgvector)** — semantic similarity. Catches "who works on retrieval quality at YC?" → pages mentioning "Garry Tan + retrieval" even when the user never typed "YC".
2. **BM25 keyword** — lexical match. Catches names, exact phrases, code identifiers, anything where the user remembers the literal token. Survives the cases where vector search drifts into thematic neighbors.
3. **Reciprocal-rank fusion (RRF)** — merges vector + keyword rankings without weighting one over the other globally. Each strategy gets to vote.
4. **Knowledge graph traversal** — follows typed edges. Catches "what did Bob invest in this quarter?" by walking `bob ── invested_in ──> company ── dated ──> Q1`. Vector search can't see causal chains; the graph can.

## Why each one alone fails

**Vector only.** Returns chunks semantically close to the query. Misses any factual relationship not directly encoded in the embedding. "Companies in Garry's portfolio" returns essays about portfolios, not company pages.

**Keyword only (ripgrep-style).** Brittle to phrasing. "Who works on retrieval?" misses pages that say "search ranking" instead of "retrieval." Garbage on synonyms, near-misses, or paraphrases.

**Graph only.** Excellent at "neighbors of Alice" but blind to anything not yet linked. Sparse on fresh pages until backlinks accumulate.

**Hybrid (vector + keyword + RRF), no graph.** Decent at "what is X?" type queries. Fails on "what is Y's relationship to X?" — those are graph queries and no amount of embedding tuning recovers them.

## The benchmark

BrainBench (corpus + harness in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo) measures retrieval P@5, R@5, MRR, nDCG@5 on a 240-page Opus-generated rich-prose corpus.

| Strategy | P@5 | R@5 | Notes |
|---|---|---|---|
| ripgrep BM25 only | ~18 | ~75 | Lexical-only baseline |
| vector-only RAG | ~18 | ~80 | Standard RAG implementation |
| gbrain graph-disabled (hybrid + RRF, no graph traversal) | ~18 | ~85 | Hybrid alone |
| **gbrain default (full stack)** | **49.1** | **97.9** | Graph + extract-quality lift |

**+31 P@5 points** from the graph + extract quality work. The graph isn't a marginal feature; it's the load-bearing wall.

## Auto-link: why zero-LLM-call edge extraction works

Every `put_page` runs `extractEntityRefs` on the markdown body. It matches:

- Standard markdown links: `[Garry Tan](wiki/people/garry-tan)`
- Obsidian wikilinks: `[[wiki/people/garry-tan|Garry Tan]]`
- Typed-link blockquotes: `> **Convention:** see [path](path).`

Three regexes, zero LLM tokens, single SQL `addLinksBatch` call with `INSERT ... SELECT FROM unnest(...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1`. The graph grows on every write at near-zero cost. On a 17K-page brain, full graph extract completes in seconds.

Heuristic link-type inference (`attended`, `works_at`, `invested_in`, `founded`, `advises`) fires from surrounding sentence context — also LLM-free. Power users who want richer types add them via the typed-link blockquote convention.

## ZeroEntropy as reranker: 60% top-1 reshuffle

v0.36.0.0 ships ZeroEntropy's `zerank-2` as the default reranker (on for the `balanced` mode bundle). On a real-corpus benchmark across 20 queries, zerank-2 reshuffles **60% of top-1 results** after the hybrid + RRF + graph stack. That's the headline number.

The mechanical reason: hybrid ranking is locally optimal per strategy but globally suboptimal. A cross-encoder reranker reads the query + each candidate document jointly, with full attention. It catches the cases where the vector + keyword + graph signals all agreed on a document that's semantically related but topically wrong.

The cost: +150ms p50 latency, ~$0.025/M tokens. Disabled with `gbrain config set search.reranker.enabled false`. For agent loops that do downstream LLM work after retrieval, the latency is invisible.

## Source-aware ranking

Hybrid search applies a source-factor CASE expression at the SQL layer (lives in `src/core/search/sql-ranking.ts`). Curated content like `originals/`, `concepts/`, `writing/` outranks bulk content like `wintermute/chat/`, `daily/`, `media/x/`. Hard-exclude prefixes (`test/`, `archive/`, `attachments/`, `.raw/`) filter at retrieval, not post-rank.

The boost map is configurable via `GBRAIN_SOURCE_BOOST` env var or per-call `SearchOpts.exclude_slug_prefixes`. Temporal queries (`detail: 'high'`) bypass the boost so chat pages re-surface for time-sensitive lookups.

## Intent-aware query rewriting

`src/core/search/intent.ts` classifies queries into `entity`, `temporal`, `event`, or `general`. Each routes through different ranking knobs:

- **Entity** queries ("who works at X?") apply a higher graph-traversal weight.
- **Temporal** queries ("what happened last week?") bypass source-boost so chat/daily pages surface.
- **Event** queries ("Acme AI Series A") engage the timeline index.
- **General** queries hit the standard hybrid stack.

The classifier is deterministic (no LLM call). Wrong classification degrades gracefully — the hybrid stack still works without it.

## Multi-query expansion

For `detail: 'high'` searches, `src/core/search/expansion.ts` runs a Haiku-class LLM call to produce 2-3 query variants. Each variant runs through the full hybrid stack; results merge via RRF. Catches synonym misses without recall loss.

Expansion is opt-in per mode bundle (`tokenmax` on by default; `balanced` + `conservative` off). Default off in the cheap tiers because the LLM call adds ~$0.001/query and ~200ms — real money at scale.

## Putting it together

The full pipeline for a `query` op:

```
intent classify
       │
       ▼
expansion (if enabled)
       │
       ▼
hybrid search:
   ├── vector  (HNSW on chunk embeddings)
   ├── keyword (BM25 via tsvector)
   ├── source-aware re-rank (CASE in SQL)
   └── RRF fusion → top 30
       │
       ▼
graph augment (typed-edge traversal from any seed)
       │
       ▼
reranker (zerank-2 cross-encoder, top 30 → reordered)
       │
       ▼
token-budget enforcement (per mode bundle)
       │
       ▼
deduplication (same slug, different chunks → keep best)
       │
       ▼
results
```

Each stage is testable in isolation. Each stage is replaceable. The whole pipeline is < 1ms of orchestration cost; the latency budget goes to the upstream HTTP calls (embedding, rerank) and the index scans.

## How to verify on your own brain

```bash
# Run the public LongMemEval benchmark
gbrain eval longmemeval datasets/longmemeval_s.jsonl

# Capture your own queries and replay against retrieval changes
export GBRAIN_CONTRIBUTOR_MODE=1
# ... use gbrain normally ...
gbrain eval export > before.ndjson
# ... change something ...
gbrain eval replay --against before.ndjson

# A/B retrieval strategies on a labeled fixture
gbrain eval --qrels labels.tsv --config balanced.json
```

Methodology + metric glossary in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](../eval/SEARCH_MODE_METHODOLOGY.md).
