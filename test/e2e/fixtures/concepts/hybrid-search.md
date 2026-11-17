---
type: concept
title: Hybrid Search
tags:
  - search
  - architecture
  - foresights
---

# Hybrid Search

Hybrid search combines vector similarity search with keyword full-text search to
deliver results that are both semantically relevant and keyword-precise. Foresights uses
hybrid search as its core search architecture, merging the two result sets using
Reciprocal Rank Fusion (RRF).

## The Problem

Neither vector search nor keyword search alone is sufficient for a personal knowledge
brain:

- **Vector-only search** finds semantically similar content but can miss pages that
  contain an exact keyword or phrase. Searching for "NovaMind" might surface pages
  about AI agents generally rather than the specific NovaMind company page.
- **Keyword-only search** finds exact matches but misses semantic near-matches.
  Searching for "autonomous agents" would not find pages that use "AI agents" or
  "agentic systems" instead.

## How Hybrid Search Works

1. **Vector search** — The query is embedded using OpenAI text-embedding-3-large and
   compared against stored document embeddings using cosine similarity via pgvector.
   Returns top-k results ranked by semantic similarity.

2. **Keyword search** — The query is processed as a Postgres tsquery against tsvector
   indexes on document content. Returns results ranked by ts_rank relevance.

3. **Reciprocal Rank Fusion (RRF)** — The two ranked result lists are merged using
   RRF scoring. For each document, the RRF score is calculated as:

   `score = sum(1 / (k + rank_i))` for each result list where the document appears.

   The constant `k` (typically 60) dampens the effect of high rankings in any single
   list. Documents that appear in both lists get boosted because they receive scores
   from both.

4. **Multi-query expansion** — Foresights generates multiple search queries from a single
   user question to improve recall. For example, "Who is Sarah Chen?" might expand to
   queries about "Sarah Chen founder", "NovaMind CEO", and "YC W25 Sarah".

5. **Deduplication** — Results that appear across multiple expanded queries are
   deduplicated, keeping the highest-scoring instance.

## Why RRF

Reciprocal Rank Fusion was chosen over other fusion methods (like linear combination
of normalized scores) because:

- It is score-agnostic: vector cosine similarities and keyword tf-idf scores are on
  different scales, making direct score combination unreliable
- It is robust: small changes in individual scores do not dramatically shift the
  merged ranking
- It naturally boosts documents that appear in both result lists

## Implementation in Foresights

Foresights implements hybrid search in `src/core/search/` using Postgres as the single
backend for both search modalities. Embeddings are stored in pgvector columns, and
full-text search uses native Postgres tsvector/tsquery. This avoids the operational
complexity of maintaining separate search indices (e.g., Elasticsearch + Pinecone).

---

## Timeline

### 2025-03-28 — Decision to Implement

During the weekly sync, identified clear failure cases with keyword-only search.
Example: searching "autonomous agents" did not find pages about "AI agents." Decided
to ship hybrid search with RRF in Foresights v0.3 as the highest priority feature.

### 2025-04-01 — Shipped in v0.3

Hybrid search shipped as part of Foresights v0.3. Initial results show significant
improvement in recall for semantic queries while maintaining precision for exact
keyword searches. The RRF fusion with k=60 produces well-balanced rankings across
diverse query types.
