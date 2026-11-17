---
type: concept
title: Retrieval-Augmented Generation
aliases:
  - RAG
  - 検索拡張生成
tags:
  - ai
  - search
  - architecture
---

# Retrieval-Augmented Generation

Retrieval-Augmented Generation (RAG) is a technique that enhances large language model
responses by retrieving relevant documents from a knowledge store and including them as
context in the prompt. Also known in Japanese as 検索拡張生成 (RAG).

## How It Works

1. **Query embedding** — The user's query is converted into a vector embedding using a
   model like OpenAI's text-embedding-3-large.
2. **Retrieval** — The query vector is compared against stored document vectors using
   similarity search (typically cosine similarity). The top-k most similar documents
   are retrieved.
3. **Context stuffing** — Retrieved documents are inserted into the LLM prompt as
   context, giving the model access to specific, relevant knowledge.
4. **Generation** — The LLM generates a response grounded in the retrieved context
   rather than relying solely on its training data.

## Advantages

- Grounds LLM responses in specific, up-to-date knowledge
- Reduces hallucination by providing factual context
- Allows knowledge to be updated without retraining the model
- Scales to large knowledge bases with efficient vector indexing

## Limitations

- Quality depends heavily on retrieval accuracy — if the wrong documents are retrieved,
  the answer will be wrong or incomplete
- Pure vector search can miss exact keyword matches (the "vocabulary mismatch" problem)
- Chunk boundaries can split important context across fragments
- No synthesis: retrieved chunks are raw fragments, not curated knowledge

## Foresights's Approach

Foresights uses RAG as its core query mechanism but addresses several standard RAG
limitations through deliberate design choices:

- **Compiled truth** pages mean retrieved content is pre-synthesized knowledge rather
  than raw note fragments. This is the key differentiator from standard RAG systems.
- **Hybrid search** combines vector similarity with keyword full-text search using
  Reciprocal Rank Fusion (RRF), addressing the vocabulary mismatch problem.
- **Multi-query expansion** generates multiple search queries from a single user
  question to improve recall.
- **Deduplication** ensures the same content is not retrieved multiple times when it
  matches across different query expansions.

---

## Timeline

### 2025-02-15 — RAG Research

Evaluated standard RAG patterns for Foresights. Identified the core tension: RAG works
best when retrieved documents are high quality and self-contained, but most note-taking
systems produce fragmented, partially-overlapping content. This led to the compiled
truth pattern as a write-time optimization for read-time retrieval quality.

### 2025-03-28 — Hybrid Search Decision

During weekly sync, decided to implement hybrid search (vector + keyword with RRF) for
Foresights v0.3. Pure vector search was missing exact keyword matches, and pure keyword
search was missing semantic near-matches. Hybrid search with Reciprocal Rank Fusion
gives us the best of both approaches.
