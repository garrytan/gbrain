# Postgres features map

This map lists every Postgres-specific feature gbrain uses: pgvector, full-text search, pg_trgm, JSONB, recursive CTEs, triggers, LISTEN/NOTIFY, advisory and row locks, the `SKIP LOCKED` job queue, RLS and roles, transactions and isolation, and runtime features. For each feature it gives the file paths, the behavior that depends on it, and candidate embedded Rust replacements with tradeoffs and parity risks.

- Reference: `garrytan/gbrain` at commit `8bbfd0b5e8` (master, 2026-11-16). Every `path:line` citation is relative to the gbrain repo root at that commit.
- Method: two research passes (query and data features; concurrency, access control and runtime features). `rg` counts are line matches across `src/`, not file counts. Items a pass could not verify say so in place.

## Contents

| Section | Covers |
|---|---|
| [Query and data features](#query-and-data-features) | pgvector, FTS (tsvector, `ts_rank`, CJK), pg_trgm, JSONB, recursive CTEs, upserts, batch patterns, window functions, timestamps, hybrid RRF fusion |
| [Concurrency, access control and runtime features](#concurrency-access-control-and-runtime-features) | triggers, LISTEN/NOTIFY, advisory locks, row locks, `SKIP LOCKED` queue, RLS and roles, transactions, timeouts, cancellation, pooling, introspection, the multi-process model |

## Feature inventory at a glance

| Feature | Main sites | What depends on it | Leading Rust candidate | Main parity risk |
|---|---|---|---|---|
| pgvector cosine (`<=>`), `vector`/`halfvec`, HNSW | `search/vector-statement.ts`, `search/embedding-column.ts`, `content_chunks`, `takes`, `facts` | vector and hybrid search, takes and facts recall | exact f32 scan first; HNSW crate (usearch, hnsw_rs) or sqlite-vec later | ANN top-k differs at the margin; f16 rounding; dimension reconciliation at connect |
| tsvector + `websearch_to_tsquery` + `ts_rank` | `search/keyword-statement.ts`, `fts-language.ts`, trigger on `content_chunks`/`pages` | keyword search, phrase factor, hybrid inputs | SQLite FTS5 or tantivy | BM25 is not `ts_rank`; Snowball stems and stop words differ; tsvector size caps |
| CJK ILIKE fallback | `engine-sql/cjk-search.ts`, `search/cjk-keyword-sql.ts` | keyword search on CJK text | substring scan with a deadline, or an n-gram tokenizer | case folding, `LENGTH()` counting, 2,000-candidate cap |
| pg_trgm `%`, `similarity()` | `engine-sql/pages.ts` (`findByTitleFuzzy`), `entities/resolve.ts` | fuzzy title and entity resolution | port the pg_trgm trigram algorithm in Rust | padding and threshold (0.3) rules must match exactly |
| JSONB (`@>`, `->>`, `jsonb_to_recordset`, `jsonb_set`) | frontmatter filters, batch writes, config layers, job `data` | `where` filters, batch link and timeline writes | SQLite JSON1 or serde_json in code | number vs string equality, key order, containment semantics |
| `WITH RECURSIVE` | 12 files (table below) | graph traversal, job trees, config layers, chunk occurrences | Rust BFS in code, or SQLite recursive CTEs | row caps and tie order before the cap |
| plpgsql triggers (about 25) | `src/schema.sql` | search vectors, revision counters, projection queues, fail-closed writer guards | explicit write-path steps in Rust; a few SQLite triggers | a missed trigger silently breaks search or purge |
| LISTEN/NOTIFY | trigger `notify_minion_job_change`, `minions/sync-queue-wake.ts` | wakes idle job workers | in-process channel; `PRAGMA data_version` or socket across processes | none if the poll backstop stays |
| advisory locks (key 42 + about 15 key families) | `schema-migration-lock.ts`, `postgres-engine/init-schema-lock.ts`, `engine-sql/facts.ts`, `page-body/*` | migration safety, fact dedup, quotas, derivation scope | file lock + single writer; keyed in-process mutexes | cross-process semantics; stale-holder reaping |
| row locks, `SKIP LOCKED` | `minions/queue.ts`, `lockPageKeys` (about 76 files), `db-lock.ts` | job exactly-once, page write serialization | single writer transaction; lease columns with fenced updates | `claim_generation` and `lock_token` fencing must stay exact |
| RLS, roles | `DO` block in `schema.sql` (BYPASSRLS only); no policies or grants | hosted Supabase deny-by-default | application authorization only | none for the contract; doctor checks become not applicable |
| transactions, isolation, timeouts, cancellation | `postgres-engine/*` | consistent reads, 8 s keyword bound, abort | SQLite WAL + `BEGIN IMMEDIATE`, `sqlite3_interrupt`, deadlines | same refusals (`KeywordSkippedAfterTimeoutError`) under deadline |

### Every recursive CTE site

The query pass covered the graph walks in depth. This is the full list of `WITH RECURSIVE` sites in `src/` (excluding generated files):

| Site | What it walks |
|---|---|
| `src/core/engine-sql/links.ts:673` | `traverseGraph` BFS over links (`bfsWalkCtes`) |
| `src/core/engine-sql/links.ts:784` | `traversePathsDetailed` edge walk with truncation flag |
| `src/core/engine-sql/graph-rank.ts:123` | readable-page graph for entity ranking |
| `src/core/search/read-enrichment.ts:54` | `relationalFanout` walk with `visited` and `path` arrays, depth clamped to 3 |
| `src/core/minions/queue.ts:1061` | descendant jobs of a cancelled job |
| `src/core/minions/legacy-cancel.ts:42` | descendant jobs for legacy cancel |
| `src/core/minions/authorize-legacy.ts:57` | connected job set for legacy authorization |
| `src/core/minions/job-insight.ts:204` | job tree with owner client id |
| `src/core/persistence/terminal-classify.ts:489` | persistence request lineage |
| `src/core/persistence/capacity-forecast.ts:118` | skip-scan walk over persistence sequences |
| `src/core/source-config-sql.ts:15` | layered source config merge (`root_layers`) |
| `src/core/page-body/projection.ts:66` | loose index scan over chunk occurrence ids (`STALE_CHUNKS_SQL`) |
| `src/core/onboard/checks.ts:667` | loose index scan over `(source_id, type)` pairs |

Several of these (the last two, and `capacity-forecast.ts`) are skip-scan tricks for the Postgres planner. In Rust they become a plain `DISTINCT` or an index range scan.

---

## Query and data features

Scope: pgvector, full-text search, pg_trgm, JSONB, recursive CTEs, and the other Postgres SQL features the embedded store must emulate. Source: `garrytan/gbrain` at commit 8bbfd0b5e8. Line numbers are from reads in this pass. Counts from `rg` are line matches across `src/`, not file counts, and are ballpark only.

### Summary of what matters for the Rust rewrite

- Keyword search is Postgres `websearch_to_tsquery` + `ts_rank` / `ts_rank_cd` over stored `tsvector` columns, with weights A/B/C, a Snowball English config, and a CJK ILIKE fallback. Ranking is the hardest parity item.
- Vector search is pgvector cosine (`<=>`) over `vector(N)` / `halfvec(N)` columns, HNSW-indexed, with `hnsw.ef_search` and `hnsw.iterative_scan` tuned per query. An exact (sequential) path also exists and is used as fallback.
- Hybrid search fuses keyword and vector page lists in JavaScript with RRF (k = 60). That code is portable as-is; only its inputs need parity.
- The graph (links) is traversed with `WITH RECURSIVE` BFS using array `visited` sets, row caps, and `DISTINCT ON`/window dedup. A Rust engine can do this in code, but must keep the same caps and ordering.
- Several correctness-relevant behaviours live in the database: NULLS NOT DISTINCT unique keys, partial indexes, generated columns, `ON CONFLICT`, text truncation to tsvector caps, and statement timeouts.
- The planner-specific tuning (`OFFSET 0` fences, `MATERIALIZED` CTEs, planner-stats row-delta ANALYZE) exists only to steer the Postgres/PGLite planner. Most of it has no meaning in a new engine, but the observable results (ordering, caps, dedup) must be kept.

---

### 1. pgvector: types, dimensions, operators, indexes

#### 1.1 Extension and column types

| Item | Where | Notes |
|---|---|---|
| `CREATE EXTENSION vector`, `pg_trgm`, `pgcrypto` | `src/schema.sql:3-6` | pgcrypto only for gen_random_uuid on old PG. |
| `content_chunks.embedding vector(1536)`, default model `text-embedding-3-large` | `src/schema.sql:360-361` | Fresh-install DDL. The configured default model is `voyage:voyage-4`, 1024 dims (`src/core/ai/defaults.ts:15-16`). Dims are reconciled at runtime, see 1.4. |
| `content_chunks.embedding_image vector(1024)` (Voyage multimodal) | `src/schema.sql:400` | Partial HNSW index `idx_chunks_embedding_image` (`schema.sql:412-415`). |
| `content_chunks.embedding_multimodal vector(1024)` | `src/schema.sql:403` | |
| `facts.embedding` is `vector` or `halfvec(N)` | `src/core/engine-sql/facts.ts:37-46, 232` | Cast chosen by probing the live column type (`::vector` vs `::halfvec`). |
| `takes.embedding` with HNSW `idx_takes_embedding_hnsw` | `src/core/schema-migrations/v142-takes-embedding-dimension-matches-config.ts:18-46` | Dropped and nulled on dim change. |
| Column type allowlist `vector` or `halfvec` | `src/core/search/embedding-column.ts:82, 221, 408-409, 565-571` | Builtin `embedding` descriptor; a dimensions placeholder of 1536 is hardcoded at 565 and says it is unused in the cast. |
| Write cast `'<literal>'::vector` or `::halfvec(N)` | `src/core/search/embedding-column.ts:249-281` | Bound as a text literal (`toPgVectorLiteral`), cast in SQL. |
| `vectorLiteralSql`, `toPgVectorLiteral` | `src/core/engine-sql/facts.ts:105`, `src/core/pglite-engine.ts:133` | Vectors are serialized as text, so no binary protocol. |

Rust note: vectors are `Float32Array` in JS. A Rust store must hold f32 (and f16 for halfvec) and must round-trip the same bytes the text literal carries, or cosine values drift slightly.

#### 1.2 Distance operators

| Use | Where |
|---|---|
| Cosine distance `cc.embedding <=> $q`, score = `1 - distance` | `src/core/search/vector-statement.ts:404-410` (`raw_score`), `:417-423` (exact scan variant `ORDER BY distance`) |
| Index-walk ann CTE `ORDER BY cc.col <=> q LIMIT n*overfetch` | `src/core/search/vector-statement.ts:415-447` (`indexWalkCandidates`) |
| Joined candidate CTE `hnsw_candidates` | `src/core/search/vector-statement.ts:401-411` |
| Scope scan CTE (`scope_scan AS MATERIALIZED`) | `src/core/search/vector-statement.ts:447` onward |
| Facts vector search (`embedding <=>`) | `src/core/engine-sql/facts.ts:585-620` |
| Cosine rescore in SQL: `cosineByChunkIdsStatement` | `src/core/search/cosine-rescore.ts:1-20`, `src/core/engine-sql/chunks.ts` |

Only `<=>` (cosine) is used. No `<->` (L2) or `<#>` (inner product) is used in `src/`. `vector_cosine_ops` is the only opclass in DDL (`src/core/vector-index.ts:24`, `src/schema.sql:408`).

Behavioural note: a stored chunk with zero norm or a different dimension scores 0 in the JS rescore path (`cosine-rescore.ts:1-20`). The SQL path must match that.

#### 1.3 HNSW indexes and parameters

| Item | Where | Value |
|---|---|---|
| Index DDL `hnsw (embedding vector_cosine_ops)` | `src/core/vector-index.ts:24`, `src/schema.sql:408` | Default HNSW build params (m=16, ef_construction=64 in pgvector). Not overridden in DDL. |
| Max dims for HNSW, `vector` | `src/core/vector-index.ts:20-21, 27-35` | 2000. Above this, no index: exact scan only. |
| Max dims for HNSW, `halfvec` | `src/core/vector-index.ts:21, 35` | 4000. |
| `hnswIndexExpected(type, dims)` | `src/core/vector-index.ts:57-58` | Gates whether an index is built and whether the planner-check reports missing index. |
| `hnsw.ef_search` default | `src/core/vector-index.ts:124-125` | 40 (pgvector default). Ceiling 1000 (`HNSW_EF_SEARCH_MAX`). |
| `hnsw.ef_search` per query | `src/core/vector-index.ts:136-140` (`hnswEfSearchFor(n) = min(max(n, 40), 1000)`) | Sized to the candidate window. |
| `hnsw.iterative_scan` | `src/core/search/hnsw-iterative-scan.ts:1-30` | Modes `relaxed_order` (default), `strict_order`, `off`. Env `GBRAIN_HNSW_ITERATIVE_SCAN` or config `search.hnsw_iterative_scan`. |
| `hnsw.max_scan_tuples` | `src/core/search/vector-settings.ts:16, 31-32` | 20000 when iterative. |
| Settings applied per statement | `src/core/search/vector-settings.ts:16-33`; `src/core/postgres-engine/search-settings.ts:53-57` (`set_config(..., true)` in one transaction) | Transaction-local. |
| Requires pgvector >= 0.8 for iterative scan | `src/core/search/vector-settings.ts:~36-38` (`supportsHnswIterativeScan`) | Version check on the extension. |
| Index build memory: `maintenance_work_mem` set from row count (PGLite) | `src/core/vector-index.ts:66-120` (`PGLITE_HNSW_GRAPH_BUDGET_BYTES` = 1536 MB) | PGLite holds the whole graph in memory during build. |
| Concurrent rebuild `CREATE INDEX CONCURRENTLY` + temp name + swap | `src/core/vector-index.ts:250-303` | Zombie-index cleanup at `:169-243`. |
| Index bloat/prewarm (`shared_buffers` advice) | `src/core/vector-prewarm.ts:78-106, 152` | Reads `pg_relation_size` for hnsw indexes. |

Parity note: HNSW is approximate. The results of a Rust HNSW crate will not equal pgvector's. The code already has an exact fallback (`src/core/search/exact-scan.ts`, `src/core/search/exact-lookup.ts`, and `exact` flag in `vector-statement.ts:401`) and a recall-aware `hasMore` witness. Tests that compare ordering should compare against the exact path, not against pgvector's output.

#### 1.4 Dimension changes, reindex, and model switches

| Item | Where |
|---|---|
| Dim check at connect/doctor: parse `vector(N)` / `halfvec(N)` from `format_type` | `src/core/embedding-dim-check.ts:142-157, 587-594` |
| Recipe on mismatch: drop index, `UPDATE ... SET embedding = NULL`, `ALTER COLUMN TYPE vector(N)`, recreate index | `src/core/embedding-dim-check.ts:252-272`, `:620-660` (halfvec / vector swap is "same-dim cast, lossless") |
| Migration to match takes dim to config | `src/core/schema-migrations/v142-takes-embedding-dimension-matches-config.ts:18-46` |
| Embedding migration (re-embed) | `src/core/embedding-migration.ts` (60 matches), `src/core/embedding-migration-*.ts` |
| Mismatch error from pgvector `expected N dimensions, not M` | `src/core/embedding-dim-check.ts:786` |

Embedded replacement: the current design relies on `ALTER COLUMN TYPE` and index re-creation. In a Rust store the column is just a blob with a dimension field per table or per index, so dim-change is a rebuild. Parity risk: the "keep embeddings, change dims" recipe offered to users (`embedding-dim-check.ts:178`) is only valid if the new store can read old vectors.

#### 1.5 Embedding model and dimension sources

| Item | Where |
|---|---|
| Default model `voyage:voyage-4`, dims 1024 | `src/core/ai/defaults.ts:15-18` |
| Fallback `text-embedding-3-large` | `src/core/embedding.ts:115` |
| Per-model native dimensions table | `src/core/ai/types.ts:42-57` |
| Config `embedding_dimensions`, `embedding_model` | `src/core/ai/types.ts:495-499`, `src/core/ai/engine-gateway.ts:76-78` |
| Embedding guard / cost | `src/core/ai/embedding-guard.ts` |
| Chunk-level model column `content_chunks.model` default `text-embedding-3-large` | `src/schema.sql:361` |

Multiple models: chunks carry `model` and `embedding_model` / `embedding_input_hash` (`schema.sql:361, 380`). Facts have `embedding_model` with partial index `idx_facts_embedding_model` (`src/core/schema-migrations/v237-facts-question-recall-indexes.ts:40`). Search filters by model where relevant (`facts.ts:605`). Only one vector column per table is queried at a time (`embedding-column.ts` descriptor picks the column; modality filter `cc.modality = 'image'` at `vector-statement.ts:377`).

#### 1.6 Vector result shaping (not SQL, but affects parity)

- Per-page pooling and candidate windows: `src/core/search/vector-pool.ts` (146 lines), `src/core/search/vector-statement.ts:404-510` (`ORDER BY score DESC NULLS LAST, page_id ASC, chunk_id ASC`, line ~508).
- Overfetch factor for index walk: `vector-statement.ts:~418`; `hnsw_candidates` limit `innerLimitParam * overfetch`.

Rust embedded replacement candidates for vectors:

| Candidate | Fit | Tradeoffs / parity risk |
|---|---|---|
| sqlite-vec (`vec0` virtual table, `vec_distance_cosine`) on SQLite (rusqlite) | Exact kNN is straightforward. Keeps one embedded DB file. | Exact brute-force by default; ANN indexing status must be verified for the version pinned. Distance formula must match pgvector cosine (`1 - cos`), and f32 vs f16 storage differs. |
| usearch (C++ with Rust bindings), hnsw_rs, instant-distance | HNSW with cosine metric. | Approximate; recall differs from pgvector at the same ef. Needs its own persistence and must be kept consistent with rows (delete/update semantics, tombstones). Filtering after ANN (pgvector `iterative_scan` behaviour) must be reimplemented. |
| hora | HNSW / IVF-like. Less active. | Maintenance risk. |
| LanceDB / lance | Columnar vector store with ANN indexes (IVF-PQ, HNSW). | Heavier dependency; async API; filter-with-ANN semantics differ; no SQL. |
| DuckDB with VSS extension | SQL-compatible, HNSW via extension. | Extension stability and HNSW persistence concerns; not in-process-light. |
| Exact brute-force over f32 arrays in Rust (SIMD) | Simplest, exact. | Fine for small brains; scales linearly. Parity-perfect with exact pgvector ordering (up to float rounding). |
| halfvec replacement: store f16 (`half` crate) | Keeps disk size same as halfvec. | Rounding differs from pgvector halfvec cosine; rank ties may flip. |

Recommended parity test: compare the top-k of the Rust path against `vector_cosine_ops` exact order on a fixture (the `exact` branch already exists as a reference).

---

### 2. Full-text search

#### 2.1 Columns, indexes, and triggers

| Object | Where | Notes |
|---|---|---|
| `pages.search_vector tsvector` | `src/schema.sql:1183` (`ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector`) | Page-grain keyword vector: title (A), timeline (C), timeline_entries (C). |
| `idx_pages_search` GIN on `pages.search_vector` | `src/schema.sql:1185` | |
| `idx_pages_title_search` GIN on `ts_filter(search_vector, '{a}')` | `src/schema.sql:1187` (also `pglite-schema.generated.ts:662`) | Expression GIN, weight-A slice, used for title-only matches. `ts_filter` is a Postgres function (weight filter), not user-defined here. |
| `update_page_search_vector()` trigger function | `src/schema.sql:1196-1224` (also generated body in `src/core/fts-language.ts:197-223`) | `title` as weight A; first 65,536 chars of timeline (weight C); first 32,768 chars of joined timeline_entries (weight C). Comment at `:1190-1194` says the cap avoids the 1 MB tsvector limit. |
| Trigger `trg_pages_search_vector` | `src/schema.sql:1230-1234`; re-created by `src/core/page-state/projection-schema.ts` (`trg_pages_search_vector BEFORE INSERT OR UPDATE OF ...`, schema.sql:2685) | Column list in `UPDATE OF` depends on projection. |
| `content_chunks.search_vector TSVECTOR` | `src/schema.sql:394` | Chunk-grain. |
| `idx_chunks_search_vector` GIN | `src/schema.sql:418` | |
| `update_chunk_search_vector()` trigger (`NEW.search_vector := A(doc_comment,symbol_name_qualified) || B(chunk_text)`) | `src/schema.sql:444-458`; body generator `src/core/fts-language.ts:225-233` (`chunkSearchVectorTriggerFnSql`) and `:177-181` (`chunkSearchVectorSql`) | Trigger `chunk_search_vector_trigger`, `BEFORE INSERT OR UPDATE`. Note: the literal `'english'` in schema.sql:447-449 is rewritten by `applyFtsLanguagePolicy` (`fts-language.ts:105-111`). |
| `gbrain_fts_input(text)` (CJK/ASCII boundary spacer, regex) | `src/schema.sql:431-437`; source `src/core/fts-language.ts:143-150` | `regexp_replace` twice on CJK class `[一-鿿぀-ゟ゠-ヿ가-힯]` vs `[A-Za-z0-9]`. Applied before every `to_tsvector`. |
| `factsFtsDocument` / `idx_facts_fts` expression GIN on facts | `src/core/fts-language.ts:120-128` (`to_tsvector('<lang>'::regconfig, fact || ' ' || replace(entity_slug,'-',' '))`, partial index `WHERE expired_at IS NULL`) | The config must be a literal in the expression index. |

Trigger ordering and visibility: the chunk trigger does not re-run on embedding-only updates because it fires on `UPDATE OF` the text columns (comment at `schema.sql:439-443`). Rust must mirror: keyword vector recomputed only when `chunk_text`, `doc_comment`, or `symbol_name_qualified` changes.

#### 2.2 Text search configuration

| Item | Where |
|---|---|
| Config name from env `GBRAIN_FTS_LANGUAGE`, default `english` | `src/core/fts-language.ts:27, 55-75` |
| Validation `^[a-z][a-z0-9_]*$`, used for SQL interpolation | `src/core/fts-language.ts:27, 64-71` |
| Rewrite schema literal `to_tsvector('english',` to chosen config | `src/core/fts-language.ts:105-111` |
| Per-language reindex with marker key `fts.reindex_in_progress` | `src/core/fts-language.ts:38`; command `src/commands/reindex-search-vector.ts` (29 matches) |
| Migration that stamped trigger functions | `src/core/schema-migrations/v123-configurable-fts-language.ts` |
| Page keyword vector SQL builder | `src/core/fts-language.ts:172-174` (`pageSearchVectorSql`) |
| Doc: multi-language FTS guide mentions unaccent + Portuguese stemmer config `pt_br` | `src/core/fts-language.ts:13-16` (refers to `docs/guides/multi-language-fts.md`) |

Important: the default is English Snowball stemming and English stop words. Changing `GBRAIN_FTS_LANGUAGE` changes stemming for all rows and requires reindex. An embedded Rust engine needs its own analyzer config and the same reindex trigger semantics.

#### 2.3 Query functions and ranking

| Function | Use | Where |
|---|---|---|
| `websearch_to_tsquery(cfg, q)` | Chunk keyword match (ASCII path) | `src/core/search/keyword-statement.ts:70-72`; `src/core/search/title-statement.ts:55-68` (`boundWebsearchQuery`, `gbrain_fts_input` wrapped) |
| `ts_rank(search_vector, tsq)` | Chunk score, times a phrase factor | `src/core/search/keyword-statement.ts:74` |
| `ts_rank_cd` (cover density) | Title match ranking | `src/core/search/title-statement.ts:68` |
| `ts_filter(search_vector, '{a}')` | Restrict to weight A (title) | `src/core/search/title-statement.ts:67-68`, `src/core/engine-sql/titles.ts:36` |
| `phraseto_tsquery` phrase boost (x2 factor, `KEYWORD_PHRASE_FACTOR = 2`) | `CASE WHEN vector @@ phraseto_tsquery(cfg, q) THEN 2 ELSE 1` | `src/core/search/sql-ranking.ts:477-483`; used when `opts.keywordPhrase` set (`keyword-statement.ts:74`) |
| Score factor per source/slug (`buildSourceFactorCase`) | `((rank) * factor)::float8` | `src/core/search/keyword-statement.ts:80-82` |
| Title OR variants (given-name variants `#7471`) | `(websearch_to_tsquery(...) || websearch_to_tsquery(...))` | `src/core/search/title-statement.ts:55-61` |
| Strict match, then OR fallback when strict is short | `src/core/search/keyword-statement.ts` (strict only for count), `src/core/search/keyword-or-narrow.ts`, `keyword-or-rarity.ts` | The keyword arm of hybrid runs OR fallback, direct callers strict. |
| Dedup to best chunk per page: `SELECT DISTINCT ON (page_id) ... ORDER BY page_id, score DESC, chunk_id ASC` | `src/core/search/keyword-statement.ts:150` | Keyset pagination after `(score DESC, page_id ASC)` at `:152-155`; `score` is float8 so cursors round-trip. |
| Keyword count capped at 10,000 + 1 | `src/core/search/keyword-statement.ts:35, 108-115` | |
| `ts_headline` | not used (0 matches) | Snippets come from chunk text. |

Ranking: `ts_rank` default normalization 0; weights D/C/B/A = 0.1/0.2/0.4/1.0 are Postgres defaults. The code does not pass a custom weight array (not found in `src/`). A Rust engine must compute the same per-lexeme term frequency and weight arithmetic to match ordering; BM25 will not match it numerically.

Hybrid (`src/core/search/hybrid.ts`, `hybrid/*`): keyword rank is only used as the list order in RRF; the raw `ts_rank` value does not reach fusion, except as a sort key inside each arm (`keyword-statement.ts:154`). So a BM25 engine that preserves the list order produces the same RRF fused ranking, but the per-page ranking within keyword arm and the `score` numbers exposed in `score_details` change.

#### 2.4 Tokenization and stemming

- Postgres parser + Snowball English stemmer + English stop words (default config). Behaviour of `to_tsvector('english', ...)`: lowercase, stop-word removal, Porter2-style stemming, numbers and emails tokenized by the default parser. Exact token boundaries differ from any Rust tokenizer. Example differences: hyphenated words, URLs, and `Redis7`-style mixed alnum (the code splits CJK/ASCII boundaries with `gbrain_fts_input` precisely because the Postgres parser keeps `升级PostgreSQL17` as one lexeme, see `fts-language.ts:132-142`).
- Caps: tsvector lexeme strings max 1 MB; page vector truncated to 65,536 + 32,768 characters (`fts-language.ts:157-162`). Text beyond the cap is not keyword-searchable (chunks still are). Parity-relevant: a Rust engine that indexes the full timeline would return extra keyword hits.
- Sanitization: page timeline is sanitized before indexing ("never the raw column ... private or withdrawn fence text", `fts-language.ts:166-171`).

#### 2.5 CJK keyword search

| Item | Where |
|---|---|
| Detect CJK: `CJK_SLUG_CHARS = 一-鿿 ぀-ゟ ゠-ヿ 가-힯` | `src/core/cjk.ts:19-21, 74-76` |
| CJK terms split on whitespace, Korean particle stripped | `src/core/cjk.ts:207-210, 248-250` |
| CJK chunk predicate: every term as `LIKE` (caseless) or `ILIKE`, `ESCAPE '\\'`, joined with AND | `src/core/search/keyword-statement.ts:56-63`; `src/core/search/cjk-keyword-sql.ts` (header 1-20) |
| CJK ranking: term frequency `(len - len(replace(text, term, ''))) / len(term)`, sum across terms, plus contiguous-phrase bonus and `position()` tiebreak | `src/core/search/keyword-statement.ts:64-67`; `src/core/search/cjk-keyword-sql.ts:1-20` |
| CJK full path, OR fallback when strict falls short (`orFallback`, `#6043`) | `src/core/engine-sql/cjk-search.ts:15-18, 91-94` |
| Candidate cap `CJK_CANDIDATE_CAP = 2000` (capped unordered LIKE scan) | `src/core/engine-sql/cjk-search.ts:55` |
| PGLite capped path after `PGLITE_CJK_CAPPED_CHUNKS = 50,000` (planner `reltuples`) | `src/core/engine-sql/cjk-search.ts:56, 150-153, 169-178` |
| Deadline split: 2/3 full scoring, 1/3 capped retry; statement_timeout via `set_config` | `src/core/engine-sql/cjk-search.ts:112-148, 182-188` |
| Doc: "ILIKE scan ... not index-accelerated; install pgroonga or zhparser" | `src/core/engine-sql/cjk-search.ts:35-38` |

Key facts: the CJK path does not use `tsvector` at all. It is a substring scan. Ranking is term-frequency arithmetic, which is reproducible exactly in Rust (use char-count semantics; note `LENGTH()` on text counts characters, not bytes). `ILIKE` case-folding on CJK characters is a no-op, but on mixed Latin terms it is locale/ASCII-based in Postgres; SQLite's `LIKE` is ASCII case-insensitive only. A Rust engine must lowercase per Postgres ILIKE rules or match only ASCII folding, and check that term.toLowerCase()===term.toUpperCase() routing (`keyword-statement.ts:61`) is preserved.

Rust candidates for CJK:

| Candidate | Fit | Risk |
|---|---|---|
| FTS5 `trigram` tokenizer (SQLite) | Substring match over any script; works for CJK (3-grams). | Trigram needs >=3 chars; 1-2 char CJK terms (common in Chinese/Japanese) would not match via the index; must fall back to LIKE. Case-folding only ASCII. |
| tantivy with `lindera` (Japanese, Korean) or `jieba-rs` (Chinese) tokenizer | Real word segmentation, BM25. | Segmentation output differs from the current substring behaviour (`升级` vs `升级PostgreSQL`). Ranking is BM25, not the TF formula. Different recall. |
| Keep the substring scan in Rust over the chunk table (exact replica of ILIKE + TF formula) | Exact parity with the current behaviour. | No index; O(corpus) per query. Current code already has a capped mode for large corpora. |

#### 2.6 Rust FTS candidates

| Candidate | Maps to | Parity notes |
|---|---|---|
| SQLite FTS5 (rusqlite `bundled`) with `porter` over `unicode61` | `tsvector` + `websearch_to_tsquery` (via custom parser) + `ts_rank` (via `bm25()`) | FTS5 `porter` is Porter (not Snowball English): stems differ on some words. Stop words are not removed by default. Positions and per-column weights exist via `bm25(t, w1, w2, ...)` (column weights, not per-lexeme weights). Phrase search is native (`"..."`). OR/AND/NOT syntax differs from websearch syntax: must translate. |
| tantivy | BM25 index with stemmer (English), custom analyzers, lindera/jieba. | BM25 score != ts_rank. Query syntax needs translation (tantivy query parser vs websearch). Multi-field boost replaces setweight. Per-document 1 MB cap does not exist, so truncation must be done explicitly. |
| DuckDB FTS extension | BM25 in SQL. | Extension stability; BM25 variant differs. |
| Hand-rolled inverted index in Rust over redb or fjall | Full control of tokenization and TF scoring. | Largest effort; must rebuild on each config change; must mirror `ts_rank` normalization exactly if scores are exposed. |

Recommended for ranking parity: keep `ts_rank`-like scoring in Rust (own TF/weight formula on the same token stream), because downstream code reads score values and phrase factor (x2), source boosts, and RRF weights. If scores are not exposed to agents, BM25 is acceptable and only list order matters for RRF.

---

### 3. pg_trgm (fuzzy title/slug matching)

| Use | Where | Notes |
|---|---|---|
| Extension | `src/schema.sql:4` | |
| GIN trigram index on `pages.title` (`idx_pages_trgm`) | `src/schema.sql:282` | |
| GIN trigram index on `pages.slug` (`idx_pages_slug_trgm`) | `src/schema.sql:286` | |
| Fuzzy title lookup `similarity(title, $partial)` with `title % $partial OR slug ILIKE '%partial%'`, ORDER BY sim DESC LIMIT 5 | `src/core/engine-sql/pages.ts:775-786` | Used for fuzzy slug resolution. |
| Fuzzy title match by name: `title % name`, `similarity(title,name) >= minSimilarity` (default 0.55), tie-break by slug | `src/core/engine-sql/pages.ts:989-1030` | Comment at `:990-992`: `%` lets the GIN index prune candidates when the threshold is at least pg_trgm default 0.3; below 0.3 the explicit comparison runs. |
| `dirPrefix` LIKE filter (`slug LIKE 'prefix/%'`) | `src/core/engine-sql/pages.ts:1006-1008` | |
| Title-match module | `src/core/search/title-match.ts` (153 lines), `src/core/engine-sql/titles.ts` (145 lines) | Also uses `websearch` FTS (see section 2). |
| Entity resolution | `src/core/entities/resolve.ts` (17 matches for similarity-like SQL) | Not verified line-by-line in this pass. |

Semantics to reproduce: pg_trgm similarity = |trigrams(a) ∩ trigrams(b)| / |trigrams(a) ∪ trigrams(b)|, with words lowercased, non-alnum splitting, each word padded with two leading spaces and one trailing space. `word_similarity` is not used (0 matches). `%` uses the global `pg_trgm.similarity_threshold` (default 0.3), which is a session GUC: a Rust implementation must pin the same threshold or it will return different candidate sets. The code relies on the `%` pre-filter only as an optimization, so for `minSimilarity >= 0.3` a brute-force Rust similarity over all titles gives the same winners, provided the tie-break is replicated (`ORDER BY sim DESC, slug`).

Rust candidates:
- Implement trigram similarity directly over an in-memory or indexed trigram table (small: titles and slugs). Exact, no extension needed.
- Alternatively use an FTS5 trigram tokenizer plus a Jaccard computation in code. Parity risk: FTS5 trigram tokenizer does not pad words the same way as pg_trgm.
- `strsim` crate has Jaro/Levenshtein, not pg_trgm trigram Jaccard; do not use it as a drop-in.

---

### 4. JSONB

#### 4.1 Columns and where JSONB is stored

| Column | Where |
|---|---|
| `pages.frontmatter JSONB NOT NULL DEFAULT '{}'`, GIN `idx_pages_frontmatter` (jsonb_ops, default) | `src/schema.sql:112, 281` |
| `sources.config JSONB NOT NULL DEFAULT '{}'::jsonb` | `src/schema.sql:32` |
| `gbrain_try_jsonb(text) -> jsonb` (returns NULL on invalid JSON) | `src/schema.sql:60-67` |
| `links.edge_metadata JSONB`, `links` uniqueness `NULLS NOT DISTINCT` | `src/schema.sql:479, 503, 582-583` |
| `raw_data.data JSONB`, `timeline` / `page_versions.frontmatter JSONB` | `src/schema.sql:635, 683` |
| `minion_jobs.data`, `result`, `progress`, `stacktrace JSONB DEFAULT '[]'`, `submission_authority JSONB` | `src/schema.sql:1254-1276` |
| `op_checkpoints.completed_keys JSONB` with `jsonb_typeof = 'array'` CHECK | `src/schema.sql:884-885` |
| `facts`/`takes` JSON fields, `mcp_request_log.params` | `src/schema.sql:757` |
| `oauth_clients.federated_read` GIN (jsonb ops) | `src/schema.sql:809` |
| `calibration_profiles.active_bias_tags` GIN | `src/schema.sql:1683` |
| `grant_audit.before_grant/after_grant JSONB` | `src/schema.sql:819-820` |
| `persistence_*` JSONB columns | `src/schema.sql:2401-2640` (generated region) |

#### 4.2 Operators and functions used

| Feature | Where | Behaviour |
|---|---|---|
| `@>` containment (frontmatter filter) | `src/core/search/frontmatter-where.ts:1-20` | `p.frontmatter @> $n::text::jsonb` per accepted form; matches scalar equality or list containment (a list field contains a value). Served by GIN `idx_pages_frontmatter`. A string like "2024" also matches the number 2024 (adds JSON number form). |
| `->>` extraction | `src/core/engine-sql/pages.ts` (`message_id`), `src/core/search/keyword-statement.ts:145-160` (`p.frontmatter->>'message_id'`, `'thread_id'`, `'subject'`) | Text extraction, NULLIF for empty. Regex trim `regexp_replace(..., '^[[:space:]]+|[[:space:]]+$', '', 'g')`. |
| `jsonb_set`, `jsonb_agg`, `jsonb_build_object`, `jsonb_typeof`, `jsonb_array_elements(_text)`, `jsonb_to_recordset` | Widely used (see counts); e.g. `src/core/batch-rows.ts:1-20` (bulk insert via `jsonb_to_recordset(($1::jsonb)->'rows')` to avoid array literal problems), `src/core/schema-migrations/*`, `src/commands/repair-jsonb.ts` (28 matches) | `jsonb_build_object` is used to build DETAIL strings in trigger error messages (`src/schema.sql:323`). |
| `jsonb_path` | 9 matches; examples in `src/commands/repair-jsonb.ts` and `src/core/` (not reviewed one by one) | |
| `?` / `?|` key existence | 0 matches | Not used. |
| `jsonb_path_query` family | not separately verified | |
| `gbrain_try_jsonb` | `src/schema.sql:60-67` | Portable `text -> jsonb` with NULL on error (`#7112`). |

Rust note: JSON stored as TEXT in SQLite with `json_extract`/`json_each`, or as `serde_json::Value` in a KV store. Containment `@>` must be re-implemented (no built-in). Key ordering in `jsonb` is canonical (sorted, no duplicates); `json` is not. Any code that compares or hashes frontmatter must canonicalize. Number vs string equality: Postgres `jsonb` numeric `2024` and string `"2024"` are different; the code handles both forms explicitly.

#### 4.3 Index and performance

- Only `pages.frontmatter` has a GIN index. `sources.config`, `links.edge_metadata`, and the job tables do not.
- The frontmatter filter is ANDed into keyword/vector WHERE clauses (`keyword-statement.ts:96`, `title-statement.ts` filters at ~`:70-80`).

---

### 5. Recursive CTEs (graph and walks)

| Use | Where | Behaviour |
|---|---|---|
| BFS by layers over links (`bfsWalkCtes`), `visited` array via `bfs.visited || n.next`, depth bound `maxLayer`, `DISTINCT` on frontier | `src/core/engine-sql/links.ts:595-645` (comment at `:595-603`: "each recursive row is one whole BFS layer ... simple paths"); `links.ts:673` (`WITH RECURSIVE ${bfsWalkCtes(...)}` for traverse-by-depth) | Replaces a per-path CTE that took 22 s on a 12-page clique at depth 5 (`:603`). |
| `walk(id, depth, pos)` with `row_number() OVER (ORDER BY b.depth, u.ord)`, row cap | `src/core/engine-sql/links.ts:645`; cap `TRAVERSE_WALK_ROW_CAP = 20000` (`src/core/engine-constants.ts:48`) | Ordering is depth then insertion order `u.ord`. Cap cut point depends on `pos` ordering: parity-sensitive. |
| Edge extraction at depth < depth, one-past-shallower endpoint rule | `src/core/engine-sql/links.ts:714-809` | Returns each edge once with depth+1; sorts by `depth, from_slug, to_slug, from_source_id, to_source_id` (`:786`). Dedup key `from|to|type|depth` (`:799`). |
| `get_links`/`get_backlinks` neighbour expansion | `src/core/engine-sql/links.ts` (30 matches) | Not individually reviewed. |
| Retirement chain fold (`chain` CTE, hop cap `MAX_RETIREMENT_HOPS = 5`) | `src/core/engine-sql/graph-rank.ts:123-160`; constant `src/core/entities/resolve.ts:217` | Uses `DISTINCT ON (c.start_id) ... ORDER BY c.start_id, c.hop` to pick the shallowest fold target (`graph-rank.ts:138`). |
| Rank entities aggregate (`edges`, `ends`, `neighbors`) | `src/core/engine-sql/graph-rank.ts:120-185` | `DISTINCT` triples, `MATERIALIZED` CTEs, `NULLS`/`IS DISTINCT FROM` on mention links. Cost ~3 s for 200k pages and 985k links on Postgres 16 (`:33-34`). |
| Read enrichment backlink walk | `src/core/search/read-enrichment.ts:54` | |
| Source config recursion | `src/core/source-config-sql.ts:15` | |
| Page-type pairs | `src/core/onboard/checks.ts:667` | |
| Stale-chunk occurrence walk | `src/core/page-body/projection.ts:66` (`STALE_CHUNKS_SQL`) | |
| Minion job tree / cancel / descendants | `src/core/minions/job-insight.ts:204`, `src/core/minions/authorize-legacy.ts:57`, `src/core/minions/queue.ts:1061`, `src/core/minions/legacy-cancel.ts:42` | Parent/child job trees. |
| Capacity forecast walk | `src/core/persistence/capacity-forecast.ts:118` | |
| Terminal lineage | `src/core/persistence/terminal-classify.ts:489` | |

Rust replacement: SQLite supports `WITH RECURSIVE` with `UNION ALL`, but not array `||`/`ANY` or `row_number` tie semantics identical to PG for `ORDER BY ... u.ord`. The cycle guard in the code is an array `visited` (`links.ts:627-632`). In Rust, BFS in code with a `HashSet` is simpler and faster. Parity points: the layer order, the row cap (which rows are kept when the cap hits), and the "one-past-shallower endpoint" depth rule.

---

### 6. Other SQL features that an embedded store must emulate

#### 6.1 Upsert, returning, and uniqueness

| Feature | Count / key sites | Notes |
|---|---|---|
| `INSERT ... ON CONFLICT ... DO UPDATE` (upsert) | very widespread (`ON CONFLICT` ~459 line matches across `src/`); examples `src/core/engine-sql/pages.ts`, `links.ts`, `facts.ts`, `takes.ts` | SQLite supports UPSERT (3.24+). Must check `DO UPDATE ... WHERE` and `EXCLUDED.` semantics. |
| `RETURNING` | ~545 line matches | SQLite 3.35+ supports RETURNING. |
| `UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)` | `src/schema.sql:579-583` (PG15+). Also `link_transitions` at `src/schema.sql:3336`. | **Parity risk**: SQLite (and PG default) treat NULLs as distinct in UNIQUE. The Rust store must enforce NULL-equal uniqueness in code or with a COALESCE expression index. |
| `UNIQUE (origin_page_id, producer, ref_kind, target_source_id, target_ref)` | `src/schema.sql:605-608` | |
| Composite keys with `source_id` | throughout (`pages.source_id`, `links`) | |

#### 6.2 Batch patterns: ANY, UNNEST, jsonb_to_recordset

| Pattern | Where |
|---|---|
| `col = ANY($n::text[])`, `p.type = ANY(...)`, `p.slug != ALL(...)` | `src/core/search/keyword-statement.ts:95, 97, 101`; `title-statement.ts` |
| `unnest($n::text[])` bulk insert (older; replaced for free text) | ~287 line matches `unnest(`. The batch helper explains why the array literal approach was replaced (`src/core/batch-rows.ts:1-20`). |
| `jsonb_to_recordset(($1::jsonb)->'rows')` bulk insert | `src/core/batch-rows.ts:1-20` (used by `addLinksBatch`, `addTimelineEntriesBatch`, `addTakesBatch`) |
| Bind-parameter cap (65535) motivates batch JSON | `src/core/batch-rows.ts:1-20` |

Rust: plain prepared statements in a transaction are sufficient; the array-literal parse issue does not exist in a native binding.

#### 6.3 Window functions, DISTINCT ON, LATERAL, FILTER, GROUPING

| Feature | Count (line matches) | Key sites |
|---|---|---|
| `DISTINCT ON` | 43 | `src/core/search/keyword-statement.ts:150` (best chunk per page), `src/core/engine-sql/graph-rank.ts:138` (fold target). Replace with `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) = 1`. |
| Window `OVER (...)` | 37 | `row_number()` at `src/core/engine-sql/links.ts:645`; SQLite supports window functions since 3.25. |
| `LATERAL` | 117 | Mostly in `vector-statement.ts:~430-445` (`CROSS JOIN LATERAL (SELECT ... OFFSET 0)` key probes behind `OFFSET 0` fences, #6728). SQLite has no LATERAL; rewrite as correlated subquery or join with the planner forced by the Rust code. |
| `FILTER (WHERE ...)` aggregate | 253 | Used across aggregates; SQLite supports `FILTER` (3.30+). |
| `GROUP BY ... GROUPING SETS` | 6 | Not studied in depth. |
| `string_agg` | 25 | `src/core/schema-migrations` and `src/core/belief/*`; `summary || ' ' || detail` in the trigger (`fts-language.ts:206`). SQLite has `group_concat` with ordering caveats (no ORDER BY inside group_concat before 3.44). |
| `MATERIALIZED` CTE hints | 65 | Planner fences only; no semantic effect in a new engine. |

#### 6.4 Generated and identity columns, sequences

| Feature | Where | Notes |
|---|---|---|
| `SERIAL` / `BIGSERIAL` primary keys | many (e.g. `src/schema.sql:100` `sources.id SERIAL`, `:355` `content_chunks.id SERIAL`, `:596` `BIGSERIAL`) | Integer ids are visible to users in cursors and some CLI output; keep numeric ids. SQLite `INTEGER PRIMARY KEY` (rowid) is the analogue; `AUTOINCREMENT` differs in reuse behaviour. |
| `page_generation_clock_seq` sequence + `GREATEST` seed | `src/schema.sql:253-275` | Monotonic counter via sequence `last_value`; a Rust engine needs an equivalent monotonic counter that survives replay. |
| `UUID DEFAULT gen_random_uuid()` | `src/schema.sql:736`, `:1531`, `:2404`, `:2410`, `:2856-2862` | Replace with Rust `uuid` v4. |
| `GENERATED ALWAYS AS (COALESCE(staging_id, '00000000-...')) STORED` | `src/schema.sql:2195` (page-body staging key) | SQLite generated columns (3.31+) support STORED. Must reproduce the sentinel UUID. |
| `GENERATED ALWAYS AS (octet_length(files::text)+octet_length(metadata::text)) STORED` | `src/schema.sql:2889` | `octet_length` of text is UTF-8 byte length; SQLite `length()` is characters: use `length(CAST(x AS BLOB))`. |
| `gbrain_count_modifications` statement triggers with `REFERENCING NEW TABLE` | `src/core/planner-stats-schema.ts:24-51` (PGLite only) | Transition tables are not in SQLite; use per-row triggers or app-level counters. |

#### 6.5 Timestamps and interval math

- Columns are `TIMESTAMPTZ` with `DEFAULT now()` (e.g. `src/schema.sql:31, 44, 57, 112-140`). `interval` appears about 826 times as literal intervals (`INTERVAL '72 hours'` in `src/schema.sql:292`, `make_interval`, `now() - interval`). Count is over `src/` and includes TS string literals.
- `COALESCE(p.effective_date, p.updated_at, p.created_at)` used as the date axis in keyword filters (`keyword-statement.ts:98`), with `::text::timestamptz` cast on bound ISO strings (`:99-100`).
- `EXTRACT(` 48 matches; `date_trunc` 10 matches (`src/core/persistence/*` and eval).
- `NOW()` 89 matches.

Rust replacement: store timestamps as integer microseconds or RFC 3339 text in UTC. Parity risks: PG microsecond precision, `now()` is transaction-start time (not statement time), and comparisons of text timestamps must be on normalized UTC strings. `interval` arithmetic needs a small date-math module (`time` or `chrono`).

#### 6.6 Regex and string operators

| Feature | Where | Notes |
|---|---|---|
| `regexp_replace(..., 'g')` | `src/core/fts-language.ts:146` (CJK boundary), `src/core/search/keyword-statement.ts:145` (trim), `src/core/engine-sql/pages.ts`, `src/schema.sql:283` (`regexp_replace(slug, '^.*/', '')` in an expression index for basename lookup) | Needs a Rust regex (`regex` crate) or SQLite `REGEXP` registered function. POSIX class `[[:space:]]` needs translation. |
| `~` (POSIX match) | `src/schema.sql:560` (`link_source ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`), `src/core/fts-language.ts:149` (`FTS_CJK_BOUNDARY_REGEX`) | CHECK constraint must be enforced in Rust at write time. |
| `LIKE ... ESCAPE '\'` | `src/core/engine-sql/pages.ts:510`, `keyword-statement.ts:61`, `cjk-search.ts` | SQLite supports `ESCAPE`; case-folding differs for non-ASCII. |
| `ILIKE` | 44 matches | SQLite has no ILIKE: emulate with `lower(x) LIKE lower(y)` (ASCII-only lower in SQLite) or a Rust function. |
| `COLLATE` | 32 matches | Check for `"C"` vs locale collations used in ORDER BY; mismatch changes sort order for mixed case. |
| `char_length`, `LENGTH`, `REPLACE`, `position` | `src/core/search/cjk-keyword-sql.ts` | `LENGTH()` counts characters in PG; SQLite `length()` counts characters for TEXT too, but BLOB differs. |
| `unaccent` | 1 match (doc only, `src/core/fts-language.ts:13`) | Not installed in the schema. Multi-language docs suggest unaccent in custom configs. |
| `citext` | 0 | Not used. |

#### 6.7 Advisory locks, row locks, and concurrency primitives (affects the embedded store design)

| Feature | Count | Where |
|---|---|---|
| `pg_advisory_lock` / `pg_try_advisory_xact_lock` | ~49 matches | `src/core/db-lock.ts`, `src/core/persistence/*`, `src/core/cycle/*`. Used for cross-process write locks. |
| `FOR UPDATE SKIP LOCKED` | ~31 | `src/core/minions/queue.ts` (job claim). |
| `FOR UPDATE` | ~225 | Many (queues, sync). |
| `SET LOCAL statement_timeout` | `src/core/engine-sql/cjk-search.ts:138`, `src/core/vector-prewarm.ts:152`, `src/core/search/vector-settings.ts` | Per-query deadlines (`statement_timeout` via `set_config`). An embedded engine needs an interrupt-based equivalent (e.g. SQLite progress handler / `sqlite3_interrupt`). |
| `pg_stat_activity` probes | `src/core/vector-index.ts:169-243` (zombie CREATE INDEX detection) | Replaced by a single-process lock in the embedded engine. |

#### 6.8 Planner statistics and ANALYZE

| Item | Where | Notes |
|---|---|---|
| Row-delta planner stats for PGLite (no autovacuum): triggers record modification counts in `planner_stats_deltas`, state in `planner_stats_state` | `src/core/planner-stats-schema.ts:1-51` (tables `pages`, `links`, `facts`, `takes`, `content_chunks`, `timeline_entries`) | PG keeps autovacuum; triggers only applied to PGLite (`sqlFor.pglite`). |
| Threshold `max(500, 10% reltuples)` | `src/core/planner-stats.ts:100-101` | Decides when to ANALYZE. |
| Per-table ANALYZE + watermark publication | `src/core/planner-stats.ts:103-135` (`has_stats`, `stale`), `:137-161` (expression-index stats) | |
| `hnsw` plan proof, `vector_plan` doctor check | `src/commands/doctor/checks/vector-plan.ts` (32 matches) | Checks that the vector query uses the HNSW index. Not portable as-is; a Rust engine would test the chosen path (index vs exact) instead. |
| `reltuples` used as a corpus-size proxy | `src/core/engine-sql/cjk-search.ts:150-153` | The PGLite CJK capping decision (`PGLITE_CJK_CAPPED_CHUNKS`). Rust should use its own row count. |
| Planner GUC tweaks | `src/core/postgres-engine/jit-off-statement.ts` (jit off), `search-settings.ts` | Not needed in embedded. |

Rust replacement: SQLite `ANALYZE` exists and writes `sqlite_stat1`, but the planner fences (`OFFSET 0`, `MATERIALIZED`) exist only to stop the PG planner from making bad choices. A new engine should not replicate them; it should keep the observable result (same rows, same ordering, same caps).

---

### 7. Hybrid search and fusion (`src/core/search/hybrid*`)

| Item | Where | Notes |
|---|---|---|
| RRF constant `RRF_K = 60` | `src/core/search/hybrid.ts:58` | Default; override via `rrfK`. |
| Pipeline comment | `src/core/search/hybrid.ts:2-9` | Keyword + vector -> RRF -> normalize -> boost -> cosine rescore -> dedup. Compiled-truth boost 2.0x (`:8`). Cosine blend 0.7 rrf + 0.3 cosine (`:9`). |
| `rrfFusion`, `rrfFusionWeighted` | `src/core/search/hybrid.ts:1456-1545` | Divide by observed max; then boost. Weighted form `w / (k + rank)`. |
| Per-list accumulation with page-level vote key `(source_id, slug)` | `src/core/search/rrf-page-fusion.ts:19-80` (`rrfPageKey` at `:31-33`, `w / (k + rank)` at `:80`) | Lead chunk carries the page's summed score. |
| Pre-fusion candidate floor | `src/core/search/hybrid.ts:61-80` (`D-3002`) | Keeps the pool deep enough for RRF. |
| Fusion list composition with budget normalization | `src/core/search/fusion-lists.ts:1-30, 65-80, 174-235` | |
| Keyword arm + OR fallback + CJK arm (deadline) | `src/core/search/hybrid/arms.ts` (568 lines, 66 matches) | |
| Vector arm pooling | `src/core/search/vector-pool.ts`, `src/core/search/hybrid/arms.ts` | |
| Page-level RRF (`rrf-page-fusion.ts`) | yes | |
| Dedup | `src/core/search/dedup.ts` | |

RRF is pure arithmetic in JS: it ports unchanged to Rust. Parity depends only on the order each arm returns. Keyword order = `score DESC, page_id ASC` (`keyword-statement.ts:152-155`). Vector order = `score DESC NULLS LAST, page_id ASC, chunk_id ASC` (`vector-statement.ts:508`). Tie-breaking must match these or RRF rank numbers shift.

---

### 8. Feature-to-user-visible-behaviour map

| Feature | User-visible effect |
|---|---|
| `websearch_to_tsquery` + `ts_rank` | `search`/`query` keyword ranking, `keyword_total` count, cursor pages |
| `ts_rank_cd` on weight-A slice | Title match ranking, `get_page` title fuzzy |
| CJK ILIKE + TF scoring | Chinese/Japanese/Korean keyword hits |
| `pg_trgm similarity` | Fuzzy slug/title resolution (`resolveSlug` fallback), entity matching, `put_page` auto-link reconciliation |
| HNSW cosine | Semantic search ordering, `hasMore`, recall-dependent results |
| `iterative_scan` | Filtered vector search completeness |
| RRF | Final hybrid ordering |
| `frontmatter @>` | `--where key=value` filter on search/query/list |
| Recursive BFS + caps | `traverse`, neighbour graph, `rank_entities` |
| `NULLS NOT DISTINCT` uniqueness | Duplicate link suppression |
| Row-delta ANALYZE | Only performance (and plan-proof doctor checks) |

---

### Parity risks noted

1. ts_rank vs BM25: scores exposed in `score_details` and used for phrase factor (x2) and source-boost multiplication (`keyword-statement.ts:74-82`) will change if BM25 is used. Only list order survives into RRF.
2. Postgres English Snowball stemmer and stop words vs FTS5 porter / tantivy English stemmer: different stems and stop words; query results differ for some terms. Keep config name `GBRAIN_FTS_LANGUAGE`, and rebuild indexes on change.
3. `gbrain_fts_input` CJK/ASCII boundary spacing (`fts-language.ts:143-150`) must be reproduced exactly before tokenization or `Redis7` / `升级PostgreSQL17` queries break (#6370).
4. tsvector 1 MB cap is enforced by truncating page text to 65,536 + 32,768 characters (`fts-language.ts:161-162`, `schema.sql:1222-1224`). A Rust index without the same truncation returns extra hits; with truncation it matches.
5. Chunk search_vector trigger fires only on text columns (`schema.sql:439-443`); a Rust writer must not recompute keyword vectors on embedding-only updates, or ordering changes when only vectors change (not parity-visible but costly).
6. `websearch_to_tsquery` syntax (quoted phrases, `or`, `-negation`) must be re-implemented by translation; `plainto_tsquery` / `phraseto_tsquery` (6 and 3 matches) are used for phrase factor and need equivalents.
7. CJK ILIKE: case-folding and `LENGTH()` character counting must match (`cjk-keyword-sql.ts:1-20`, `keyword-statement.ts:56-67`). LIKE on SQLite is ASCII-only case-insensitive.
8. HNSW is approximate and the cosine metric is `1 - <=>`. Exact order from pgvector `vector_cosine_ops` is the reference; ANN crates will change top-k at the margin. Keep the exact path as a parity oracle (`exact-scan.ts`, `vector-statement.ts` exact variant).
9. `hnsw.ef_search` window = max(candidate, 40) capped at 1000 (`vector-index.ts:124-140`). A Rust ANN with a different knob will return a different candidate set at the same limit.
10. halfvec (f16) vs vector (f32) columns: rounding differs; the dim-change path swaps types losslessly for same-dim (`embedding-dim-check.ts:648-660`). Rust must keep the two storage types or accept the rounding difference.
11. pgvector dims: fresh-install DDL says `vector(1536)` (`schema.sql:360`) but the default model is 1024 dims (`ai/defaults.ts:16`). Dim is reconciled at connect (`embedding-dim-check.ts`). A Rust store must reproduce the reconciliation, not the DDL literal.
12. pg_trgm: `%` threshold 0.3 is a session GUC (`pages.ts:990-992`); fuzzy title winner tie-break is `ORDER BY sim DESC, slug` (`pages.ts:996`). Trigram padding rules must match pg_trgm exactly for identical rankings.
13. JSONB: `@>` containment and number-vs-string equality (`frontmatter-where.ts:1-20`); jsonb canonical key order and deduplication. Use a canonical JSON type in Rust.
14. Recursive BFS row cap `TRAVERSE_WALK_ROW_CAP = 20000` (`engine-constants.ts:48`) and `MAX_RETIREMENT_HOPS = 5` (`entities/resolve.ts:217`): cut points depend on the `row_number()` ordering (`links.ts:645`). A Rust BFS must emit rows in the same layer order before capping.
15. `NULLS NOT DISTINCT` unique constraints (`schema.sql:579-583`, `:3336`) do not exist in SQLite; duplicate-suppression behaviour for NULL origin must be enforced in code.
16. `DISTINCT ON` with `ORDER BY page_id, score DESC, chunk_id ASC` (`keyword-statement.ts:150`) is the "best chunk per page" rule. ROW_NUMBER equivalence requires the same tie order.
17. Keyset pagination on float8 `score` plus `page_id` (`keyword-statement.ts:152-155`): the Rust score must be f64 and computed identically, or cursors skip or repeat rows.
18. Statement timeouts (`SET LOCAL statement_timeout`, `cjk-search.ts:112-148`) and the 2/3 + 1/3 deadline split: an embedded engine needs interruptible queries, and the capped fallback (`CJK_CANDIDATE_CAP = 2000`) must match in result cap behaviour.
19. Planner-driven behaviours (`OFFSET 0` fences, `MATERIALIZED`, planner-stats ANALYZE, `reltuples` used as a corpus size in `cjk-search.ts:150-171`) do not port. Replace `reltuples` with a real row count.
20. Timestamp and interval semantics: `now()` is transaction time; `COALESCE(effective_date, updated_at, created_at)` date axis (`keyword-statement.ts:98`) and `::text::timestamptz` casts on bound strings. Keep a single UTC representation.
21. `SERIAL`/`BIGSERIAL` integer ids are exposed through cursors and sort tie-breaks (`page_id ASC`). A new engine must keep stable, monotonic integer ids and not reuse them after delete.
22. Advisory locks, `FOR UPDATE SKIP LOCKED` (~31 matches, `src/core/minions/queue.ts`), and `pg_stat_activity` zombie-index probes need an embedded-process equivalent (single-writer lock or DB-level transactions).


---

## Concurrency, access control and runtime features

Scope: concurrency and runtime features of the Postgres and PGLite engines in garrytan/gbrain (commit 8bbfd0b5e8). Paths are relative to that repo unless absolute. Line numbers were read in this pass. Where I only sampled a file, I say so.

Headline: gbrain does not use Postgres as a passive store. It leans on triggers (plpgsql guards and derived-state maintainers), transaction-scoped advisory locks, row locks (`FOR UPDATE`, `FOR SHARE`, `FOR KEY SHARE`), `SKIP LOCKED` for a job queue, a TTL lease table, and `LISTEN/NOTIFY` for worker wake-up. Access control is mostly application code plus GUC-based write guards inside triggers. There are no RLS policies, no GRANT/REVOKE statements and no SECURITY DEFINER functions in the repo. Several correctness properties depend on the server behaving the way Postgres does, not on gbrain code alone.

### 0. Summary of mechanisms

| Mechanism | Used for | Where (main) |
|---|---|---|
| plpgsql triggers (about 25 trigger functions) | derived-state maintenance, revision counters, fail-closed write guards, job-queue protocol, NOTIFY | src/schema.sql:182-3064+ |
| `pg_notify('minion_jobs', ...)` | wake idle job workers | src/schema.sql:1813-1825 |
| `pg_advisory_lock(42)` / `pg_try_advisory_lock(42)` (session) | schema migration / init-schema lock | src/core/db.ts:600-611, src/core/postgres-engine/init-schema-lock.ts:98 |
| `pg_advisory_xact_lock(hashtext(...))` (transaction) | per-key serialization: queue admission, quotas, budgets, generations, origin, page-body chunks, facts by entity | see section 3 |
| `gbrain_cycle_locks` row lease (`INSERT ... ON CONFLICT ... WHERE ttl < now()`) | cycle lock, sync lock, maintenance leases; pooler-safe | src/core/db-lock.ts:267-328, src/core/lease-schema.ts |
| `FOR UPDATE SKIP LOCKED` | minion job claim, timeout/stall reapers, segment derive | src/core/minions/queue.ts:1511, 1585, 1720; src/core/page-body/ (see 5) |
| Fenced UPDATE on `lock_token` + `status='active'` | job complete/fail/renew, lease fencing | src/core/minions/queue.ts:1766, 1885, 2014, 2060, 2110 |
| `LOCK TABLE ... NOWAIT` (SHARE UPDATE EXCLUSIVE) | defer ANALYZE instead of cancelling autovacuum | src/core/analyze-lock.ts:11-24 |
| `SET LOCAL` / `set_config(..., true)` | per-transaction statement_timeout, lock_timeout, jit, GUC guards | many; see 8 |
| Session-level startup GUCs | statement_timeout 5 min, idle_in_transaction 5 min | src/core/db.ts:346-347, 440-456 |
| `current_setting('gbrain.*', true)` guards | write allowlists, protocol versions | src/schema.sql:2556, 2564, 2598, 2607, 2953, 3022, 3045 |
| `ALTER FUNCTION ... SET search_path = ..., pg_temp` | function search_path hardening | src/core/function-search-path.ts:37-123 |

---

### 1. Triggers and trigger functions (Postgres DDL: src/schema.sql)

Unless noted, every function below is `LANGUAGE plpgsql`, carries `SET search_path = pg_catalog, public, pg_temp` (function-search-path.ts, #7632), and is SECURITY INVOKER (the default). No SECURITY DEFINER anywhere (see 6).

| Function | Trigger / event | Lines | What it maintains or enforces |
|---|---|---|---|
| `gbrain_try_jsonb(text)` | none (IMMUTABLE helper) | 64-65 | Safe text-to-jsonb cast used by generated indexes |
| `bump_page_generation_fn()` | `bump_page_generation_trg` on pages | 182-212 | Page generation counter (body not read in detail) |
| `bump_page_generation_clock_fn()` | `bump_page_generation_clock_trg` | 267-278 | Calls `nextval('page_generation_clock_seq')`; sequence created and set at 250-263 with the comment that nextval avoids a tuple-level hotspot |
| `gbrain_forget_page_retrievals()` | `pages_forget_retrievals` AFTER DELETE, FOR EACH STATEMENT | 313-334 | Deletes retrieval log rows for deleted pages |
| `update_chunk_search_vector()` | `chunk_search_vector_trigger`, FOR EACH ROW | 432-458 | Maintains tsvector on chunks (uses `gbrain_fts_input`, 432) |
| `update_page_search_vector()` | `trg_pages_search_vector` BEFORE INSERT/UPDATE | 1196-1234; re-created dynamically with the column list at 2685 | Page tsvector maintenance |
| `enforce_minion_queue_protocol()` | `minion_queue_protocol` BEFORE INSERT OR UPDATE ON minion_jobs | 1789-1810 | Rejects rows without submission_authority; forces `claim_generation` to advance by exactly 1 on every claim into 'active'; spend protocol check (`spend_claim_token`) |
| `notify_minion_job_change()` | `minion_job_notify` AFTER INSERT OR UPDATE OF status | 1813-1825 | `pg_notify('minion_jobs', json)` with id, status, name, queue, prev_status |
| `gbrain_advance_page_revision()` | `pages_knowledge_revision` BEFORE UPDATE | 1904-1936 | Advances `knowledge_revision`, unless `current_setting('gbrain.materializing_revision')` matches OLD (line 1921; set by page-body/rechunk.ts:166-181) |
| `gbrain_advance_tag_revision()` | `tags_knowledge_revision` AFTER I/U/D on tags | 1937-1961 | Tag-side revision bump |
| `gbrain_mark_derivation_scope_entry()` | `page_body_manifest_derivation_scope_retire`, `..._delete`; `pages_derivation_scope_delete` | 2298-2344 | Takes `pg_advisory_xact_lock_shared(hashtextextended('gbrain:derivation-scope:'||src,0))` (2330) and enqueues `page_segment_derivation_purge_pages` rows |
| `gbrain_refuse_purging_derivation()` | `page_segment_derivations_refuse_purging` BEFORE INSERT OR UPDATE OF output, receipt | 2345-2382 | Refuses writes to derivation rows when the purge guard applies (body only partly read; the name indicates a purge interlock) |
| `gbrain_require_managed_writer()` | `managed_writer_guard` BEFORE I/U/D, created dynamically on many tables | 2522-2645 (trigger created at 2635) | Fail-closed writer guard: reads `persistence_brain.enabled` (P0001 `writer_coordinator_required` if the row is not visible), checks `gbrain.write_sources` allowlist (2556, 2598), `gbrain.topology_change` (2564), `gbrain.git_protocol` (2607), `git_canonical_brain.strict_sources` |
| `gbrain_count_git_canonical_sources()` | `git_canonical_sources_count_{insert,update,delete}` on sources | 2647-2668 | Counts git-canonical sources into `git_canonical_brain` |
| `gbrain_queue_page_projection()` | `pages_projection_queue` AFTER I/U/D on pages | 2697-2766 | Enqueues projection work for search/attribution derivations |
| `gbrain_require_persistence_protocol(int)` | called by triggers | 2951-2956 | Requires `gbrain.persistence_protocol = '2'` when required >= 2 |
| `gbrain_guard_request_protocol()` | `gbrain_request_protocol` BEFORE I/U/D on persistence_requests | 2957-2998 | Protocol and state guards for write requests |
| `gbrain_guard_effect_protocol()` | `gbrain_effect_protocol` BEFORE I/U/D on persistence_effects | 2999-3010 | Same for effects |
| `gbrain_guard_protocol_activation()` | `gbrain_protocol_activation` BEFORE UPDATE on persistence_brain | 3011-3037 | Refuses `enabled` / protocol-floor changes unless `gbrain.writer_quiesced = 'true'` (3022) |
| `gbrain_guard_skill_publication()` | `gbrain_skill_publication` on shared_skill_packs/heads/revisions | 3038-3063 | Publication guard (allowlist via `gbrain.write_sources`, 3045) |
| `gbrain_lease_shared_skill_delivery()` | trigger (body not read) | 3064+ | Shared-skill delivery lease |

Also present in the file and tracked by the function-search-path list (src/core/function-search-path.ts:37-52): `gbrain_access_*` (readers, folder rules, lineage, origin, refresh-serves trigger, mark-restricted, etc.), `gbrain_guard_guest_records`, `gbrain_guard_inserted_facts` (insert-guard-schema.ts:86-113), `gbrain_preserve_fact_withdrawal`, `gbrain_refuse_purged_{fact,page,take}`, `gbrain_release_refresh_barrier`, `gbrain_graduation_fence`, `gbrain_bump_trust_generation` (eligibility/generation-schema.ts:78), `gbrain_snapshot_version_trust`, `gbrain_stamp_{revision,version,write}_attribution`, `gbrain_stamp_trust_tier`, `gbrain_clear_atom_page_state`, `gbrain_concept_inputs_private`, `gbrain_count_modifications`. The list has 56 names. Their bodies were not read in this pass; sc-1/sc-2 cover the tables they touch.

Other trigger-like guards defined outside schema.sql (module-level DDL emitted by TS fragments):
- src/core/facts/insert-guard-schema.ts:86-113: `FOR SHARE OF s` on sources, then `set_config(FACT_WITHDRAWAL_STAMP_SETTING, 'on', true)`.
- src/core/facts/purge-schema.ts:92-128: `PERFORM id FROM sources ... FOR SHARE`.
- src/core/facts/withdrawal-schema.ts:68: same FOR SHARE pattern.
- src/core/persistence/writer-guard-schema.ts (128 lines) and src/core/shared-skills/persistence-schema.ts:7-120: copies of the protocol and allowlist guards for the persistence subsystem.
- src/core/derived-state-maintainers.ts:3-13: states that the maintainer triggers run SECURITY INVOKER and "No SECURITY DEFINER (#7659)".

Behavior that depends on triggers:
- Crash safety: none directly; triggers run inside the statement's transaction, so they commit or roll back with the row.
- Multi-process writers: the `managed_writer_guard` and protocol triggers are the only enforcement that a non-coordinator writer cannot change canonical rows. They key off GUCs that a session sets itself (`set_config(..., true)`), so the guard blocks accidental writers, not hostile ones.
- Exactly-once: the job protocol trigger (1789-1810) is what stops old workers from claiming upgraded jobs.

### 2. LISTEN/NOTIFY

| Actor | Role | Location |
|---|---|---|
| Trigger `notify_minion_job_change` | NOTIFY on every insert and status update of `minion_jobs` | src/schema.sql:1813-1825 |
| Trigger is absent from the PGLite blob | PGLite has no NOTIFY; the trigger function name is only listed in the function-search-path inventory | src/core/pglite-schema.generated.ts (grep: no `minion_job_notify` creation); schema.sql:1812 comment "Postgres only, not PGLite" |
| `sql.listen('minion_jobs' channel)` | LISTEN for the idle claim loop | src/core/minions/sync-queue-wake.ts:6-98 (listen at 87, probe NOTIFY at 91, `LISTEN_PROBE_MS = 3000` at 25) |
| Probe NOTIFY | verifies the LISTEN is live; if no notification arrives within 3 s, the worker polls | src/core/minions/sync-queue-wake.ts:11, 91 |
| Idle waiter integration | wakes `jobs work` claim loop | src/commands/jobs/work.ts:267; src/core/minions/idle-wait.ts |
| `wait-for-completion` | comment says it does not depend on NOTIFY | src/core/minions/wait-for-completion.ts:3 |

Notes:
- A LISTEN is only attempted on a direct session. Behind a transaction pooler, `sync-queue-wake.ts:9-10` says a LISTEN outlives the transaction that ran it, so notifications reach a different client or nobody. The fallback is a 1 s read of the sync queue (behavior-change-notice.ts:983).
- Notifications are not durable. The claim loop's own poll is the backstop (sync-queue-wake.ts:16).
- A probe NOTIFY is sent from the same connection (`engine.executeRaw('SELECT pg_notify($1, $2)')`, sync-queue-wake.ts:91).
- No other module calls `pg_notify`. The `server.listen` hits in src are Node HTTP/Unix socket listeners, not Postgres LISTEN.

### 3. Advisory locks

Session-level (held until unlock or disconnect):

| Key | Acquire / release | Purpose | Location |
|---|---|---|---|
| `42` (int, brain-global) | `pg_advisory_lock(42)` / `pg_advisory_unlock(42)` | legacy initSchema path in db.ts | src/core/db.ts:600, 611 |
| `42` | `pg_try_advisory_lock(42)` poll with 500 ms interval, 10 min deadline, 5 s heartbeat | initSchema lock for the engine; names holder pid from pg_locks | src/core/postgres-engine/init-schema-lock.ts:13-98, 140-170 (diagnostic query at 166-169) |
| `42` session fallback | used only when every pool has one connection (GBRAIN_POOL_SIZE=1 or a short-lived command) | src/core/postgres-engine.ts:687-700; init-schema-lock.ts:227-239 |

Transaction-level (released at COMMIT or ROLLBACK):

| Key | Purpose | Location |
|---|---|---|
| `42` via `pg_try_advisory_xact_lock(42)` inside `BEGIN ISOLATION LEVEL READ COMMITTED`, with `idle_in_transaction_session_timeout = 0` and `application_name='gbrain-schema-migration-lock'` | schema migration lock held across the whole migration run; `assertHeld` checked before each migration | src/core/postgres-engine/init-schema-lock.ts:189-226; src/core/schema-migration-lock.ts:1-38 |
| `hashtext('minion_admission:'||queue||':'||name||':'||...)` | admission check for queue submissions | src/core/minions/queue.ts:385 |
| `hashtext('minion_quota:'||queue)` | queue quota | src/core/minions/queue.ts:431 |
| `hashtext('minion_maxwaiting:'...)` | max-waiting cap | src/core/minions/queue.ts:460-488 (comment at 460-473: the cap is enforced under this lock) |
| client-id hash (`clientLockKey`) | budget check-and-reserve | src/core/minions/budget-meter.ts:30-38, 99, 255 |
| `$1::bigint` from `rateLeaseLockKey` | rate-lease reservation | src/core/minions/rate-leases.ts:36, 81 |
| `hashtextextended('gbrain:derivation-scope:'||src, 0)` shared (trigger) and exclusive (segment-derive) | serialize derived-state purge against derivation writes | src/schema.sql:2330; src/core/page-body/schema.ts:256, 279; src/core/page-body/segment-derive.ts:545 (try), 560 (blocking) |
| `hashtextextended('gbrain:page-body-chunks:'||pageId, 0)` | rechunk per page | src/core/engine-sql/page-body.ts:197 |
| `hashtextextended(source||':'||entitySlug, 0)` | facts per entity | src/core/engine-sql/facts.ts:122, 151 |
| `hashtext(generationKeyLock(key))` | generation fence and publish | src/core/generations/fence.ts:128; publish.ts:71; managed.ts:151; adapters/fact-rows.ts:124, 147 |
| `hashtext(registerClientNameLockKey(name))` | agent client registration | src/commands/agent-register.ts:546, 818; src/commands/serve-http-registration.ts:199; src/commands/mcp-provision.ts:36 |
| `hashtextextended('gbrain:origin:'||[source,key], 0)` | origin guard | src/core/persistence/origin-guard.ts:126 |
| `hashtext('memory_proposals:'||principal)` | memory proposal serialization | src/core/persistence/memory-proposals.ts:121 |
| `hashtext('gbrain:mention-entries:'||sourceId)` | mention pass | src/core/mentions/pass.ts:481 |
| `hashtext(...)` on the output writer | output writer serialization | src/core/output/writer.ts:186-193 (comment says hashtext, not hashtextextended, must behave the same on both engines) |
| `hashtext(AGENT_WRITEBACK_KEY)` | writeback settings | src/core/facts/writeback-settings.ts:122 |
| `hashtext('gbrain:chronicle:daily_reservation')` | daily chronicle reservation | src/core/chronicle/ledger.ts:97 |
| `pg_advisory_xact_lock($1::int4, $2::int4)` | graduation target nonce | src/core/persistence/graduation-target.ts:332 |
| `hashtextextended('gbrain:access-serves', 0)` | access serve refresh (migration v309) | src/core/schema-migrations/v309-requester-scope.ts:40 |

Other lock primitives:
- `src/core/db-lock.ts:8` states why gbrain avoids session-level advisory locks: they are per-session and PgBouncer transaction mode drops session state. The migrate.ts comment (`cycle_locks_table`) says the same. The xact-level keys above are used in the opposite way, so they survive transaction pooling.
- `src/core/cycle.ts:34`: the cycle lock is a TTL row, not `pg_try_advisory_lock`, for the same reason.

### 4. Row locks

| Lock | Where | Target |
|---|---|---|
| `FOR UPDATE` (page identity) | src/core/engine-sql/chunks.ts:118, 1056; src/core/engine-sql/page-body.ts:294; src/core/engine-sql/pages.ts:453; src/core/facts/conversation-incremental.ts:364; src/core/repair/readers.ts:218 | pages by (source_id, slug) or id |
| `lockPageKeys` / `lockUnheldPageKeys` / `withHeldPageKeys` | src/core/page-state/guards.ts:1-60 (sorted by sourceId then slug; pipelined `FOR SHARE`/`FOR UPDATE` on sources); called from roughly 76 files (count by `rg -l`) | per-page guard for writes, sorted to avoid deadlock; the comment at line 16 says source locks precede auth/request locks |
| `FOR KEY SHARE` on pages | src/core/engine-sql/links.ts:124-196 (link insert holds the endpoints' key so a page delete waits); src/core/engine-sql/timeline.ts:51; src/core/engine-sql/page-body.ts:195 | prevent delete during insert of dependent rows |
| `FOR SHARE` on pages | src/core/facts/reconcile-watermark.ts:81; src/core/mentions/pass.ts:562; src/core/questions/refresh.ts:352-374 | read-consistent check |
| `FOR SHARE` on sources | src/core/attendance-repair.ts:329; src/core/embed-facts.ts:191; src/core/facts/backstop.ts:730; src/core/facts/insert-guard-schema.ts:86; src/core/facts/purge-schema.ts:128; src/core/facts/withdrawal-schema.ts:68; src/core/shared-skills/policy.ts:141-196 | writes wait for incarnation/purge |
| `FOR UPDATE` on sources | src/core/facts/withdrawal.ts:107; src/core/facts/purge.ts:511; src/core/guests/sources.ts:69, 89; src/core/url-source-origin.ts:229; src/core/repair/segmented-mirror.ts:160; src/core/access/attest-sources.ts:67-69; src/core/shared-skills/retention.ts:143 | purge and attestation take exclusive |
| `FOR NO KEY UPDATE` / `FOR UPDATE` on access state | src/core/access/policy.ts:112-113 | access policy rows, sources first |
| `FOR UPDATE` on config | src/core/heal-audit.ts:57; src/core/line-grammar-config.ts:42; src/core/repair/content-receipt-root.ts:113; src/core/embedding-migration-budget.ts:104 | read-modify-write of config keys |
| `FOR UPDATE` on facts / takes / timeline | src/core/repair/extractor-facts.ts:376; src/core/repair/unwithdrawn-facts.ts:312; src/core/repair/conversation-labels.ts:373; src/core/repair/purged-page-facts.ts:206; src/core/facts/purge-reasons.ts:85; src/core/trust/fence-guard.ts:73, 197, 226; src/core/trust/propagation.ts:44 | batch writers take rows before editing |
| `FOR UPDATE` on oauth clients/codes/tokens | src/core/oauth-grants.ts:136, 274, 293, 351; src/core/harness/client-setup.ts:46 | code exchange and refresh single-use |
| `FOR UPDATE` on write gates | src/core/trust/owner-actions.ts:194; src/core/trust/release-publish.ts:246 | hold resolution |
| `FOR UPDATE` on budget and spend | src/core/page-spend.ts:85; src/core/budget/daily-ledger.ts:106 | per-page and per-day ledger |
| `FOR UPDATE` on questions and proposals | src/core/questions/refresh.ts:451; src/core/questions/store.ts:105 (opt-in `forUpdate`); src/core/trust/proposals.ts:125 (opt-in) | pinned questions |
| `FOR UPDATE SKIP LOCKED` | src/core/minions/queue.ts:1511 (claim), 1585 (timeouts), 1720 (wall clock), 2211 and 2228 (stalled reaper); src/core/engine-sql/page-body.ts:485; src/core/shared-skills/retention.ts:95 (`FOR UPDATE OF r SKIP LOCKED`) | queue claim, reapers, retention batches |
| `FOR KEY SHARE` on lease row | src/core/db-lock.ts:226 | fence that the lease row is still owned (#7442) |
| `FOR KEY SHARE` on schema-guard rows | src/schema.sql:3072; src/core/shared-skills/schema.ts:65 | guard triggers |

`NOWAIT`: only one use, src/core/analyze-lock.ts:11-24: `LOCK TABLE <t> IN SHARE UPDATE EXCLUSIVE MODE NOWAIT`. SQLSTATE 55P03 means defer the ANALYZE (#7083). It is Postgres-only (`tx.kind !== 'postgres'` returns early).

`lock_timeout` as a bound on waits (not NOWAIT): src/core/postgres-engine/schema-lock-timeout.ts:1-165 (session lock_timeout, default 60 s, GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS; on 55P03 it samples pg_blocking_pids and throws `schema_lock_blocked`); src/core/planner-stats.ts:209 (`lock_timeout='2s'`); src/core/persistence/git-durability-administration.ts:352; src/core/attendance-repair.ts:326; src/core/repair/missing-tables.ts:65; src/core/migrate.ts:230 (per migration).

### 5. Job queue (minions) with SKIP LOCKED, leases and retries

Files: src/core/minions/queue.ts (2574 lines; the main module), worker.ts (1792), supervisor.ts (1497), lock-renewal-tick.ts (680), child-worker-supervisor.ts (845), watchdog-attribution.ts, submission-authority.ts (380), admission.ts (383), idempotency-coalesce.ts (78), backoff.ts (26), handler-timeouts.ts (158), global-maintenance-stall.ts (117), src/commands/jobs/*.ts (work.ts 435, supervisor.ts 442, submit.ts 331, stats.ts 324).

Schema: `minion_jobs` (schema.sql:1248-1300). Key columns: `status` (CHECK at line ~1293: waiting, active, completed, failed, delayed, dead, cancelled, waiting-children, paused), `priority`, `claim_generation BIGINT`, `attempts_made`, `attempts_started` (CHECK attempts_made <= attempts_started), `stalled_counter`, `max_stalled` (default 5), `lock_token TEXT`, `lock_until TIMESTAMPTZ`, `lock_duration_ms`, `timeout_ms`, `timeout_at`, `idempotency_key`, `parent_job_id` (FK, ON DELETE SET NULL), `private_queue_owner_job_id`, `private_queue_lease_until`, `submission_authority`, `spend_authorization`, `spend_claim_token`.

Indexes: `idx_minion_jobs_claim (queue, priority, created_at) WHERE status='waiting'` (1304); `idx_minion_jobs_stalled (lock_until) WHERE status='active'` (1306); `idx_minion_jobs_timeout (timeout_at) WHERE status='active' AND timeout_at IS NOT NULL` (1309); `uniq_minion_jobs_idempotency (idempotency_key) WHERE idempotency_key IS NOT NULL` (1311); private-queue recovery and owner indexes (1315-1320).

| Operation | Lines (queue.ts) | SQL shape | Semantics |
|---|---|---|---|
| submit | 336-690 | `SELECT ... FOR UPDATE` on parent (561); `INSERT ... ON CONFLICT (idempotency_key) WHERE NOT NULL DO NOTHING RETURNING *` (623-627) | idempotent submit; a conflicting concurrent submit returns 0 rows (669) and the caller reads the winner |
| claim | 1463-1520 | `UPDATE minion_jobs SET status='active', claim_generation = claim_generation+1, lock_token=$1, lock_until = now() + clamp(lock_duration_ms, 5 s, 1 h), attempts_started+1, started_at = COALESCE(started_at, now()) WHERE id = (SELECT id ... WHERE queue=$3 AND status='waiting' AND submission_authority IS NOT NULL AND name=ANY($4) ... ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` | exactly one claimant per row; ordering by priority then created_at; uses `executeRawDirect` (direct session pool, 1467-1470 comment) |
| renewLock (heartbeat) | 2096-2110 | `UPDATE minion_jobs SET lock_until = now()+$1ms WHERE id=$2 AND lock_token=$3 AND status='active'` | fenced by token; cancellable; a late renewal can only extend a lock nobody else has taken (2092-2094) |
| lock-renewal tick | src/core/minions/lock-renewal-tick.ts (whole file) | timer wrapper with `Promise.race` timeout and "verify-before-evict" at the soft deadline (lockDuration - safetyMargin) | a timed-out renew is not proof of loss |
| completeJob | 1745-1775 | parent `FOR UPDATE`, then `UPDATE ... WHERE id=$2 AND status='active' AND lock_token=$3 RETURNING *` in `retryOnStalePlan` | fenced; a stale completion returns null |
| failJob | 1853-1890 | same fencing; `attempts_made = attempts_made+1`; sets delay_until from backoff; `status` = delayed (retry) or failed / dead | exhausting `max_attempts` dead-letters |
| releaseLeaseFullJob | 2000-2016 | `status`→delayed, backoff, does NOT bump attempts (rate-lease bounce) | fenced on lock_token |
| releaseConfigurationJob | 2041-2061 | fenced release to waiting, returns 'released' / 'no_op' / 'unconfirmed' | |
| handleStalled | 2166-~2250 | candidates `WHERE status='active' AND lock_until < now() - grace`; `DELETE` of stale lease-beacon rows whose gbrain_cycle_locks row is gone (2170-2171); co-runner requeue (watchdog-attribution.ts); dead-letter when `stalled_counter+1 >= max_stalled` (lockParentsOrdered first) | stall means the lock expired; grace from `GBRAIN_MINION_STALL_RECLAIM_GRACE_MS` (queue.ts:88) |
| handleTimeouts | 1547-1585 | `timeout_at < now() AND lock_until > now()` → dead 'timeout exceeded', `FOR UPDATE SKIP LOCKED` | stall → retry, timeout → dead; `lock_until > now()` distinguishes them |
| handleWallClockTimeouts | 1687-1722 | `timeout = 2 * lockDuration * max_stalled` fallback; `FOR UPDATE SKIP LOCKED` | |
| promoteDelayed | 2153-2164 | `UPDATE ... SET status='waiting' WHERE status='delayed' AND delay_until <= now()` | retried by lockRetry (issue #1678) |
| retryJob | 1227-1245 | resets attempts, stall counter, lock fields | operator retry |
| private queue lease renewal | 823-853 | `SET private_queue_lease_until = GREATEST(COALESCE(...), now()+lease)` | lease only extends |
| killJobs (shared tail) | 1614-1672 | parents locked first, then `SELECT id ... ORDER BY id FOR UPDATE` (1673), notify parents | |

Lease tokens: `minion_jobs.lock_token` is a per-claim random token (`claim(lockToken, ...)` at 1463). The `gbrain_cycle_locks.acquisition_token UUID` (lease-schema.ts:1-5, applied in schema.sql:1530-1532 as a GENERATED region from lease-schema.ts) is a separate lease identity for cycle, sync and maintenance locks; the beacon queue `LEASE_BEACON_QUEUE` stores that UUID in `lock_token` so a drain lease can be reaped (queue.ts:2170-2171 and the comment on migration v152).

Retry semantics: `max_attempts` default 3 (queue.ts:635) and `backoff_type` exponential with jitter 0.2 (635-638). `attempts_made` counts completed failures; `attempts_started` counts claims (chk_attempts_order at schema.sql:1296-1297). Retries are bounded by `retryOnStalePlan` (retry-matcher.ts:132) for lost plan races and `lockRetry`/`withRetry` only for idempotent promoteDelayed (queue.ts:2115-2140). claim and renewLock deliberately do not retry (comment at 2119-2125).

Exactly-once: a job is executed by at most one worker at a time because claim is `FOR UPDATE SKIP LOCKED` under one UPDATE. "Exactly-once effect" is not guaranteed: a stalled job is re-claimed, so handlers must be idempotent. The protocol trigger (schema.sql:1789-1810) rejects a claim that does not advance `claim_generation` by exactly 1, so an old binary cannot claim.

Wake-up: see section 2 (NOTIFY). The claim loop also polls.

Multi-process: the worker runs in `jobs work` (CLI), `serve`, child processes (child-worker-supervisor.ts, run-child.ts) and the supervisor (supervisor.ts). All of them use the same SQL claim, so the database is the coordination point. PGLite is a single process (see 11).

Dedup and admission: src/core/minions/admission.ts (383) and submission-authority.ts (380) combine the advisory-locked count (queue.ts:385-488) with the `ON CONFLICT` idempotency key.

### 6. Roles, RLS, grants, SECURITY DEFINER, search_path

RLS:
- src/schema.sql:1830-1861: enables RLS on 37 named tables (pages, content_chunks, links, tags, raw_data, timeline_entries, page_versions, ingest_log, config, files, minion_jobs, sources, access_tokens, mcp_request_log, minion_inbox, minion_attachments, subagent_*, gbrain_cycle_locks, dream_verdicts, eval_*, calibration_profiles, take_*, oauth_clients, oauth_tokens, oauth_codes, ...) only when the current role has BYPASSRLS or is superuser (the check at 1841). If not, it prints a WARNING (1861) and enables nothing.
- The same conditional pattern appears for each later table: schema.sql:2389-2393, 2674-2677 (git_canonical_brain), 3088-3094, 3158-3169 (decide_*), 3202-3291, 3312-3313 (fact_relink_attempts), 3340-3369 (link_*), 3418-3419 (core_edit_notices), 3438-3465 (fact_purges, take_purges, page_purges), 3479-3494 (derivation_inputs, needs_rederive), 3548-3550 (write_gate_*), 3617-3623 (pinned_questions, question_evidence), 3667-3725 (belief_*).
- Comment at schema.sql:1830-1832: "Enabling RLS with no policies means the anon key can't read anything. Only enable if the current role actually has BYPASSRLS privilege."
- There is no `CREATE POLICY` anywhere in src (grep: zero matches). So RLS is "on with no policies": the table is denied to every role without BYPASSRLS. Access for those roles is the separate GRANT model (none in repo, see below).
- Error classification for these denials: src/core/pg-access-classify.ts:59, 236 (SQLSTATE 28000 / 42501 mapped to `permission_denied`, "RLS or missing GRANT").

GRANT / REVOKE: none in src (grep: zero statements). Privileges are assumed to come from the hosting platform (Supabase roles, the `postgres` role). Migrations v278, v281, v283 say they do not change privileges (v278-writer-fence-fail-closed.ts:25, v281:27, v283:35).

SECURITY DEFINER: none. derived-state-maintainers.ts:13 says so explicitly (#7659). All trigger functions are SECURITY INVOKER.

search_path hardening: src/core/function-search-path.ts:
- `LEGACY_SEARCH_PATH_SETTINGS` (25): `pg_catalog, public` and `pg_catalog`.
- `PINNED_FUNCTION_NAMES` (37-52): 56 function names gbrain installs in public. The list is used by hardening, the doctor check and tests (test/function-search-path-pglite.test.ts, test/e2e/function-search-path-postgres.test.ts, scripts/check-search-path.sh).
- `hardenFunctionSearchPaths(engine)` (100): `ALTER FUNCTION ... SET search_path = ..., pg_temp` for owned functions only (the `pg_has_role(current_user, p.proowner, 'USAGE')` check at schema.sql:3788). Runs as the last statement of the schema blob (per the comment at 6-18) and at the end of every migration run.
- Why pg_temp is appended: a pinned path that does not name pg_temp lets a temp table shadow the ledgers a guard reads (fact_purges, page_purges, take_purges, fact_withdrawals). Comment at function-search-path.ts:6-10 (#7632).
- Schema blob list: schema.sql:3787 repeats the names.

Access control model (application level):
- src/core/scope.ts (35 matches of the scope patterns), src/core/access/* (policy, members, attest-sources, open-pages, folder rules), src/core/grants/* (model, service, legacy-token, profiles, shared-exposure, lifecycle), src/core/oauth-grants.ts, src/core/oauth-provider.ts, src/core/persistence/authority.ts and ownership.ts, src/core/minions/submission-authority.ts. These decide who may read or write a page, source, job or shared skill. They run in the gbrain process, not in Postgres.
- Postgres-side authority is limited to the GUC guards listed in section 1, which read values set by the same gbrain process. A session with direct database access can set those GUCs itself.

Supabase assumptions:
- The `postgres` role with BYPASSRLS is assumed (schema.sql:1830-1832; connection-manager.ts:6-7 mentions the Supabase pooler and its 2-minute statement_timeout).
- Pooler URL conventions: src/core/supabase-pooler-url.ts (deriveDirectUrl, deriveSessionPoolerUrl, isSupabasePoolerUrl), used by connection-manager.ts:46 and 118-125.
- `application_name` is `gbrain <kind>:<pid>:<nonce8>` (db.ts:350-357) so the owner can be found in pg_stat_activity; the comment says this is partial behind a transaction pooler.

### 7. Transactions, isolation, timeouts, cancellation, retries

Transaction entry points:
- `beginReadWrite(pool, fn)` (src/core/postgres-engine/read-write-transactions.ts:37-47): `pool.begin('read write', fn)`. On a standby (SQLSTATE 0A000 "read-write mode during recovery") it reopens without the mode.
- `readWriteTransactions(conn)` (read-write-transactions.ts:49-56): wraps a pool so every `begin` is read-write.
- `retryReadOnlyAutocommit(conn, run)` (read-write-transactions.ts:63-76): on 25006 (read_only_sql_transaction) re-runs the statement inside `BEGIN READ WRITE` once; a 25001 retry error reports the original.
- `reservedTransactions(reserved)` (src/core/postgres-engine/reserved-transactions.ts:37-111): BEGIN READ WRITE, savepoints named `s0..sN`, pipelines BEGIN with the first statement unless the pool is a transaction pooler (`max_pipeline` 0, #6543); a COMMIT that does not answer COMMIT throws 25P02 (reserved-transactions.ts:68).
- `withTransactionAbort(signal, run)` (src/core/postgres-engine/transaction-abort.ts:55-87): on abort, `cancelAndDiscard()` sends a CancelRequest, waits for settle, then discards. Throws `AbortError` with `cause` and `cancelFailure` (`CANCEL_UNCONFIRMED`).
- `reserveWithCancellation(reserve, signal)` (src/core/postgres-engine/cancellation.ts:14-43): races the connection reserve against the signal. A driver without `discard` fails with `postgres_cancellation_unavailable` (cancellation.ts:7-12).

Bounded statements:
- `runBoundedStatement` (src/core/postgres-engine/bounded-statement.ts:29-59): `BEGIN READ WRITE; SET LOCAL statement_timeout = <ms>; [SET LOCAL jit = off]` pipelined with the statement and COMMIT, on one reserved connection. Used for #6278 preparation reads.
- `runDeadlineRead` (bounded-statement.ts:62-110): `BEGIN READ ONLY; SET LOCAL statement_timeout = <time left>`, with `stuck` discard after `settleMs` if COMMIT does not return (#8651).
- `jitOff` (src/core/postgres-engine/jit-off-statement.ts:1-60): reads `current_setting('jit')` once per pool, adds `SET LOCAL jit = off` only when JIT is on. Restores the caller's value inside a caller's transaction.
- Keyword timeout (src/core/postgres-engine/keyword-statement-timeout.ts:1-40): transaction-local `statement_timeout` around keyword/title/CJK search, default 8000 ms, range 1000-60000 (lines 24-26). Resolved once per connection.
- Keyword negative cache (src/core/postgres-engine/keyword-timeout-cache.ts): after a 57014 on a keyword statement, the same statement (hashed with its parameters) is refused for `search.keyword_timeout_negative_cache_seconds` (default 600).
- CJK search: src/core/engine-sql/cjk-search.ts:12, 138 (`set_config('statement_timeout', ..., true)`).
- Planner refresh: src/core/planner-stats.ts:208-209 (`statement_timeout='60s'`, `lock_timeout='2s'`).
- Vector prewarm: src/core/vector-prewarm.ts:152 (`SET LOCAL statement_timeout = 0`).
- Migrations: src/core/migrate.ts:211-230 (per-migration `SET LOCAL statement_timeout = migrationStatementTimeoutMs()` and `SET LOCAL lock_timeout = resolveSchemaLockTimeoutMs()`, inside `engine.transaction` unless `transaction: false`).
- Session defaults: src/core/db.ts:346-347 (`statement_timeout` and `idle_in_transaction_session_timeout` = 5 min), delivered as startup parameters at db.ts:440-456 and the connection option at db.ts:544. A transaction pooler drops them (db.ts:335-340), so the guarantee is absent through port 6543.
- DDL pool (src/core/connection-manager.ts:97-100, 441-446): `statement_timeout` 30 min, idle-in-transaction 5 min.
- Initial lock acquisition for init: `SET LOCAL idle_in_transaction_session_timeout = 0` (init-schema-lock.ts:201) so the migration lock transaction can sit idle.

Isolation levels:
- READ COMMITTED explicitly for the migration lock transaction (init-schema-lock.ts:199) with the comment that a snapshot would make CREATE INDEX CONCURRENTLY wait on it.
- REPEATABLE READ only in src/core/ops/pages.ts:159 and src/core/ops/valid-time-read.ts:318 (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`).
- No SERIALIZABLE anywhere in src (grep: zero). Serialization conflicts are not retried by code.

Retry and error classification:
- `isRetryableConnError` (src/core/retry-matcher.ts:157-165): connection-class SQLSTATEs (08xxx, 57P01-03, 53300), excludes 57014 and lock timeouts.
- `isStatementTimeoutError` 57014; `isLockTimeoutError` 55P03 (retry-matcher.ts:145).
- `withRetry` and `BULK_RETRY_OPTS` (src/core/retry.ts, 359 lines): `maxRetries=3, delayMs=1000, delayMaxMs=10000, jitter='decorrelated'`.
- Deadlock: src/core/migrate.ts:258-370 retries once after 250 ms on 40P01 (SQLSTATE check at line 368, also by message at 370).
- Persistence transient codes: src/core/persistence/transient-retry.ts:62 lists 40001, 40P01, 55P03, 57014, 53300, 57P01-03, 08xxx.
- Repair/item classification: src/core/connectors/item-holds.ts:110 maps 57014 to `statement_timeout`, 55P03 to `lock_timeout`, 40001 and 40P01 to `database_contention`.
- Engine error predicates: src/core/engine-errors.ts (PageMissingError only; no SQLSTATE here). The 42703 predicate guard is scripts/check-schema-error-predicates.ts (ALLOWLIST and `isMissingSchemaObject`).

SQLSTATEs branched on in src (non-migration, approximate counts from `rg`): 57014 (about 20 sites), 42501 (about 20), P0001 (about 20, raised by gbrain guard triggers), 55P03 (about 10), 40P01 (3), 25006 (1), 25001 (1), 25P02 (1), 0A000 (2), 42P01 (about 5), 42703 (about 5), 42P07 (1), 23505 (1), 23503 (3), 53300 (1), 57P01/57P02/57P03 (1 each), 08006 (2). The list is in the grep output of section 7; the authoritative list is `rg -n "'[0-9A-Z]{5}'" src`.

Cancellation:
- Query cancel is `CancelRequest` through the driver's `cancelAndDiscard`, not `pg_cancel_backend`. No `pg_cancel_backend` call exists in src. `pg_terminate_backend` appears only in operator-facing text (init-schema-lock.ts:143-145, migrate.ts:69, 141, 567).
- The worker's abort path is `renewLock` with an `AbortSignal` (queue.ts:2092-2094). The statement is cancelled and the reservation discarded.
- Pool stuck watchdog: db.ts:400-440 (`inflight_max` = statement_timeout + grace; `onstuck`).

The `engine.transaction` callback form is the normal write path. The engine-level wiring was not re-verified line by line in this pass; the read-write wrapper is `beginReadWrite` (read-write-transactions.ts:37).

### 8. Connection-level and runtime features

Pools and modes:
- `ConnectionManager` (src/core/connection-manager.ts): three pools. `read` (lines 263-276: `max = resolvePoolSize`, `idle_timeout 20 s`, `max_lifetime` from `resolveMaxLifetimeSeconds`); `direct` (425-445: `prepare: true`, the DDL and session-mode path, `application_name`); `ddl` (statement_timeout 30 min). Pool sizes: `GBRAIN_POOL_SIZE` (db.ts:248-253, default 10), `GBRAIN_DIRECT_POOL_SIZE` (connection-manager.ts:167-172, default 3 resident / 1 otherwise).
- Transaction pooler detection: port 6543 is a transaction pooler (connection-manager.ts:118-124 `isTransactionPoolerUrl`; db.ts:65-72 `AUTO_DETECT_PORTS`). On that port: `prepare: false` (db.ts:65-79) and `max_pipeline: 0` (db.ts:137-146) unless the URL overrides.
- `max_lifetime` jittered 30-60 min per connection (db.ts:300-305); `GBRAIN_POOL_MAX_LIFETIME_S` overrides (db.ts:277-298).
- Connection timeout: `resolveUrlConnectTimeout` (db.ts:166-240) reads `connect_timeout` from the URL.
- Pool stats: src/core/postgres-engine/pool-stats.ts (driver queue counters: max, open, busy, full, reserved, connecting, queued, inflight_oldest_ms; the comment at line 9 says a transaction pooler's queue is invisible to the server).
- Pool stall watch: src/core/postgres-engine/pool-stall-watch.ts:1-76; 30 s tick (`POOL_STALL_TICK_MS`, line 19); warns `pg_pool_stalled` when connections are checked out and no statement completed for two ticks; `pg_pool_recovered` on recovery.
- Pool gauge: src/core/pool-gauge.ts (CheckoutGauge: acquire, checkedOut, release).
- Pooler notices: src/core/pooler-notice.ts (warnPoolerPrepareOffOnce).
- Direct vs pooled routing for each operation: `executeRawDirect` (queue.ts:1467-1470, 1497; renewLock 2099-2102) runs on the session pool; `executeRaw` uses the read pool. The comments say the heartbeat must not run on the transaction pooler.

Introspection used at runtime:
- `pg_stat_activity` and `pg_locks`: init-schema-lock.ts:66-73, 166-169 (holder pid for the advisory lock); schema-lock-timeout.ts:60-63 (`pg_blocking_pids`); migrate.ts:102-136 (idle-in-transaction blockers older than 5 min, excludes the migration lock's application_name).
- `current_setting('server_version_num')`: db.ts:211; migration-preludes.ts:123; graduation-target.ts:203; schema-migrations/v011-links-provenance-columns.ts:26.
- `current_setting('jit')`: jit-off-statement.ts:37, 48.
- `pg_size_bytes(current_setting('max_wal_size'))` etc.: pglite-engine/checkpoint-guard.ts:118 (PGLite only).
- `pg_proc.proconfig`, `pg_roles`, `pg_class.relrowsecurity`, `pg_has_role`: schema.sql:1841, 1852, 3787-3788; function-search-path.ts:77 (`legacySearchPathFunctions`).
- `pg_stat_*`: src/core/planner-stats.ts, src/core/search/projection-statistics.ts (36 matches), src/core/embedding-dim-check.ts, src/core/schema-verify.ts, src/core/owned-table-shapes.ts. These read planner statistics and table shapes; detailed use is covered in the query-features part (pf-1) and schema parts.
- `information_schema`: used by schema verification (grep count per file was highest in test helpers and src/core/schema-verify.ts).
- COPY: no `COPY` statement in src. Bulk loads use multi-row INSERT / UNNEST (covered in be-2 and pf-1).
- VACUUM: only `VACUUM <tables>` in src/core/facts/purge-verify.ts:561 (PGLite purge path) and a text suggestion `VACUUM (VERBOSE)` for Postgres (purge-verify.ts:586-587, 730). No autovacuum tuning in code.
- ANALYZE: planner-stats.ts (PGLite row-delta ANALYZE, header lines 2-23, `planner.auto_analyze` setting, `import.analyze_every_pages` default 500 at line 37); Postgres ANALYZE is wrapped in `lockTableForAnalyze` (analyze-lock.ts:11-24) so it is deferred rather than waiting (#7083, behavior-change-notice.ts:985).
- CREATE INDEX CONCURRENTLY: src/core/vector-index.ts:290 (`CREATE INDEX CONCURRENTLY IF NOT EXISTS <tempName>` then swap); src/core/embedding-ann-build.ts:100-103 (drop-invalid then CREATE CONCURRENTLY on a reserved backend, session timeout lifted because CONCURRENTLY cannot run in a transaction; comment at 101); src/core/backfill-base.ts and src/core/repair/request-indexes.ts; many migrations with `transaction: false` (see sc-3 and sc-4 for the list).
- Sequences: SERIAL and BIGSERIAL primary keys throughout schema.sql (for example 100, 355, 596, 814, 916); `page_generation_clock_seq` (schema.sql:250-269) via nextval, which is non-transactional in Postgres.
- Error codes at connection level: 08xxx treated as retryable (retry-matcher.ts:157-165); 08006 in src/core/audit/lock-renewal-audit.ts.

Prepared statements: `prepare: false` through the transaction pooler (db.ts:65-79); `prepare: true` on the direct pool (connection-manager.ts:433). `runBoundedStatement` takes a `prepare` option (bounded-statement.ts:29-59, default true) and passes it through to the statement.

### 9. Introspection, planner and maintenance interactions (cross-cutting)

- A brain that the planner misjudges (no ANALYZE) reads slowly. The engine owns ANALYZE timing: after embed drains, imports (every 500 pages), and by row delta on PGLite. These call sites are in src/core/planner-stats.ts and src/core/embed-*.
- ANALYZE and autovacuum share SHARE UPDATE EXCLUSIVE. An ANALYZE that waits cancels a non-wraparound autovacuum after deadlock_timeout (analyze-lock.ts header). gbrain prevents that with NOWAIT.
- `CREATE INDEX CONCURRENTLY` cannot run in a transaction and waits for older snapshots. The migration lock uses READ COMMITTED for that reason (init-schema-lock.ts:199).
- Schema replays (CREATE INDEX, ALTER TABLE ENABLE ROW LEVEL SECURITY) take ACCESS EXCLUSIVE. The RLS block at schema.sql:1841-1858 is conditional so a re-run does not take the lock (#5227 note at 1843-1845).

### 10. Multi-process concurrency model (central risk)

Processes that can touch one brain at the same time: the CLI (each `gbrain <cmd>` is a separate process with its own pool or PGLite handle), `gbrain serve` (MCP server, HTTP), `gbrain jobs work` and the supervisor (child processes), cron or launchd jobs (autopilot, cycle), and hook commands (`src/commands/hook.ts`, short CLI processes). Evidence: src/core/minions/child-worker-supervisor.ts, src/commands/jobs/supervisor.ts, src/core/autopilot-lock.ts, src/core/cli-socket/server.ts, src/core/persistence/ipc.ts (Unix socket IPC, 519 lines), src/core/persistence/coordinator.ts (898 lines, 'writer coordinator').

Postgres: each process has its own connection pools. Coordination is by:
1. Advisory locks (key 42 schema; per-key xact locks), section 3.
2. TTL lease rows (`gbrain_cycle_locks`), section 5 and db-lock.ts. Holder pid, host, token; steal only after TTL expiry (db-lock.ts:267-277), fenced refresh (db-lock.ts:299-317), reap dead same-host holders after a grace window (db-lock.ts:~60-90, "PID reuse" comment).
3. Row locks and `SKIP LOCKED`, section 4-5.
4. The persistence coordinator (persistence_brain singleton, persistence_requests, effects, writer guards; section 1). It appears to be the design for "one writer per brain", with `persistence.single_consumer` as a switch (behavior-change-notice.ts:983).

PGLite: one process at a time per data dir. Lock is a kernel lock through a native binding (src/core/persistence/native-lock.ts:1-25, `tryAcquireNativeLock`, "Stable OS locks for cooperating writers on one owner host. No TTL takeover"), with metadata (pid, process start time, boot id, pid namespace) in `<dataDir>/.gbrain-lock/lock` (pglite-lock.ts:11-100). Heartbeat every 30 s (pglite-lock.ts:11). Contention returns `PgliteBusyError` (`pglite_busy`, retryable) (pglite-lock.ts:25-30). A legacy `.gbrain-lock` folder with an unverifiable owner returns a non-retryable `LegacyOwnerUnverifiedError` (pglite-lock.ts:33-42).

Consequences:
- On Postgres, several processes run concurrently and rely on the database locks above. This is the supported multi-writer mode.
- On PGLite, only one gbrain process can hold the data dir; a second CLI command, or the MCP server while a CLI runs, gets `pglite_busy` (or waits, depending on the caller's wait budget). The MCP server and cron are therefore single-owner.
- Hooks and cron jobs inherit the same constraint; the code surfaces it as a typed error, not as silent corruption.
- The single-writer design is also why the PGLite checkpoint guard and in-process write queue exist (section 11).

### 11. PGLite-specific runtime behavior

| Feature | Behavior | Location |
|---|---|---|
| Single connection | all statements go through one `PGlite` handle; `_dbWork.admit` serializes writes and page transactions | src/core/pglite-engine.ts:744-762, 795, 1209-1222 (`transaction` uses `db.transaction` and the admit gate) |
| No advisory locks | PGLite takes no advisory lock in initSchema (comment in init-schema-lock.ts:1-3, executor.ts:66, facts.ts:7). The schema lock is the in-process `inProcessSchemaLocks` WeakMap | src/core/schema-migration-lock.ts:9-38 |
| No row-level concurrency | `FOR UPDATE` and `SKIP LOCKED` are accepted but meaningless with one connection; the same SQL runs and succeeds. The queue claim is still `FOR UPDATE SKIP LOCKED` | src/core/minions/queue.ts:1511 |
| Checkpoint guard | before an outermost write transaction, runs `CHECKPOINT` when WAL since redo passes half of the automatic trigger (256 MB cap). Prevents a nested checkpoint that spins at 100% CPU on PGLite 0.4.x | src/core/pglite-engine/checkpoint-guard.ts:1-171 (threshold 17-20, `writesWal` at 27-31, probe reuse 50 ms at ~36-45) |
| No statement timeout | keyword searches run with no statement timeout | src/core/postgres-engine/keyword-statement-timeout.ts (header, "PGLite runs these statements with no statement timeout") |
| No autovacuum; manual VACUUM | purge verification runs `VACUUM <tables>` on PGLite and suggests `VACUUM (VERBOSE)` on Postgres | src/core/facts/purge-verify.ts:561-595, 730 |
| Planner ANALYZE by row delta | PGLite has no autovacuum, so gbrain runs ANALYZE itself | src/core/planner-stats.ts:2-23 |
| WASM heap | pglite.wasm caps its heap at 2 GiB; HNSW build is restricted | src/core/vector-index.ts:66 onwards |
| Init failure classification | `wasm-abort`, `corrupt`, `bunfs` verdicts for WASM init errors | src/core/pglite-engine.ts:403-470 |
| WAL repair | `pglite-repair` backups and restores `pg_wal` and `pg_control` | src/core/pglite-engine.ts:505-520; src/core/pglite-resetwal.ts |
| Schema blob | no `notify_minion_job_change` trigger, no `minion_job_notify` trigger in the PGLite template (src/core/pglite-schema.generated.ts); function names are still in the pinned list | src/core/pglite-schema.generated.ts |
| Savepoint-free transactions | PGLite transaction helper `composablePgliteTransaction` and `transactionMemo` (page-state) | src/core/page-state/transactions.ts |

### 12. Access control and authorization summary

- Database-level: RLS enabled, no policies, bypass by the gbrain role (section 6). No GRANT/REVOKE in code. The platform provides roles.
- Application-level: `src/core/access/*`, `src/core/grants/*`, `src/core/scope.ts`, `src/core/persistence/authority.ts`, `src/core/minions/submission-authority.ts` decide read and write rights. All checks run in process before SQL, plus GUC allowlists inside triggers.
- Token-level: src/core/oauth-grants.ts (FOR UPDATE on codes and tokens, single-use exchange), src/core/token-mint.ts, src/core/grants/legacy-token.ts.
- Job-level authority: `submission_authority` must be set (trigger at schema.sql:1792) and `spend_authorization` gates spend-bearing jobs (trigger at 1795-1800).

### 13. Candidate embedded Rust replacements

Notation: "parity" is what the agent-facing contract needs. The contract only needs the observable results, not the Postgres locks.

| Feature | Rust candidates | Tradeoffs | Parity risks |
|---|---|---|---|
| Single-writer transactions (BEGIN, savepoints, read-write vs read-only) | rusqlite (bundled SQLite) with WAL + `BEGIN IMMEDIATE` for writers and one reader pool; redb (MVCC, one write txn at a time); fjall (LSM with keyspaces) | SQLite gives SQL and savepoints; BEGIN IMMEDIATE serializes all writers DB-wide (coarser than the per-key xact locks here); redb has no SQL, so all queries are hand-coded | Savepoints map to SAVEPOINT; READ COMMITTED vs REPEATABLE READ snapshots differ (WAL read txn is a snapshot per read transaction); the two REPEATABLE READ sites and the READ COMMITTED migration lock have no direct counterpart |
| Advisory locks (42 and per-key xact keys) | In-process keyed mutex (dashmap of tokio/parking_lot mutexes) for per-key work; BEGIN IMMEDIATE for cross-process writes; file lock on the DB path (fs4 / fd-lock) for the schema lock | Keyed mutexes are not cross-process; file locks are advisory and need stale-holder reaping (reuse the pid + start-time + boot-id logic in pglite-lock.ts) | Shared vs exclusive derivation-scope locks (page-body/schema.ts:279) need an RW lock per source; hash collisions in hashtext keys disappear |
| Row locks (FOR UPDATE / FOR SHARE / KEY SHARE / NOWAIT) | Under single-writer, all of these become "the write transaction holds"; NOWAIT becomes `busy_timeout = 0`; FOR SHARE on sources (writers wait for purges) becomes a per-source RW lock | Coarser serialization than Postgres row locks: writers on different sources wait on each other unless the app keeps per-source locks | Deadlock-free ordering in lockPageKeys (page-state/guards.ts) is a Postgres requirement; with one writer lock it is moot but any per-key locking added later needs the same sorting |
| SKIP LOCKED job queue | Queue table with lease columns (lock_token, lock_until, claim_generation, attempts_*) claimed with `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING` inside BEGIN IMMEDIATE; or a separate job store (redb table keyed by (queue, priority, created_at, id)) | SQLite has no SKIP LOCKED but single-writer serialization gives the same exactly-one claim; throughput is bounded by the writer | Lease timing uses `now()` and interval math; the Rust port needs one clock source (monotonic for lease duration, wall for persisted timestamps); `claim_generation` trigger rules must become app-level invariants |
| Fenced lease token (gbrain_cycle_locks, acquisition_token) | same table in SQLite with `INSERT ... ON CONFLICT(id) DO UPDATE ... WHERE ttl < ?` (SQLite supports upsert with WHERE since 3.24) | Same semantics; holder pid and host are diagnostic | `FOR KEY SHARE` fence (db-lock.ts:226) has no SQLite equivalent; a fence check inside the same write transaction is equivalent under single-writer |
| LISTEN/NOTIFY (wake idle workers) | tokio::sync::watch or broadcast inside one process; cross-process: `PRAGMA data_version` polling on a read connection, or inotify/notify crate on a sentinel file or the WAL file; Unix socket (the existing persistence/ipc.ts pattern) | Inotify is not reliable on network filesystems; data_version is a poll, cheap (no SQL write) | Loss tolerance is already part of the design (poll backstop, sync-queue-wake.ts:16) so a lossy wake is acceptable |
| Triggers (about 25 plpgsql functions) | SQLite triggers (BEFORE/AFTER, RAISE(ABORT, msg)) for row maintenance; app-level hooks for the GUC guards and cross-table checks | SQLite triggers can not call functions, read other GUCs or call pg_notify; the GUC allowlists (gbrain.write_sources, persistence_protocol) must become app-level checks or a config table read inside the trigger | The managed-writer and protocol triggers are fail-closed: the Rust port must fail the same writes, with the same error codes (P0001 messages) if the contract shows them |
| Advisory xact lock for derivation scope (shared trigger) | write-side "shared" holder = normal write transaction; purge = BEGIN IMMEDIATE | Equivalent when one writer | None if writers are serialized |
| RLS / GRANT / roles | Application authorization in Rust (typed access context passed to every query, as src/core/scope.ts and access/* already do); file permissions on the DB file; no DB roles | Loses defense in depth for a second SQL client; any process with file access sees everything | Hosted Supabase RLS deny-by-default (schema.sql:1830-1832) has no embedded counterpart; the anon key path does not exist in an embedded store. The doctor checks for RLS (pg-access-classify.ts) become moot |
| SECURITY DEFINER / search_path hardening | Not needed in an embedded store; SQLite has no schemas to shadow and no pg_temp equivalent (temp tables still shadow main if not qualified; use `main.` qualifiers) | Shadowing risk is a Postgres-only failure mode | A temp table named `fact_purges` must not shadow in SQLite either; qualify names or disable temp_store for the guard connections |
| Statement timeout / lock_timeout / idle_in_transaction | SQLite `busy_timeout` for lock waits; `sqlite3_interrupt` plus a progress handler for statement deadlines (rusqlite `InterruptHandle`, `progress_handler`); idle transaction timeout via an app-side timer that rolls back | The Postgres timeouts are server-side; the SQLite ones are client-side and need the interrupt to run | Keyword search 8 s bound (keyword-statement-timeout.ts) and the 57014 negative cache must be re-expressed as a deadline on the interrupt; the cache semantics are app-level and portable |
| Cancellation (cancelAndDiscard, CancelRequest) | Cancellation token + `InterruptHandle::interrupt()`; dropping the connection rolls back | In SQLite the interrupt aborts the statement and the transaction is rolled back by the caller | "CANCEL_UNCONFIRMED" class (transaction-abort.ts:55-87) disappears; keep the observable error shape (AbortError with cause) |
| Retries on 40P01 / 40001 / 55P03 | Under single-writer these become SQLITE_BUSY / SQLITE_LOCKED (busy after busy_timeout); retry on BUSY with bounded backoff | No deadlock exists in one-writer design; the retry matcher still needs a BUSY class | Error-class names used by doctor/item-holds (item-holds.ts:110) must map SQLITE_BUSY to the same labels |
| Pools, PgBouncer, pooler routing | Not needed: one connection per process plus a read pool (rusqlite connection pool or r2d2) | Removes PgBouncer parity entirely; the executeRawDirect vs executeRaw split disappears | Pool stall watch (pool-stall-watch.ts) and in-flight watchdog (db.ts:400-440) lose their subject; keep a stall detector on the writer mutex if the contract exposes pg_pool_stalled |
| Introspection (pg_stat_*, pg_locks, pg_blocking_pids, information_schema) | sqlite_master, PRAGMA table_info, PRAGMA index_list, PRAGMA stats; lock holder = lock-file metadata | Different shape; doctor and schema-verify rewrites | Doctor output and schema-verify messages name Postgres views; keep JSON shape where the CLI contract needs it |
| CREATE INDEX CONCURRENTLY, VACUUM, ANALYZE | `CREATE INDEX` (blocks writers, brief), `PRAGMA optimize` / ANALYZE, `VACUUM` (needs no open transaction; blocks writers) or `auto_vacuum=incremental` | The concurrent index build is not needed for correctness; it is needed only to avoid writer stall on large brains | The ANALYZE deferral (analyze-lock.ts) becomes moot; index build duration becomes a visible stall |
| Sequences (SERIAL, nextval, page_generation_clock_seq) | rowid / AUTOINCREMENT; a counter table updated in its own tiny write txn | Postgres sequences are non-transactional (gaps on rollback, not undone); SQLite rowids roll back with the transaction | If any consumer relies on non-rollback uniqueness across aborted transactions (page_generation_clock_seq, 250-269), a separate durable counter is needed |
| COPY | none needed; batched INSERT with prepared statements | none | none observed |
| JSONB operators and trigger-backed JSON validation | SQLite JSON1 functions | out of scope here (pf-1 owns JSONB parity) | |
| Process model (CLI + MCP + cron + hooks on one brain) | (a) single writer daemon that owns the DB file and serves CLI/MCP over a Unix socket (reuse persistence/ipc.ts and cli-socket/server.ts design); (b) SQLite WAL multi-process with BEGIN IMMEDIATE and busy_timeout (CLI and MCP each open the file, writers queue); (c) redb or fjall: exclusive open per process, so only (a) works | (a) gives exact single-writer semantics and one lease owner; (b) needs no daemon but every process must handle SQLITE_BUSY and long write transactions block others; (c) cannot be shared across processes at all | This is the central risk: today on Postgres many processes write concurrently; on PGLite they cannot. Pick (a) or (b) deliberately. (c) reproduces the PGLite single-owner failure (pglite_busy) for every concurrent command |

Suggested first cut (for discussion): SQLite WAL with one writer connection and BEGIN IMMEDIATE, a table-based job queue with lease columns and fenced updates (portable from queue.ts), `PRAGMA data_version` for cross-process wake, a keyed in-process mutex for per-source work, and application-level authorization. Keep the schema-level guards as app checks and a small set of SQLite triggers for the pure row maintenance (search vector, revision counters).

### 14. Parity risks noted

1. Multi-process writers: Postgres supports concurrent writers from CLI, MCP, cron and hooks; PGLite supports one process. The Rust port must pick a model (daemon owner, SQLite multi-writer with BUSY handling, or exclusive file lock) and say which commands fail or wait when another process holds the brain. Any choice that is not a daemon re-creates the pglite_busy failure for concurrent commands.
2. Job exactly-once: the claim relies on `FOR UPDATE SKIP LOCKED` plus `claim_generation` checked by a trigger. Without a DB-level trigger, the protocol invariant (advance by exactly 1 on claim) must be an app invariant and tested.
3. Lease fencing: every completion and renewal is `WHERE lock_token = $token AND status = 'active'`. Keep this exact predicate; a non-fenced update lets a stalled worker finish someone else's job.
4. Time semantics: lock expiry is `lock_until < now() - grace` and `timeout_at < now() AND lock_until > now()`. Postgres `now()` is the transaction start time. Rust must not evaluate these twice with different clocks inside one transaction.
5. Non-durable wake: NOTIFY is lossy; the poll backstop must remain. A `PRAGMA data_version` poll or a file watch is also lossy under load; keep the poll.
6. Fail-closed guards: the managed-writer, protocol and allowlist triggers reject writes with SQLSTATE P0001 and typed messages (for example `writer_coordinator_required`, `git_protocol_required`). Parity requires the same refusal, not only the same data.
7. Derived-state triggers: about 10 trigger functions update derived tables (search vector, revision counters, projection queue, derivation scope). Missing one silently breaks search or purge. Port them as explicit write-path functions with tests that compare outputs with the trigger version.
8. Statement deadlines: keyword search has an 8 s server-side bound (default) and a 600 s negative cache; the Rust port needs an interrupt-based deadline with the same refusal (KeywordSkippedAfterTimeoutError) so callers see the same skip.
9. Isolation: REPEATABLE READ is used in two read paths for a consistent snapshot (ops/pages.ts:159, ops/valid-time-read.ts:318). A single-connection read transaction in SQLite gives an equivalent snapshot only if the read transaction is opened first.
10. Access control: no RLS, no GRANT. Authorization is application code. An embedded store exposes the file to any local process; the doctor checks for BYPASSRLS and grants have no Rust counterpart and should be removed or reported as not applicable.
11. Sequences: `page_generation_clock_seq` (schema.sql:250-269) uses nextval so concurrent writers do not serialize on a tuple. With SQLite and one writer the hotspot disappears, but the monotonic-across-rollback property is lost unless a separate counter is kept.
12. Maintenance: ANALYZE/VACUUM/CREATE INDEX CONCURRENTLY have no SQLite equivalent with the same non-blocking property. Index builds on a large brain will stall writers.
13. Connection-level SQLSTATEs: about 15 distinct SQLSTATEs are branched on. Keep an internal error enum with a mapping table; do not expose SQLite codes in the contract.
14. PGLite checkpoint guard and WASM heap limits: they are PGLite-specific. The Rust port does not need them, but the migration from PGLite data dirs (pglite-repair, pglite-resetwal) is a separate parity item.
15. Migration lock: the schema lock is held across the whole migration run in a READ COMMITTED transaction (init-schema-lock.ts:189-226). The Rust port needs a file lock or BEGIN IMMEDIATE held for the same span, with the same stale-holder reaping and the same operator-facing message.
16. Session defaults through pooler: statement_timeout and idle_in_transaction are startup parameters that PgBouncer drops (db.ts:335-340). The fix in production is ALTER ROLE. The Rust port has no such gap but must not silently drop its bounds.
17. Tests that cover this area: test/e2e/pgbouncer-transaction-pipeline-6930.test.ts, test/init-schema-lock.test.ts, test/e2e/init-schema-lock-blocked.test.ts, test/e2e/persistence-chaos.test.ts, test/e2e/analyze-yields-to-autovacuum-postgres.test.ts, test/e2e/rls-every-table-postgres.test.ts, test/e2e/function-search-path-postgres.test.ts, test/function-search-path-pglite.test.ts, test/jit-off-statement.test.ts, test/core/retry.test.ts, test/migrate.test.ts, test/e2e/postgres-stuck-connection-postgres.test.ts, test/e2e/core-memory-locks-postgres.test.ts. These are the parity suites to port first.

Not covered in depth (time-boxed): the bodies of the about 56 pinned trigger functions in schema.sql 1899-3794 (listed by name), the full persistence/ subsystem (about 150 files, only the lock, coordinator and ipc entry points were read), and the complete SQLSTATE inventory (the grep counts above are approximate).


---

