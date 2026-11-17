# gbrain-evals as the Rust parity oracle

Line numbers refer to gbrain 36bd05806a.

Research map for the Rust rewrite. Read-only inputs: gbrain-evals at `9ecc5b20`, gbrain (TypeScript) at `36bd05806a` (v0.60.733.0), and the installed copy `gbrain-evals/node_modules/gbrain` (v0.41.29.0, pinned in `bun.lock` to `041d89b`).

Path conventions: `eval/...` is relative to `garrytan/gbrain-evals`. `ts:src/...` is relative to `garrytan/gbrain`.

Legend: **[V]** verified this session by reading code or running a grep, `ls`, or a parse. **[D]** taken from a benchmark report in `docs/benchmarks/` and not re-run. **[I]** inferred.

## 0. Summary

- gbrain-evals is a consumer of gbrain. It imports 12 static `gbrain/*` subpaths (plus `transcription` and `package.json` dynamically), constructs `PGLiteEngine` in 26 places across 25 files, and makes 7 deep relative imports into `node_modules/gbrain` that bypass the exports map. **[V]**
- Several runners write raw SQL into gbrain's Postgres schema (`pages`, `content_chunks`, `links`, `sources`, pgvector `::vector`). A Rust engine cannot run those without a SQL shim or a rewrite to ops. **[V]**
- Three things are broken as checked out. `type-accuracy.ts` and `adversarial.ts` call `extractPageLinks` with a stale signature. `longmemeval.ts:55` imports a path that does not exist. The LongMemEval embed-cache fixture that the docs say ships is absent. **[V]**
- The cheapest parity oracle is retrieval-only LongMemEval (500 questions, top-5). Without the cache fixture, the first run costs about $2 in OpenAI embeddings **[D]**.
- Cats 14 and 15 never execute gbrain code. They test prompts copied into the runner. Do not gate Rust on them. **[V]**
- gbrain's own TypeScript repo ships an in-tree LongMemEval harness (`gbrain eval longmemeval`, JSONL, judge, receipts, `--embed-cache`) at `ts:src/commands/eval-longmemeval.ts`. It is a better driver target than the evals runners. **[V]**

## 1. Versions and pins

| Item | Value | Source |
|---|---|---|
| gbrain-evals HEAD | `9ecc5b20` (v0.40.6.0 snapshot) | `git log` |
| Declared gbrain dep | GitHub dependency on `garrytan/gbrain`, ref `master` (unpinned in this historical snapshot, not an install recommendation) | `package.json` at `9ecc5b20` |
| Installed gbrain | 0.41.29.0, lock pin `041d89b` | `node_modules/gbrain/package.json`, `bun.lock` |
| TS gbrain reference | `36bd05806a`, v0.60.733.0 | `ts:package.json` |
| LongMemEval published numbers | gbrain v0.28.8 | `docs/benchmarks/2026-05-07-longmemeval-s.md:4` |
| Snapshot | gbrain v0.40.6.0, commit `677142a6` | `docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md:3-4` |
| BrainBench v0.20.0 baseline | gbrain `96852c0` | `docs/benchmarks/2026-04-23-brainbench-v0.20.0.md:6` |

No single run reproduces every published number. Parity has to be measured against a TS run at one pinned commit, with published numbers used only as sanity checks.

## 2. Benchmark inventory

Paths are under `eval/runner/` unless noted. "Published" numbers are **[D]**. Cost and runtime come from the same reports and the snapshot.

| Runner | Measures and data | Metric and published result | Cost, runtime | gbrain surface |
|---|---|---|---|---|
| `longmemeval.ts` (adapters `keyword`, `vector`, `hybrid`, `hybrid+expansion`) | Session retrieval over the `_s` split: 500 questions, about 50 sessions per haystack, 6 question types | Session R@5: keyword 19.80% (99/500), vector 97.40% (487/500), hybrid 97.60% (488/500), hybrid+expansion 97.60% (488/500) | Cold: about $2 embeddings plus about $1 Haiku. Warm: about $0. Hybrid p50 2.2 s | `PGLiteEngine`, `importFromContent`, `hybridSearch`, `expandQuery`, `loadConfig`, `configureGateway`, `embed`, `searchKeyword`, `searchVector`, raw `TRUNCATE` |
| `multi-adapter.ts` (BrainBench Cats 1+2) | 240 rich-prose pages (`data/world-v1`), 145 auto-derived relational queries | P@5 49.1%, R@5 97.9%, 248/261 for gbrain. Vector-only 10.8/40.7 (v0.20.0 report) | About 3 min, $0 warm | `PGLiteEngine` (`putPage`, `traversePaths`), `runExtract` links and timeline |
| `shootout-driver.ts` + `scripts/run-shootout-phase2.sh` | Same corpus, 90 queries, one hybrid cell per embedder | A0 P@5 18.0%, R@5 63.3% (81/184). Cat 13 subset R@5 94%. Phase 2 cells wedged on the rerank path | About $8 per cell, about 30 min per cell (script header) | `configureGateway`, `setConfig` for `search.mode` and reranker |
| `cat13-conceptual.ts` (Cat 13) | 500 seeded paraphrase probes | nDCG@5: vector 49.1, gbrain 47.0, grep-only 46.2 | About 11 min, about $0.03 | `PGLiteEngine`, `runExtract`, `hybridSearch`, `importFromContent` |
| `cat13b-source-swamp.ts` | 10 curated `originals/` plus 10 long chat pages, 30 queries | Top-1: gbrain 93.3%, vector-only 96.7%, grep-only 80% (vector wins here) | About 50 s, about $0 | same as Cat 13 |
| `identity.ts` (Cat 3) | 100 entities times 8 alias types, 800 queries | Recall@10: documented aliases 100%, undocumented 31% (v1 report) | Hermetic | `putPage`, `searchKeyword`, `upsertChunks` |
| `temporal.ts` (Cat 4) | 50 entities, 10 to 20 dated events | Point, range, recency, as-of all 100% (v1 report). As-of resolved in app code | Hermetic | `putPage`, `addTimelineEntry`, `getTimeline` |
| `cat5-provenance.ts` (Cat 5) | Claim catalog, Haiku classifies supported, unsupported, over-generalized | No published number in repo | Anthropic only | No gbrain import **[V]** |
| `cat6-prose-scale.ts` (Cat 6) | world-v1 pages times 6 injection kinds | Baseline only, no gate | Hermetic | `extractPageLinks` (correct 5-arg form, line 219) |
| `perf.ts` (Cat 7) | Synthetic 1K and 10K pages | 10K P95: `get_page` 0.15 ms, `search_keyword` 0.59 ms, `traverse_paths` d=2 176.4 ms, bulk 5,848 pages/s. Gate `perf.ts:233`: search_keyword P95 at 10K under 200 ms | Minutes, hermetic | `putPage`, `addLink`, `get*`, `listPages`, `searchKeyword`, `traversePaths` |
| `cat8-skill-compliance.ts` (Cat 8) | Sonnet agent drives gbrain tools; 4 iron-law metrics | Thresholds above 0.90, informational. No published number | About $2K estimated (v1 report) | `tool-bridge.ts`, `OPERATIONS` handlers |
| `cat9-workflows.ts` (Cat 9) | About 50 scenarios across 5 workflows | More than 80% pass per workflow. No published number | About $1K estimated | same as Cat 8 |
| `adversarial.ts` (Cat 10) | 22 edge cases times 6 ops = 133 attempts | 133/133 ops, 0 crashes, 0 silent corruption (v1 report) | Hermetic | `PGLiteEngine`, `getPage`, `putPage`, `searchKeyword`, `traversePaths`, `extractPageLinks` (stale, see Section 3) |
| `cat11-multimodal.ts` (Cat 11) | 10 PDFs and 5 audio clips, fixtures not committed | Thresholds only. No published number | Needs OpenAI or Groq keys | `gbrain/transcription` (dynamic) |
| `mcp-contract.ts` (Cat 12) | Trust boundary and input validation, 50 checks | 50/50 (v1 report) | Hermetic | `OPERATIONS`, `op.handler(ctx, params)` at line 61 |
| `cat14-calibration.ts` | Calibrated vs baseline "think" on 8 probes | 75% win, 0% loss, 25% tie. About $0.15 | Under 5 min | **None.** Baseline prompt copied (line 126) |
| `cat15-propose-takes.ts` | Predictions in prose: 8 pages, 48 labeled claims | F1 0.952 (train), 0.922 (unseen) | Under 5 min | **None.** Extract prompt copied (line 128). Corpus lives in gbrain test fixtures |
| `cat18-embedding-providers.ts` | OpenAI, Voyage, ZeroEntropy on 164 pages, 21 queries | Cost $0.0009 to $0.0031 per 164 pages (snapshot) | About 10 min | `executeRaw` on `pg_attribute` and `content_chunks` (line 96) |
| `cat18b-embedding-rerank-matrix.ts` | 6 cells, with and without rerank | R@10 12.2% to 53.7% (snapshot) | About 15 min | `setConfig` for `search.mode` and reranker |
| `cat19-doctor-remediate.ts` | `doctor --remediate` end to end | Brain health 10 to 50 in 115 ms (snapshot) | Hermetic | `executeRaw` INSERT into `links`, UPDATE `embedding::vector`, `getHealth` |
| `cat20-brainstorm.ts` | Novelty, usefulness, grounding, Haiku-judged | 6.3, 6.0, 7.7 out of 10 | About 3 min, about $2 | Deep import `runBrainstorm` (line 22) |
| `cat21-code-retrieval.ts` | voyage-code-3 vs text-embedding-3-large, 12 probes | Top-1 2/12 for both (probe set too small) | About 10 min, about $0.30 | `hybridSearch`, `extractEntityRefs` |
| `cat22-source-isolation.ts` | 3 sources, OAuth scoped to one | 0 leaks across 4 surfaces | Hermetic | `executeRaw` into `sources`, `listPages({sourceId, sourceIds})`, `getPage(slug,{sourceId})`, `hybridSearch({sourceId})` |
| `cat23-phantom-redirect.ts` | 7 phantom slugs to canonical | 1/7 resolved, 2/7 ambiguous correct, 4/7 missed. Snapshot blames PGLite lacking pg_trgm | Hermetic | Deep import `resolvePhantomCanonical` (line 30) |
| `cat24-capture-provenance.ts` | 5 ingest paths, provenance columns | 5/5 round-trip | Hermetic | `executeRaw` SELECT on `pages` provenance columns (line 105) |
| `cat25-trajectory-routing.ts` | `think` with and without trajectory routing | Wave 10/10 vs baseline 9.5/10 | About 2 min, about $0.50 | Deep import `runThink` (line 29), `withTrajectory` flag |
| `cat26-contextual-retrieval.ts` | none, title, synopsis modes | 100% R@10 on a micro corpus | About 3 min, about $0.10 | `setConfig('contextual_retrieval')`, `hybridSearch` |
| `cat27-graph-signals.ts` | Adjacency, cross-source, session-demote signals | Multipliers too small to flip rank 1 | About 2 min | `executeRaw` INSERT into `links` with `ON CONFLICT` (line 265), `setConfig('search.graph_signals')` |
| `cat28-federated-sync-latency.ts` | Serial vs parallel sync | Dominated by PGLite WASM cold start | Hermetic | `executeRaw` into `sources`, `importFromContent` |
| `cat29-think-vs-search.ts` | `think` vs raw `search`, 5 questions, Haiku judge | Search 1.60/10, think 5.60/10 | About 8 min, about $3 | Deep import `runThink` (line 36) |
| `type-accuracy.ts` (Cat 2 per-link type) | world-v1 `_facts` gold vs extracted links | No current result. Broken call (line 160) | Hermetic | `extractPageLinks` (stale) |
| `smoke.ts` | Embedder preflight, 3 phases | Pass or fail only | Cheap | `configureGateway`, `embed` |
| Docs only: Minions, tweet ingest | Job durability and throughput. Minions 10/10 vs sub-agents 0/10; p50 778 ms vs 8,086 ms | Reports in `docs/benchmarks/2026-04-18-*` | Harness lives in gbrain `test/e2e/bench-vs-openclaw/` **[V]**, not here | Out of scope for this repo |

Two notes. The knowledge-runtime report points at `test/benchmark-put-page-latency.ts` in the gbrain repo. That file does not exist **[V]**. Also, the `_s` report describes the warm cache as "~150MB" in §8 and §12, while `eval/data/longmemeval/embed-cache/README.md` says "~700MB". Neither file exists in the checkout (see Section 4).

## 3. Coupling inventory

**Imports [V].** `gbrain/pglite-engine` in 25 import lines. `gbrain/ai/gateway` in 16. `gbrain/import-file` in 15. `gbrain/search/hybrid` in 9. `gbrain/types`, `gbrain/link-extraction`, `gbrain/operations`, `gbrain/extract`, and `gbrain/config` in 3 to 5 each. `gbrain/engine` and `gbrain/search/expansion` in 1 or 2 each. Dynamic: `gbrain/transcription` (Cat 11), `gbrain/embedding` (Cat 19), `gbrain/package.json` (13 runners).

**Deep imports bypassing the exports map [V].** `longmemeval.ts:47,51,55` import `node_modules/gbrain/src/core/embedding.ts`, `.../ai/gateway.ts`, and `.../node_modules/ai/dist/index.mjs`. `cat20-brainstorm.ts:22`, `cat23-phantom-redirect.ts:30`, `cat25-trajectory-routing.ts:29`, and `cat29-think-vs-search.ts:36` import further internals.

**`gbrain/package.json` does not resolve [V].** The exports map has no `./package.json`, so each of the 13 runners falls into its `catch` and records `gbrainVersion: 'unknown'` (for example `cat20-brainstorm.ts:150-154`). Scorecards therefore lose the version.

**Engine surface used [V].** `connect`, `initSchema`, `disconnect`, `putPage`, `getPage`, `listPages`, `searchKeyword`, `searchVector`, `traversePaths`, `addLink`, `getLinks`, `getBacklinks`, `addTimelineEntry`, `getTimeline`, `upsertChunks`, `getStats`, `getHealth`, `setConfig`, `executeRaw`.

**`setConfig` keys [V].** `search.mode` (`conservative`, `balanced`, `tokenmax`), `search.reranker.enabled`, `search.reranker.model`, `search.graph_signals`, `auto_link`, `contextual_retrieval`.

**Options passed [V].** `hybridSearch` takes `limit`, `expansion`, `expandFn`, `sourceId`, `sourceIds`. `importFromContent` takes `noEmbed` and `sourceId`. The TS signatures exist at `ts:src/core/search/hybrid.ts:843,869,1086` and `ts:src/core/import-file.ts:254`.

**Raw SQL against the gbrain schema [V].**
- `cat19-doctor-remediate.ts:89-131`: counts on `pages(deleted_at)` and `content_chunks`; `INSERT INTO links (from_page_id, to_page_id, link_type, link_source) ... ON CONFLICT DO NOTHING RETURNING 1`.
- `cat19-doctor-remediate.ts:211-213`: `UPDATE content_chunks SET embedding = $1::vector, embedded_at = now()`.
- `cat18-embedding-providers.ts:96-99`: `pg_attribute` `atttypmod` on `content_chunks.embedding`.
- `cat22-source-isolation.ts:60`, `cat28-federated-sync-latency.ts:62`, `cat27-graph-signals.ts:187`: `INSERT INTO sources (id, name, config) ... '{"federated": true}'::jsonb ON CONFLICT DO NOTHING`.
- `cat24-capture-provenance.ts:78,105`: `source_kind, source_uri, ingested_via, ingested_at` on `pages`.
- `longmemeval.ts:224-233`: `pg_tables` enumeration and `TRUNCATE ... RESTART IDENTITY CASCADE`, preserving `sources`, `config`, `gbrain_cycle_locks`, `subagent_rate_leases`.

**Stale or broken call sites [V].**
- `type-accuracy.ts:160` and `adversarial.ts:111` call `extractPageLinks(content, {}, type)`. The current signature is `async extractPageLinks(slug, content, frontmatter, pageType, resolver, opts?)` (`ts:src/core/link-extraction.ts:844`). The installed 0.41.29.0 has the same async six-argument form. The type-accuracy call is not awaited, so the `for...of` over a Promise fails. The adversarial call at line 186 is wrapped in `tryOp`, so the failure is recorded rather than thrown.
- `longmemeval.ts:55` imports `node_modules/gbrain/node_modules/ai/dist/index.mjs`. That path is absent. `ai` is hoisted to `node_modules/ai/dist/index.mjs`. The LongMemEval runner therefore fails to resolve its import in this checkout. I did not execute it, so this is a file-existence finding.

**Other drift [V].** `longmemeval.ts:101` and the TS CLI default (`ts:src/commands/eval-longmemeval.ts:414`) are both `topK: 8`. Published runs used 5. The evals runner reads a JSON array. The TS CLI reads JSONL (`eval-longmemeval.ts:463-469`). `CLAUDE.md` cites 314 tests in `test/eval`. A grep finds 278 `test(` or `it(` lines, so the count is approximate.

## 4. Embedding-cache fixtures

**What is in the checkout [V].** `eval/data/longmemeval/embed-cache/` contains only `README.md`. `git log --all` finds no committed `.sqlite` for that path. The docs describe a warm fixture (`eval/data/longmemeval/embed-cache/embed-cache-text-embedding-3-large@1536.sqlite`, "~150MB"). It is not in the repo. Treat the warm cache as lost until someone confirms otherwise.

**evals cache format [V].** File `eval/reports/longmemeval/embed-cache/embed-cache-<model>@<dims>.sqlite` (gitignored). Table `embeddings(model TEXT, text_hash TEXT, vector BLOB, dims INTEGER, created_at INTEGER)` with primary key `(model, text_hash)`. The vector is float32 little-endian. Key is `sha256(text)`, with no side and no normalization. The `model` column stores `model@dims` (`eval/runner/longmemeval-cache.ts:46-54`, `:80-90`). WAL with a 10 s busy timeout. Both corpus chunks and query texts pass through the same cached transport (`longmemeval.ts:355-356`).

**Default when config is missing [V].** `longmemeval.ts:347-348` default to `text-embedding-3-large` at 1536 dims. The snapshot says ZeroEntropy became gbrain's default embedder in v0.36.2 **[D]**. So an unpinned config changes the cache key and the OpenAI-based published numbers stop reproducing **[I]**.

**TS cache format [V].** `ts:src/eval/shared/embed-cache.ts:107-115` defines `embed_cache(key TEXT PRIMARY KEY, model, dims, byte_len, vector BLOB) WITHOUT ROWID`. The key is derived from `(model, dims, text, side)` where side is `query` or `document` (`:132`). The two formats are not interchangeable.

**Size estimate [I].** A 1536-dim float32 vector is 6,144 bytes. A 150 MB cache holds about 24,000 vectors.

**Recommendation.** Define one neutral fixture: `(model_id, dims, side, sha256(text)) -> f32[]`. Generate it once from the TS engine through the test transport seam (`ts:src/core/ai/gateway.ts:797`, `__setEmbedTransportForTests`). Both the TS and Rust engines then read identical vectors. The report's own cold-cache estimate is about $2 for the full `_s` run **[D]**.

## 5. Adapter design

**Driver protocol.** Run one long-lived process per engine and talk to it over JSON-lines on stdio. Use MCP tool names wherever they exist, so the agent surface stays the same:

- MCP-compatible ops: `put_page`, `get_page`, `list_pages`, `search`, `query`, `add_link`, `traverse_graph`, `get_timeline`, `add_timeline_entry`, `get_stats`. The 12 read tools and 3 dry-run tools in `eval/runner/tool-bridge.ts:41-62` already name them.
- Harness-only ops: `reset`, `import_page` (with `noEmbed` and `sourceId`), `run_extract {links|timeline}`, `set_config {key, value}`, `load_embedding_fixture`, `version`.
- Responses are `RankedDoc[]` shaped as in `eval/runner/types.ts:154-160`: `page_id`, `score`, `rank`, `snippet`.

Why not the alternatives: a CLI `--json` process per call is fine for hermetic cats but too slow for 500 LongMemEval questions. HTTP adds a server with no benefit here.

**Shim for the TypeScript side.** Write a thin `oracle-ts` process that implements the protocol over public `gbrain/*` exports (`PGLiteEngine`, `importFromContent`, `hybridSearch`, `operations`). Runners then never import gbrain. This removes the deep imports and the raw SQL from the runners. The shim is the only TS code that touches the schema.

**Embeddings injected, never called [I].** In parity mode, the harness supplies vectors from the fixture (Section 4). Neither engine calls a provider. That isolates ranking and storage from embedding drift. Rust needs a `load_embedding_fixture` hook for this.

**Which runners port trivially**
- `grep-only.ts`: pure TypeScript, no gbrain import **[V]**. Use as the BM25 baseline unchanged.
- `judge.ts` and the Anthropic-only runners (Cats 5, 8, 9, 14, 15, 20, 25, 29): harness-side, portable as-is.
- `longmemeval-cache.ts`, `longmemeval-aggregate.ts`, `longmemeval-batch.sh`, `recorder.ts`: harness-side, reusable.
- `types.ts` scorers, `multi-adapter.ts` scoring, and the six JSON schemas in `eval/schemas/`: portable contracts.
- `mcp-contract.ts`: needs only op dispatch by name plus a `remote` flag. Works over MCP stdio.

**Which need work**
- `longmemeval.ts`: rewrite the ingest and search calls onto the protocol, fix the import, set top-K to 5, and accept JSONL.
- Cats 3, 4, 7, 10: map onto ops. Mostly mechanical.
- Cats 13, 13b, 22, 26, 27, 28: replace `setConfig` keys with explicit protocol knobs.
- Cats 18, 18b, 21: switch from live providers to the fixture.
- Cats 19, 22, 24, 27, 28: replace raw SQL with ops. These are the most Postgres-coupled.

**Cannot apply without a prior change**
- Cats 14 and 15 test copied prompts. First extract the think and extraction prompts into a shared module that both sides import.
- Cats 20, 25, 29 depend on `runBrainstorm` and `runThink`, which exist only in TypeScript. Rust needs its own equivalents, validated by fixtures captured from the TS output.
- Cat 11 needs transcription keys and fixtures that are not committed.
- Cat 23 depends on `pg_trgm` semantics. Decide whether Rust must match that behavior before the cat can measure anything.
- Cat 28 measures PGLite WASM cold start, which is not a product property. Drop or re-target it.

## 6. Proposed phase gates

Each gate compares Rust to a TS run at one pinned commit. Published numbers are sanity checks only.

| Phase | Gate benchmarks | Pass criteria | Needs |
|---|---|---|---|
| P1 storage and search MVP | LongMemEval keyword, vector, hybrid (retrieval only, 500 q, top-5). Cat 13b. Cats 1+2 with graph off. Cat 10. Cat 12 | LongMemEval R@5 within 0.2 points of TS on the same fixture. Cat 12 50/50. Cat 10 133/133. Cat 13b top-1 within 1 point of TS | Fixture, `oracle-ts` shim, protocol |
| P2 knowledge layer | Cats 1+2 full (graph on). Type-accuracy after the call-site fix. Cats 3, 4, 6 baseline, 19, 27 | Cats 1+2 P@5 and R@5 within tolerance of TS (49.1 and 97.9 published). Type-accuracy F1 per type matches TS | Links and timeline ops, `extract` equivalent |
| P3 jobs and cycles | Minions and tweet-ingest (run in gbrain `test/e2e`). Cat 19 remediate | Durability and throughput match TS on the same harness | Harness outside this repo |
| P4 multi-source isolation | Cat 22 (0 leaks). Cat 24 (5/5). Cat 23 only after the `pg_trgm` decision | 0 leaks across 4 surfaces | `sourceId` and `sourceIds` on ops |
| P5 performance | Cat 7 at 1K and 10K. LongMemEval latency | search_keyword P95 at 10K under 200 ms. traverse_paths d=2 at 10K no worse than 176 ms | Ops and perf harness |
| Later, LLM or provider gated | Cats 5, 8, 9, 14, 15, 20, 25, 29. LongMemEval hybrid+expansion. Cats 18, 18b, 21 | Judge-scored, so tolerance bands only | Judge budget, provider keys |

## Rust engine implications

**Preserve exactly**
- Recall definition. The runner takes the top-K chunk results and then deduplicates to sessions (`longmemeval.ts:447-468`). Recall@5 is therefore over chunk hits, not over sessions. A Rust engine that returns the top five sessions will not reproduce the published numbers **[V]**.
- Slug normalization. `putPage` lowercases, but `upsertChunks` does not. The runner lowercases at the boundary (`longmemeval.ts:439`). Decide whether Rust lowercases on write; that is simpler and the TS behavior is a quirk, not a feature **[I]**.
- Chunking granularity (`splitBody`). The keyword 19.8% depends on it **[D]**.
- Scoring constants from the reports: RRF k=60, final re-score `0.7 * rrf + 0.3 * cosine`, compiled-truth boost 2.0, and the source-boost map **[D]**.
- The NDJSON row shape `{adapter, question_id, question_type, retrieved, ground_truth, hit_at_k, num_haystack, latency_ms, error?}` and the resume key `(adapter, question_id)` (`longmemeval.ts:124-138`, `:486`).
- Sealed qrels. Adapters receive only `slug, type, title, compiled_truth, timeline` (`types.ts:56-61`).

**Can simplify**
- PGLite-specific machinery: engine recycling every 25 questions (`longmemeval.ts:317`), the 90 s per-question watchdog (`:394`), and the 3-worker, 10-minute batch wrapper. A Rust in-process index can reset in place.
- Raw `TRUNCATE` by enumerating `pg_tables`. Replace with a `reset` op.
- Two embedding-cache formats. Replace with one fixture.
- Deep imports and `package.json` version capture. Record the binary's version and git SHA instead.

**Postgres feature each piece depends on [V]**

| Piece | Postgres feature | Location |
|---|---|---|
| Keyword search | tsvector and `ts_rank_cd` | Published description of `searchKeyword` (report §4) |
| Vector search | pgvector `vector` type, `::vector` cast, HNSW | `cat19-doctor-remediate.ts:212`, report §4 |
| Reset between questions | `pg_tables`, `TRUNCATE ... CASCADE` | `longmemeval.ts:224-233` |
| Link writes | Unique constraint plus `ON CONFLICT DO NOTHING RETURNING` | `cat19:129`, `cat27:265` |
| Sources | `jsonb` config, `ON CONFLICT` | `cat22:60`, `cat28:62` |
| Provenance | `source_kind`, `source_uri`, `ingested_via`, `ingested_at` columns | `cat24:105` |
| Dimension check | `pg_attribute.atttypmod` | `cat18:96-99` |
| Soft delete | `pages.deleted_at` | `cat19:91,112` |
| Embedded timestamp | `now()` | `cat19:212` |
| Phantom resolution | `pg_trgm` (per snapshot) | `cat23` |

**Risks**
- Oracle drift. The published numbers come from v0.28.8, and the installed copy is 0.41.29.0. Reproduce at one pinned commit before trusting any tolerance.
- Schema coupling. Any runner that touches a column breaks when Rust picks a different schema. Keep runners on ops only.
- Non-determinism. `perf.ts` uses `Math.random()` for sampling (lines 176, 182). Haiku expansion drifts up to 0.2 points (report §11). `multi-adapter.ts` is seeded (`shuffleSeeded`).
- Silent provider drift. An unpinned embedder changes the cache key and the published numbers.
- Broken Cat 2 and misleading Cat 14. Type-accuracy does not run as checked out. Cat 14's win rate measures a copied prompt, not gbrain code.

## Open questions

1. Which gbrain commit is the parity target: the installed 0.41.29.0 (`041d89b`), TS master (`36bd05806a`), or the v0.28.8 published baseline? Parity needs one, pinned in the harness.
2. Is the warm LongMemEval cache recoverable from another machine? If not, is a ~$2 regeneration acceptable?
3. Should the parity driver be the TS repo's `gbrain eval longmemeval` (judge, receipts, `--embed-cache`, `--call-plan`) rather than `longmemeval.ts`? It already exists and is maintained with the engine.
4. Should `eval brainbench` in the TS repo (know-to-ask, push, write-back, continuity; fixtures in `ts:evals/brainbench`) join this oracle? It shares the name "BrainBench" but is a different suite. The naming collision needs a rename or a note.
5. Should Cats 14 and 15 wait until their prompts are moved into gbrain code, or be dropped from parity entirely?
6. Who owns the shim that replaces deep imports, and does it live in the TS repo or in gbrain-evals?
7. Do we require Rust to match `pg_trgm` phantom-redirect semantics (Cat 23), or accept a documented difference?
8. Should the embedder default in the oracle stay OpenAI (matching published numbers) or move to the current ZeroEntropy default?
9. Does the multimodal fixture set (Cat 11, `eval:fetch-multimodal`) exist anywhere? The script it names is not in `package.json` **[V]**.
