---
type: project
title: MBrain
tags:
  - active
  - infrastructure
---

# MBrain

Personal knowledge brain built on Postgres with pgvector. A managed Supabase instance
provides the database layer. MBrain stores, searches, and retrieves personal knowledge
using a hybrid RAG architecture.

## Architecture

- **Contract-first design** — `src/core/operations.ts` defines the shared operation registry.
  Both the CLI and the MCP server are generated from this single source of truth.
  Adding a new operation means defining it once and getting both interfaces for free.
- **Postgres-native** — All data lives in Postgres. Embeddings are stored using
  pgvector. Full-text search uses Postgres tsvector/tsquery. No external search
  services required.
- **Hybrid search** — Combines vector similarity search with keyword full-text search
  using Reciprocal Rank Fusion (RRF). This handles both exact keyword matches and
  semantic near-matches. Multi-query expansion and deduplication further improve
  recall and precision.
- **Compiled truth pages** — All knowledge pages use the two-layer compiled truth +
  timeline format. This means retrieved content is pre-synthesized rather than raw
  note fragments, producing higher quality RAG responses.

## Key Components

- Pluggable engine interface (BrainEngine) with Postgres + pgvector implementation
- 3-tier chunking: recursive, semantic, and LLM-guided
- OpenAI text-embedding-3-large for vector embeddings with batch processing and retry
- Skills system: fat markdown files that work in both CLI and plugin contexts
- MCP stdio server for integration with Claude and other LLM tools

## Current Status

v0.3 shipped with hybrid search, contract-first architecture, and the ClawHub bundle
plugin. Active development continues on search quality improvements and new skills.

## Retrieval-Augmented Generation

MBrain uses RAG as its core query mechanism. The compiled truth pattern is a deliberate
alternative to standard RAG's fragment-retrieval approach: by maintaining pre-synthesized
pages, retrieved context is higher quality and more coherent than raw chunks.

---

## Timeline

### 2025-02-01 — Project Started

Initial implementation with keyword-only search. Postgres + Supabase backend. Basic
CLI for import and query operations.

### 2025-03-01 — Contract-First Refactor

Refactored to contract-first architecture. Operations defined in a single source file,
with CLI and MCP server both generated from the same definitions. This eliminated
drift between the two interfaces and simplified adding new operations.

### 2025-03-28 — Hybrid Search Decision

Weekly sync decision to ship hybrid search in v0.3. Keyword-only search was missing
relevant results when queries used different terminology than stored documents.
Adopted pgvector for embeddings and Reciprocal Rank Fusion (RRF) for merging vector
and keyword result sets.

### 2025-04-01 — v0.3 Shipped

Released v0.3 with hybrid search, ClawHub bundle plugin, and several new skills.
Contract-first parity between CLI, MCP, and tools-json verified by automated tests.
