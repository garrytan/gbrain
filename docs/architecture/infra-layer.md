# GBrain Infrastructure Layer

The shared foundation that all skills, recipes, and integrations build on.

## Data Pipeline

```
INPUT (markdown files, git repo)
  ↓
FILE RESOLUTION (local → .redirect → .supabase → error)
  ↓
MARKDOWN PARSER (gray-matter frontmatter + body)
  → compiled_truth + timeline separation
  ↓
CONTENT HASH (SHA-256 idempotency check — skip if unchanged)
  ↓
CHUNKING (3 strategies, configurable)
  ├── Recursive: 300-word chunks, 50-word overlap, 5-level delimiter hierarchy
  ├── Semantic: embed sentences, cosine similarity, Savitzky-Golay smoothing
  └── LLM-guided: Claude Haiku identifies topic shifts in 128-word candidates
  ↓
EMBEDDING (OpenAI text-embedding-3-large, 1536 dimensions)
  → batch 100, exponential backoff, non-fatal if fails
  ↓
DATABASE TRANSACTION (atomic: page + chunks + tags + version)
  ↓
SEARCH (hybrid, available immediately)
```

## Search Architecture

GBrain uses Reciprocal Rank Fusion (RRF) to merge vector and keyword search:

```
User Query
  ↓
EXPANSION (optional: Claude Haiku generates 2 alternative phrasings)
  ↓
  ├── VECTOR SEARCH (pgvector HNSW, cosine distance)
  │     → 2x limit results per query variant
  │
  └── KEYWORD SEARCH (PostgreSQL tsvector, ts_rank)
        → 2x limit results
  ↓
RRF MERGE (score = Σ(1/(60 + rank)), balances both fairly)
  ↓
4-LAYER DEDUP
  ├── Best 3 chunks per page (source dedup)
  ├── Jaccard similarity > 0.85 (text dedup)
  ├── No type exceeds 60% (diversity)
  └── Max 2 chunks per page (page cap)
  ↓
TOP N RESULTS (default 20)
```

## Key Components

| File | Purpose |
|------|---------|
| `src/core/engine.ts` | Pluggable engine interface (BrainEngine) |
| `src/core/postgres-engine.ts` | Postgres + pgvector implementation |
| `src/core/import-file.ts` | importFromFile + importFromContent pipeline |
| `src/core/sync.ts` | Git-based incremental change detection |
| `src/core/markdown.ts` | YAML frontmatter + compiled_truth/timeline parsing |
| `src/core/embedding.ts` | OpenAI embedding with batch, retry, backoff |
| `src/core/chunkers/recursive.ts` | Base chunker (300w, 5-level delimiters) |
| `src/core/chunkers/semantic.ts` | Embedding-based topic boundary detection |
| `src/core/chunkers/llm.ts` | Claude Haiku guided chunking |
| `src/core/search/hybrid.ts` | RRF merge of vector + keyword |
| `src/core/search/dedup.ts` | 4-layer result deduplication |
| `src/core/search/expansion.ts` | Multi-query expansion via Claude Haiku |
| `src/core/storage.ts` | Pluggable storage (S3, Supabase, local) |
| `src/core/operations.ts` | Contract-first operation definitions (31 ops) |
| `src/schema.sql` | Full DDL (10 tables, RLS, tsvector, HNSW) |

## Schema Overview

10 tables in Postgres:

- **pages** — slug (unique), type, title, compiled_truth, timeline, frontmatter (JSONB)
- **content_chunks** — pgvector 1536-dim embedding, chunk_source (compiled_truth|timeline)
- **links** — typed edges (knows, works_at, invested_in, founded, etc.)
- **tags** — many-to-many page tagging
- **timeline_entries** — structured events (date, source, summary, detail)
- **page_versions** — snapshot history for diff/revert
- **raw_data** — sidecar JSON from external APIs (preserves provenance)
- **files** — binary attachments in storage backend
- **ingest_log** — audit trail of import operations
- **config** — brain-level settings (version, embedding model, chunk strategy)

Full-text search uses weighted tsvector: title (A), compiled_truth (B), timeline (C).
Vector search uses HNSW index with cosine distance on content_chunks.embedding.

## The Thin Harness Principle

GBrain is the deterministic layer. Skills and recipes are the latent space layer.

See [Thin Harness, Fat Skills](../ethos/THIN_HARNESS_FAT_SKILLS.md) for the full
architecture philosophy.

- **GBrain CLI** = thin harness (same input → same output)
- **Skills** (ingest, query, maintain, enrich, briefing, migrate, setup) = fat skills
- **Recipes** (voice-to-brain, email-to-brain) = fat skills that install infrastructure

The agent reads the skill/recipe and uses GBrain's deterministic tools to do the work.
