> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# g10: Selecting a Rust BrainEngine in gbrain-evals

Scope: how each gbrain-evals runner would pick a third engine, `'rust'`, next to `'pglite'` and `'postgres'` in the TypeScript gbrain at the pin. Read-only; no evals were run, no keys used.

Roots and pins:
- gbrain pin: `6ce7195b44a034f85aec811f11fbf862db376f50`, read with `git show` in a gbrain checkout. Paths below marked `gbrain:` are relative to that pin.
- gbrain-evals: the gbrain-evals checkout (HEAD cd447b3). Paths below marked `evals:` are relative to that root.

Bucket key:
- A: already engine-agnostic (config, env, or injected factory picks the engine; zero or one-line change).
- B: hard-codes `new PGLiteEngine()` but calls only public BrainEngine methods; swap the constructor through one helper.
- C: raw SQL or PGLite internals (`executeRaw`, `.db`, `information_schema`, `pg_*`, snapshot dirs); needs real work.
- D: out-of-process (spawns `src/cli.ts` or `gbrain serve`); engine is chosen by the brain config the CLI reads.
- E: Postgres-specific; stays Postgres-only unless a Rust arm is designed on purpose.

---

## 1. BrainEngine at the pin, and how the CLI picks an engine

### 1a. Interface (gbrain:src/core/engine.ts)

- `export interface BrainEngine` spans lines 830 to 2890: 197 method signatures (unique names) plus one property, `readonly kind: 'postgres' | 'pglite'` (line 832). Three members are optional: `holdSchemaMigrationLock?`, `findDuplicatePage?`, `findDuplicatePages?`.
- `executeRaw<T>(sql, params?, opts?)`: yes, line 2714. Also `executeRawDirect` (2732) and `keywordBoundedRead` (2745).
- `transaction` (849) and `transactionDirect` (851): yes. `withReservedConnection` (about 860) returns a `ReservedConnection` (interface at 249 to 263), which itself has `executeRaw` (258).
- `executeRawJsonb`: not in the interface. It appears only in a doc comment (line 1963).
- `capabilities`: not present.
- `kind` is a closed union. A `'rust'` value is a type error until the union is widened.
- Lifecycle methods that a Rust engine must honor: `connect(config)` (835), `disconnect` (836), `reconnect(ctx?)` (845, recovers with the config captured at the last connect), `initSchema` (846).

Raw SQL is a core contract, not an eval detail. gbrain itself writes `INSERT INTO sources` in 19 places (for example `gbrain:src/core/engine-sql/bootstrap.ts:431`, `gbrain:src/core/persistence/source-lifecycle.ts:337`). The Rust engine's `executeRaw` must accept Postgres-dialect SQL with `$n` params, or core paths fail regardless of the eval runners.

### 1b. `engine.kind` branches that a `'rust'` engine would trip

About 375 `engine.kind` references in 211 files of `gbrain:src`. Two patterns matter:
- Hard failures: `gbrain:src/core/db-lock.ts` throws `Unknown engine kind for db-lock` (line 378) for any kind other than postgres or pglite. The same pattern is at line 626 (`selectLockRows`). The DB lock is used by 67 import sites including the skillopt path (`evals:test/eval/cat30-skillopt-improvement.test.ts:9` notes "the skillopt DB lock needs engine.kind").
- Wrong branch: `!== 'postgres'` is treated as PGLite-like, and the non-PGLite fallback often runs Postgres SQL. Example: `gbrain:src/commands/doctor/checks/database-encoding.ts:15-19` returns early for `kind === 'pglite'`, otherwise runs `SHOW server_encoding`.

### 1c. How the CLI selects the engine (out-of-process path)

1. Config file: `$GBRAIN_HOME/.gbrain/config.json` (`gbrain:src/core/config.ts`, `configDir()`; GBRAIN_HOME is read lazily).
2. Env vars do not pick the kind. `GBRAIN_DATABASE_URL` or `DATABASE_URL` force `'postgres'` (`gbrain:src/core/config.ts:683-684`, inference at 744 to 746). No `GBRAIN_ENGINE` exists. The `GBRAIN_PGLITE_*` vars only tune PGLite.
3. Inference in `loadConfig` (`gbrain:src/core/config.ts:744-746`): `dbUrl ? 'postgres' : fileConfig.engine || (fileConfig.database_path ? 'pglite' : 'postgres')`. A file value `"engine": "rust"` passes through unchanged.
4. Writers: `gbrain init --pglite` writes `engine: 'pglite', database_path` (`gbrain:src/commands/init.ts:1214-1216`; default path `gbrainPath('brain.pglite')`, line 1092). Plain `gbrain init` writes `engine: existing?.engine ?? 'postgres'` (`init.ts:975`). There is no `--engine` flag.
5. Dispatch: `connectEngine` (`gbrain:src/cli/main.ts:2705`) calls `connectEngineForServe` (`gbrain:src/core/engine-connect.ts:76`), which calls `createEngine(engineConfig)` with `engineConfig = toEngineConfig(config)` (`engine-connect.ts:86-90`; `toEngineConfig` at `config.ts:1968` forwards `engine`).
6. Construction: `constructEngine` (`gbrain:src/core/engine-construct.ts:10-24`) switches on `config.engine`: `'pglite'` and `'postgres'` cases, default throws `Unknown engine type`.
7. Type unions to widen for `'rust'`: `gbrain:src/core/types.ts:2343` (`EngineConfig.engine`), `gbrain:src/core/config.ts:37` (`GBrainConfig.engine`), `gbrain:src/core/engine.ts:832` (`kind`), and `gbrain:src/core/engine-open.ts:94` (the experimental `openEngine` validator).

How an out-of-process runner would select `'rust'`: write `{"engine": "rust", "database_path": "..."}` into `$GBRAIN_HOME/.gbrain/config.json` and run a gbrain checkout whose `constructEngine` has a `'rust'` case. Evals already do this by hand: `evals:eval/runner/evidence-delivery/e3.ts:159` writes `engine: 'pglite'` directly.

One gbrain change that makes the CLI build a Rust brain: add `case 'rust'` to `constructEngine`, widen the three unions, and give `init` a `--rust` (or `--engine rust`) flag. The hard-coded pglite path in `init` (`init.ts:1144-1146`, `createEngine({engine:'pglite'})` then `connect({database_path, engine:'pglite'})`) and the config write at `init.ts:1216` become a choice. The init pglite path also runs schema, reranker default, and embedding-identity steps, so the Rust engine must support those calls.

---

## 2. Classification table

Common set used below (present on every engine and called directly by the simplest runners): `connect, disconnect, initSchema, setConfig, getConfig, getPage, putPage, listPages, getChunks, searchKeyword, getLinks, addLink, getTimeline, getStats, executeRaw`. "Beyond" lists direct engine calls outside that set. Most H-tier runners also reach the rest of the interface through gbrain code they import (`src/core/operations.ts`, `import-file`, `search/hybrid`, `extract`), so a partial engine fails inside gbrain, not at the call site.

Construction column: `file:line` of `new ...Engine()` or `createEngine`, then the `connect()` arguments. `{}` means in-memory PGLite.

Family column: registry id for offline-tier (H) scripts, otherwise the directory family.

### 2a. Offline tier (H) scripts, the 44 entries in `evals:eval/registry.ts` with `tier: 'H'`

| file | family | bucket | construction (file:line; connect) | beyond common | raw SQL / internals | smallest change |
|---|---|---|---|---|---|---|
| eval/runner/a4-abstention.ts | abstention (A4) | C | 275 via importGbrain pglite (270); connect({}) 276 | drives operations.ts, search/crag | 291 `SELECT p.slug, c.chunk_text FROM content_chunks ... JOIN pages` | openEvalEngine(gut); replace SQL with getChunks per page, or keep executeRaw subset |
| eval/runner/adversarial.ts | adversarial-robustness | B | 208 `new PGLiteEngine` from static pinned import (15); connect({}) 209 | traversePaths | none | pass gut, use openEvalEngine(gut) |
| eval/runner/agent-retrieval-shapes.ts | agent-retrieval-shapes | C | 350 via importGbrain (345); connect({}) 351 | none direct | 379 `sut.sql = executeRaw`; 460 `SELECT source_id, count(*) FROM pages GROUP BY source_id`; 482 `count(*) FROM pages WHERE page_kind='image'` | openEvalEngine; counts via countPagesBy (public) |
| eval/runner/before-after.ts | relational-graph-first | B | 231 static import (19); connect({}) 232 | traversePaths, putPage, getStats | none | pass gut, openEvalEngine |
| eval/runner/cat11-multimodal.ts | text-ingestion-fidelity | B | 536 static import (54); connect({}) 537 (in-memory) | getChunks | none (image path passes null engine, 546-547) | openEvalEngine |
| eval/runner/cat19-doctor-remediate.ts | doctor-remediation | C | 282 static import (54); connect({}) 283 | getHealth | 142-145 `(SELECT COUNT(*) FROM links), (SELECT COUNT(*) FROM content_chunks)` | keep executeRaw subset or derive counts from getStats |
| eval/runner/cat22-source-isolation.ts | source-isolation | C | 238 static import (38); connect({}) 239 | listPages, traverseGraph, setConfig | 95 `INSERT INTO sources`; 102 `SELECT id FROM pages WHERE source_id, slug`; 149 `INSERT INTO links` | needs ensureSource (no public source-create); addLink for 149 |
| eval/runner/cat23-phantom-redirect.ts | phantom-redirect | B | 201 static import (48); connect({}) 202 | none direct | none | openEvalEngine |
| eval/runner/cat24-capture-provenance.ts | capture-provenance | C | 208 static import (63); connect({}) 209 | none | 126 `SELECT source_kind, source_uri, ingested_via, ingested_at, source_path FROM pages`; 238 `... FROM pages LIMIT 0` (column probe); 355 `SELECT id, updated_at FROM pages` | getPage fields; replace the LIMIT 0 probe with a getPage field check |
| eval/runner/cat27-graph-signals.ts | graph-signals | C | 364 static import (64); connect({}) 366 | setConfig x4 (common) | 305 `INSERT INTO sources`; 335, 342 `SELECT id FROM pages` | getPage for id; ensureSource |
| eval/runner/cat28-federated-sync-latency.ts | federated-sync-latency (exclusive) | C | 101 static import (52); connect({}) 102 | none | 106 `INSERT INTO sources`; 125 `SELECT COUNT(*) FROM pages` | countPagesBy; ensureSource |
| eval/runner/cat34-brainbench-memory.ts | brainbench-memory-conformance | D | no construction; `Bun.spawnSync(['bun', <gut>/src/cli.ts, 'eval', 'brainbench'])` at 268 to 278 | n/a | none in runner | engine chosen by child GBRAIN_HOME config (section 1c); not verified whether gbrain brainbench hard-codes pglite |
| eval/runner/cat36-associative-retrieval.ts | associative-retrieval-smoke | C | none here; dynamic import of cat36-production.ts (345) | see next row | see next row | see next row |
| eval/runner/cat36-production.ts (called by the row above) | associative-retrieval-smoke | C | 241 `new PGLiteEngine` from `${productPackage}/pglite-engine` (202-203); connect({database_path}) 243, 342 | setConfig (common) | 258 `INSERT INTO sources`; 276 `UPDATE pages SET created_at`; `copyCat36Snapshot` copies a PGLite data dir (244) | snapshot dir copy is PGLite-internal; needs export/import or re-index |
| eval/runner/cat37-memory-poisoning.ts | memory-poisoning | C (via memory-trust/sut.ts) | none here; `openTrustSut` | n/a | sut.sql 313 (`pages.frontmatter ? 'quarantine'`), 553 (`facts`, `pages`, `write_gate_holds` strpos) | sut.sql to public counts, or executeRaw subset |
| eval/runner/cat38-state-resolution.ts | state-resolution | C (via sut.ts) | none here; importGbrain (79) | n/a | sut.sql 386, 391 `UPDATE persistence_brain`; 388 `UPDATE sources SET local_path`; 467 `SELECT id, fact FROM facts ... expired_at IS NULL` | persistence_brain is gbrain-schema-specific; needs UPDATE support |
| eval/runner/cat39-deletion-audit.ts | deletion-audit | C (via sut.ts) | none here; importGbrain (56) | n/a | 370 `SELECT id, slug FROM pages`; 401-404 SELECT over facts, takes, pages, content_chunks with `lower()` and `~` regex | regex predicate is Postgres-specific; JS scan over listPages and getChunks |
| eval/runner/cat6-prose-scale.ts | prose-autolink-precision | C | 781 via dynamic pinned `gbrain/pglite-engine` (778); connect({}) 794 | initSchema (common) | 784-788 `SELECT ... FROM links JOIN pages WHERE f.slug LIKE $1` | getLinks per page, no SQL |
| eval/runner/forward-reference-heal.ts | forward-reference-heal (P5-H4) | C | no own construction; `openP5Brain` (p5-brain.ts:70-71, connect({})) and `openP5HttpBrain` | n/a | via p5-brain.ts:94 `edges()` SQL | fix `edges()` once (section 4); http arm stays D |
| eval/runner/identity.ts | alias-keyword-lookup | B | 113 static import (30); connect({}) 114 | none (searchKeyword, getChunks common) | none | openEvalEngine |
| eval/runner/lifecycle-experiment.ts | memory-lifecycle | D | no construction; CLI cells run `init --pglite --path` (191); Postgres via `new SQL(pgAdminUrl)` (194) | n/a | Postgres admin `DROP DATABASE ... WITH (FORCE)` (287) | add a rust arm to the CLI path; skip admin SQL for rust |
| eval/runner/line-grammar-typing.ts | link-typing (P5-H1) | C | via openP5Brain (p5-brain.ts:70-71) | n/a | via p5-brain.ts:94 | as forward-reference-heal |
| eval/runner/mcp-contract.ts | mcp-operation-contract | B | 101 static import (40); setupEngine connect({}) 102 | putPage, addLink, setConfig | none | openEvalEngine in setupEngine(); pass gut to ctx() (146) |
| eval/runner/n1-knowledge-update.ts | knowledge-update (N1, N1-ci) | B | 346 and 414 via importGbrain (343, 412); connect({}) 348, 417 | none | none | openEvalEngine at both sites |
| eval/runner/n12-format-fidelity.ts | format-fidelity | B | 457 via importGbrain (455); connect({}) 458 | setConfig (common) | none | openEvalEngine |
| eval/runner/n13-code-intelligence.ts | code-intelligence | C | 197 via importGbrain (190, uses opts.gut); connect({}) 198 | none | 211-218 counts: `pages WHERE type='code'`, `content_chunks`, `symbol_name`, `code_edges_symbol`, `code_edges_chunk` | code_edges_* are gbrain tables; getCalleesOf and getEdgesByChunk where possible |
| eval/runner/n14-large-page-fidelity.ts | large-page-fidelity (exclusive, 600 s) | C (+E) | 699 PGLite via importGbrain (672), connect({}) or `{database_path}` 700; 696 PostgresEngine (importGbrain 688), connect poolSize 10 (697) | none | executeRaw helper 723; 828 `SELECT body_storage, body_bytes, segment_count, body_generation FROM pages`; 847 `text_projection_revision` | body-segment columns are internal; keep PGLite-only in phase 1 |
| eval/runner/n15-skillopt-method.ts | skillopt-method (N15) | B | no own construction; `openBrain` in skillopt-method/headroom.ts:360-361, connect({}) | setConfig | none | openBrain swap; paid stages not offline |
| eval/runner/n2-contradiction-surfacing.ts | contradiction-surfacing (N2) | C | 310 via importGbrain (304); connect({}) 311 | disconnect (x3) | 337 `SELECT p.slug, c.chunk_text ... JOIN`; 345-348 md5/string_agg signature over pages and chunks | executeRaw subset (md5, string_agg), or hash in JS from getPage and getChunks |
| eval/runner/n3-temporal-asof.ts | temporal-asof (N3) | C | 216 via importGbrain (212); connect({}) 217 | setConfig x3 | 231 sut.sql = executeRaw; 335 `slug = ANY`; 341 `slug LIKE 'life/events/%'`; 344 `FROM facts WHERE dimension='employer'` | executeRaw subset, or countPagesBy and listFactsSince |
| eval/runner/n4-entity-resolution.ts | entity-resolution (N4) | C | 413 via importGbrain (307, 314); connect({}) 414 | insertFact | 431 `INSERT INTO sources`; 448 `SELECT ... FROM pages`; 453 aliases; 470 facts | ensureSource; resolveAliases (public) for aliases |
| eval/runner/n4-similar-pages.ts | similar-pages (P5-H5a) | C | 109 via importGbrain (104); connect({}) 110 | none | 114 `INSERT INTO sources`; 116 `SELECT count(*) FROM pages` | countPagesBy; ensureSource |
| eval/runner/n5-forget-residue.ts | forget-residue (N5, N5-ci) | D | no construction; lifecycle/slice.ts:179 `--pglite --path`; Postgres admin at 182 | n/a | none in runner | CLI path; `ENGINES` at lifecycle/slice.ts:37 hard-codes 'pglite' and 'postgres' |
| eval/runner/n6-visibility-fuzz.ts | visibility-leak-fuzz (N6) | C | 636 via importGbrain (393); connect({}) 637 | executeRaw | 555 `INSERT INTO sources ... WHERE NOT EXISTS`; 613 SELECT chunks; 646 COUNT | executeRaw subset; ensureSource |
| eval/runner/n7-open-loops-email.ts | open-loops-email (N7) | C | 315 via importGbrain (303); connect({}) 316 | none | 319 `INSERT INTO sources ... last_sync_at`; 359, 480, 764 SELECT open_loops; 445 UPDATE open_loops; 491, 777 DELETE FROM open_loops | use gbrain's loops-store API (src/core/loops/loops-store.ts) via gut; ensureSource |
| eval/runner/n8-proactive-recall.ts | proactive-recall (N8) | C | 296 via importGbrain (292); connect({}) 297 | softDeletePage | 473 `INSERT INTO sources` | ensureSource |
| eval/runner/n9-multi-hop-paraphrase.ts | multi-hop-paraphrase (N9) | C | no own construction; engine supplied to afterIndex (361) and RelationalSearch (relational-ab.ts:89) | n/a | 369 `SELECT DISTINCT f.slug, t.slug FROM links JOIN pages` | getLinks per page |
| eval/runner/perf.ts | pglite-latency (exclusive) | B | 296 static import (29); connect({}) 297 | traversePaths x2, getBacklinks x2, listPages, getTimeline, addLink, putPage x2, searchKeyword, getPage | none | openEvalEngine; both engines must use the same ctor path for fair latency |
| eval/runner/relation-line-variants.ts | relation-line-variants (P5-H2) | C | via openP5Brain (p5-brain.ts:70-71) | n/a | via p5-brain.ts:94 | as forward-reference-heal |
| eval/runner/system-one-jev.ts | system-one-jev-record (SO) | D | no construction; `spawnSync('bun', [<gut>/src/cli.ts, ...])` (249, 301); env `GBRAIN_HOME` (253) | n/a | none | CLI path (section 1c) |
| eval/runner/temporal-edges.ts | temporal-edges | C | 89 via importGbrain (87); connect({}) 90 | setConfig, getConfig, readPageSnapshot | 128 `FROM link_transitions lt JOIN ...`; 253 `link_relationships`; 266 closures; 284 `to_regclass('link_transitions')` | executeRaw subset plus to_regclass; gbrain temporal tables |
| eval/runner/temporal-ingest-answer.ts | temporal-ingest-answer (P1-E3) | B | 160 via importGbrain (158); connect({}) 161 | readPageSnapshot | none | openEvalEngine |
| eval/runner/temporal.ts | timeline-round-trip | B | 505 static import (43); connect({}) 510 | getTimeline and addTimelineEntry via helpers | none (file has a NUL byte; read with grep -a) | openEvalEngine |
| eval/runner/type-accuracy.ts | link-type-accuracy | none | no engine; pure `gbrain/link-extraction` (static import, 34) | n/a | none | no change |
| scripts/generate-v0.41-launch.ts | qrels-regression | B | 113 via dynamic import from `GBRAIN_SRC` or node_modules (33); connect({}) 114 | importFromContent (function) | none | openEvalEngine; GBRAIN_SRC is already a checkout root |

H-tier totals: B 13, C 26, D 4, none 1 (44 scripts).

### 2b. Other eval/ and scripts/ files that construct an engine (58 files)

| file | family | bucket | construction (file:line; connect) | beyond common | raw SQL / internals | smallest change |
|---|---|---|---|---|---|---|
| eval/harness-provider/mpw_tools/store-census.ts | harness-provider | C | 36-37 via dynamic import (26); connect({engine:'pglite', database_path}) | n/a | 38-41 `to_regclass`, `information_schema.columns` | executeRaw subset; not offline tier |
| eval/precisionmembench/seed.ts | precisionmembench | B | 62-63; connect({}) | n/a | none found | openEvalEngine |
| eval/runner/adapters/claude-sonnet-with-tools.ts | adapters (paid) | B | 232-233; connect({}) | n/a | none | openEvalEngine |
| eval/runner/adapters/gbrain-inline.ts | adapters | B | 184-185; connect({}); PGLite via `${pkg}/pglite-engine` (94) | n/a | none | openEvalEngine |
| eval/runner/adapters/vector-grep-rrf-fusion.ts | adapters | B | 109-110; connect({}) | n/a | none | openEvalEngine |
| eval/runner/budgeted-delivery/c8k-product.ts | budgeted-delivery | C | 102-103; connect({database_path}) | n/a | 140 `COUNT(*) FROM pages`; 146 facts counts; 162 `DELETE FROM config` | executeRaw subset |
| eval/runner/cat14-calibration.ts | calibration (cat14) | C | 353-361; connect({}) | n/a | 382 `executeRaw(...)` write | executeRaw subset |
| eval/runner/cat18-embedding-providers.ts | embedding-providers (cat18) | C | 317-318; connect({}) | n/a | 348 coverage SQL | executeRaw subset |
| eval/runner/cat18b-embedding-rerank-matrix.ts | rerank-matrix (cat18b) | C | 300-301; connect({}) | n/a | 337 coverage SQL | executeRaw subset |
| eval/runner/cat20-brainstorm.ts | brainstorm (cat20) | B | 515-516; connect({}) | not opened in full | none found | openEvalEngine |
| eval/runner/cat21-code-retrieval.ts | code-retrieval (cat21) | C | 314-315; connect({}) | n/a | 350 `SELECT 1 FROM pages WHERE slug` | getPage |
| eval/runner/cat25-trajectory-routing.ts | trajectory-routing (cat25) | B | 366 in seedProbeEngine (363); connect({}) 372 (fresh in-memory per probe, line 30) | setConfig | none found | openEvalEngine |
| eval/runner/cat26-contextual-retrieval.ts | contextual-retrieval (cat26) | C | 478-484; connect({}) | n/a | 421 `SELECT chunk_text` | executeRaw subset |
| eval/runner/cat29-think-vs-search.ts | think-vs-search (cat29) | B | 767-777; connect({}) | not opened in full | none found | openEvalEngine |
| eval/runner/cat30-skillopt-improvement.ts | skillopt (cat30) | A | 544-545; `options.engineFactory ? ... : new PGLiteEngine()` (544); seam at 271-272 | n/a | none | default factory to openEvalEngine; db-lock needs rust kind (section 1b) |
| eval/runner/cat31-skillopt-ablation.ts | skillopt (cat31) | A | 345-346; engineFactory seam at 151 | n/a | none | as cat30 |
| eval/runner/cat32-skillopt-reward-hacking.ts | skillopt (cat32) | A | 371-372; engineFactory seam at 274 | n/a | none | as cat30 |
| eval/runner/cat33-skillopt-transfer.ts | skillopt (cat33) | A | 407-408; engineFactory seam at 154 | n/a | none | as cat30 |
| eval/runner/cat35-transcript-distill.ts | transcript-distill (cat35) | C | 556-557 `makeEngine`; connect({}) | n/a | 1067 `engineA.executeRaw(...)` SELECT | executeRaw subset |
| eval/runner/cat36-production.ts | see section 2a | C | see 2a | see 2a | see 2a | see 2a |
| eval/runner/cat41/brief-db.ts | operator brief (cat41) | A | 19-22 `createEngine(toEngineConfig(cfg))` from `/opt/gbrain/src` (19) | n/a | none | none for rust: set config `engine` |
| eval/runner/chronicle-lift.ts | chronicle-lift | B | 248-250 dynamic from GBRAIN constant; connect({database_path}) 250 | n/a | 2 SQL-ish hits, not verified | openEvalEngine |
| eval/runner/evidence-delivery.ts | evidence-delivery | B | 399-412 dynamic from `g.dir` (399); connect({engine:'pglite', database_path}) 412 | setConfig, initSchema, importFromContent | none | openEvalEngine(g.gut) |
| eval/runner/feedback-replay-locomo.ts | feedback-replay (locomo) | C | 127-128; connect({}) | n/a | 88-89 `DELETE FROM retrieval_weights/events`; 173 INSERT | executeRaw subset |
| eval/runner/feedback-think-replay.ts | feedback-think-replay | C | 183-184; connect({}) | n/a | 129-130 DELETE; 142 SELECT retrieval_event_pages; 144 count retrieval_feedback | executeRaw subset |
| eval/runner/graph-backend/pg-load.ts | graph-backend (PG vs PGLite) | E | 18 PGLite (17, connect database_path) and 22 PostgresEngine (21, connect database_url) | n/a | 28 TRUNCATE; 39 `setval(pg_get_serial_sequence)`; 50-51 VACUUM ANALYZE; 54 `pg_total_relation_size` | keep Postgres-only; a rust arm needs its own SQL |
| eval/runner/graph-backend/worker.ts | graph-backend | E | 42 PGLite (database_path), 46 PostgresEngine (database_url) | n/a | 54 `SELECT ... WHERE id = ANY($1::int[])` | as pg-load |
| eval/runner/live-recall/brain.ts | live-recall (read-only prod copy) | E | 340-352 `createEngine` with `engine:'postgres'` hard-coded (340); connect(engineConfig) 352 | n/a | read-only Postgres queries | keep Postgres-only |
| eval/runner/live-recall/run.ts | live-recall | C | 431-432; connect({}) 433 | n/a | 436 `CREATE TABLE public.<marker>`; 437 `SET default_transaction_read_only`; 480 `pg_extension` | executeRaw subset |
| eval/runner/live-recall/synthetic.ts | live-recall synthetic | C | 141-143; connect({}) | n/a | 161, 165, 175 SELECTs; 164 `UPDATE content_chunks SET embedding = NULL`; 184-185 CREATE TABLE, SET | executeRaw subset |
| eval/runner/longmemeval-m-pilot-build.ts | longmemeval-m pilot | C | 199-200; connect({database_path: outputDir/index}) | n/a | index snapshot dir (254, cat36 snapshot hash) | snapshot path is PGLite-internal |
| eval/runner/longmemeval-m-pilot-import-check.ts | longmemeval-m pilot | B | 19-20; connect({}); pinned `gbrain-cues/pglite-engine` (4) | n/a | none | openEvalEngine (gbrain-cues pin, not overlay) |
| eval/runner/longmemeval-m-pilot-replay.ts | longmemeval-m pilot | B | 179-180; connect({database_path}); pinned `gbrain-cues` (5) | n/a | none found | openEvalEngine (gbrain-cues pin) |
| eval/runner/longmemeval.ts | longmemeval (main) | C | 1268-1269 and 1295-1296 (re-created in loop); connect({}) | n/a | 407 `resetTables`; 491 `pinSearchConfig` | executeRaw subset for reset |
| eval/runner/memory-qa/run.ts | memory-qa | C | 613-629 `openEngine` (connect({}), initSchema, setConfig); 614 `new` | n/a | 621 `SELECT tablename FROM pg_tables`; 623 `TRUNCATE ... RESTART IDENTITY CASCADE`; 665 facts SQL | reset via public deleteAll-style calls; else executeRaw |
| eval/runner/memory-trust/sut.ts | memory-trust (cat37-39 SUT) | C | 179 (dumpable) and 215 (template); connect({}) 181, 219 | n/a | 118-123 information_schema; 183 `engine.db.dumpDataDir('none')` (PGLite internal); 225-254 `UPDATE persistence_brain`; 177-217 `GBRAIN_PGLITE_SNAPSHOT` | central C file for cat37-39; needs executeRaw UPDATE and a snapshot story |
| eval/runner/messy-company/load.ts | messy-company | B | 60-62 `opts.engine ?? new PGLiteEngine`; connect(database_path or {}) | n/a | none found | openEvalEngine |
| eval/runner/multi-adapter.ts | multi-adapter (paid) | B | 163-164; connect({}) | n/a | none found | openEvalEngine |
| eval/runner/n2-3-prompt-ab.ts | prompt-ab (N2-3) | B | 117-118 via importGbrain (112); connect({}) | n/a | none found | openEvalEngine |
| eval/runner/n2-judge-replay.ts | judge-replay (N2) | B | 81-82 via importGbrain (77); connect({}) | n/a | none found | openEvalEngine |
| eval/runner/n6-postgres-http.ts | visibility over HTTP (Postgres) | E | 361-362 PostgresEngine (importGbrain 296); connect poolSize 4 | n/a | spawns `gbrain serve --http` (351) | keep Postgres-only |
| eval/runner/nightly/tool-contract.ts | nightly tool-contract | B | 69-70 via `mod(root, ...)`; connect({}) | n/a | none found | openEvalEngine |
| eval/runner/nightly/worker.ts | nightly worker | E | 108-110 PostgresEngine (dynamic from root); connect poolSize 1 | n/a | pg-template | keep Postgres-only |
| eval/runner/p5-agent.ts | p5-agent | C | 124, 139, 152 (`new` per call); connect({database_path}) | n/a | 125 pages SELECT; 140 pages count; 141 links count; 153 links SELECT | executeRaw subset or getLinks |
| eval/runner/p5-brain.ts | p5 shared brain (openP5Brain) | C | 70-71 `new PGLiteEngine`, connect({}) (central helper for 3 H scripts) | initSchema, setConfig | 94 `edges()` SQL `links JOIN pages` | single fix: edges() via getLinks over listPages |
| eval/runner/p8-quote-grounding.ts | quote-grounding (P8) | B | 328-329 via importGbrain (296); connect({}) | n/a | none found | openEvalEngine |
| eval/runner/predictive/out-of-view/reach.ts | predictive out-of-view | B | 73-75 via importGbrain (71); connect({}) | n/a | none found | openEvalEngine |
| eval/runner/predictive/scale-latency/build.ts | predictive scale-latency | B + E | 174-175 PGLite (connect({})); 177-180 `createEngine({engine:'postgres'})` for Postgres target | n/a | none (PG branch) | openEvalEngine for PGLite target; PG branch stays E |
| eval/runner/refresh-barrier/child.ts | refresh-barrier | E | 29-31 PostgresEngine (dynamic from RB_GBRAIN_ROOT); connect poolSize | n/a | none in file | keep Postgres-only |
| eval/runner/refresh-barrier/retrieval.ts | refresh-barrier | B | 60-61 in a generated script; PGLite; connect({}) | n/a | none found | openEvalEngine in generated script |
| eval/runner/refresh-barrier/trial.ts | refresh-barrier | E + B | 116 PostgresEngine (connect database_url); 119 PGLite (connect({})) | n/a | none in file | keep PG arm; PGLite arm via openEvalEngine |
| eval/runner/situation-recall-associative.ts | situation-recall-associative | C | 357-358 (`new` per run); connect({}); initSchema | n/a | 364 `INSERT INTO sources`; 371 `UPDATE pages SET created_at, updated_at`; 413 `INSERT INTO slug_aliases` | ensureSource; slug aliases via setPageAliases (public) |
| eval/runner/skillopt-method/headroom.ts | skillopt-method (N15 dependency) | B | 360-361 `openBrain`; connect({}) | setConfig | none found | openEvalEngine |
| eval/runner/strict-pageless/agent.ts | strict-pageless | B | 135-138 dynamic from gbrainRoot; connect({}) | initSchema | none found | openEvalEngine |
| eval/runner/structure-aware-chunks.ts | structure-aware-chunks | C | 423-424; connect({}) | n/a | 439 `UPDATE content_chunks SET search_vector = ... to_tsvector` | PGLite FTS column; keep executeRaw or skip |
| eval/runner/systems/gbrain-agent.ts | gbrain-agent system | B | 157-158; connect({database_path}); dispatch via gbrain MCP tools | n/a | none found | openEvalEngine |
| eval/runner/systems/gbrain.ts | gbrain system | C | 66-67; connect(databasePath or {}) | n/a | 81-83 `pg_tables` plus `TRUNCATE ... CASCADE` in reset | reset via public methods or executeRaw |
| eval/runner/temporal-contradictions.ts | temporal-contradictions | C | 91-92; connect({}) | executeRaw users | 110 `SELECT dream, other`; 201 `close_date` props | executeRaw subset |

Bucket counts for 2b (58 files): A 5 (cat30, cat31, cat32, cat33, cat41), B 22, C 23, E 6 (pg-load, worker, live-recall/brain, n6-postgres-http, nightly/worker, refresh-barrier/child), mixed B+E 2 (scale-latency/build, refresh-barrier/trial). Totals with 2a: 87 non-test construction files.

Also in the same tree but not engine users of BrainEngine: `eval/runner/cat40/pg-arm.ts` (plain Postgres arm, no gbrain; E-like, not a candidate), `eval/runner/nightly/smokes/postgres-15.ts`, and `eval/runner/predictive/scale-latency/probe.ts` (Postgres via `--database-url-env`).

### 2c. Receivers: engine passed in, no construction

- `eval/runner/cat11-multimodal.ts:249, 284` (`runTextModality(engine: PGLiteEngine)`); H script, uses getChunks.
- `eval/runner/cat13-gap-localize.ts:848-951`, `cat13-kacf-calibrate.ts:290`: `measureProbe(engine: PGLiteEngine)`; not H.
- `eval/runner/cat19-doctor-remediate.ts:138` `captureHealth(engine)`; H, C bucket (above).
- `eval/runner/cat26-contextual-retrieval.ts:400, 418` `resolveEffectiveConfig`, `assertCorpusPremises`.
- `eval/runner/relational-ab.ts:89, 134, 372` `RelationalSearch(engine: PGLiteEngine)`; used by N9 (H).
- `eval/runner/skillopt-method/ceiling-stages.ts:374, 541, 696`, `one-shot.ts:86`, `rollouts.ts:219`, `headroom.ts:653, 772, 837`: typed `PGLiteEngine`.
- `eval/runner/memory-qa/run-systems.ts:563`, `precisionmembench-system.ts:421`: `importGbrain`-based PGLite class.
- `eval/runner/adapters/gbrain-inline.ts:157, 274` `engineOf`.
- `eval/runner/mcp-contract.ts:146, 293`, `eval/runner/longmemeval.ts:407, 491`.

Type-only imports `import type { PGLiteEngine } from 'gbrain/pglite-engine'` will need a `BrainEngine` type once the Rust engine is accepted; they compile against the pinned package and do not change at runtime.

### 2d. Test tree (not in the offline tier)

12 test files construct PGLite directly (`test/eval/*.test.ts` plus `test/support/pglite-snapshot.ts`). `test/eval/live-recall-postgres.test.ts:94` uses `createEngine({engine:'postgres'})` (E). `test/support/pglite-snapshot.ts:49-114` monkeypatches `PGLiteEngine.prototype` for every test that preloads it. These run under `bun test` against the pinned package, not through `all.ts`.

### 2e. Coupling summary for the engine switch

Note: every runner that uses `import ... from 'gbrain/...'` (static pinned package) ignores `--gbrain` and `GBRAIN_UNDER_TEST`, because it resolves through `node_modules/gbrain`, not the overlay. Static pinned importers today: adversarial (15), before-after (19), cat11 (54), cat19 (54), cat22 (38), cat23 (48), cat24 (63), cat27 (64), cat28 (52), identity (30), mcp-contract (40), perf (29), temporal (43), cat6 (dynamic 778), and the 'gbrain-cues' pins in longmemeval-m-pilot-*. These measure the pinned package even when a checkout is requested. Moving them to `importGbrain(gut, ...)` is required for a Rust checkout to be measured by them, and changes what they measure under `--gbrain` today.

---

## 3. Central helpers that already exist

- `evals:eval/runner/gbrain-under-test.ts`:
  - `gbrainSpecFrom(argv, env)` (line 65): `--gbrain` flag, then `GBRAIN_UNDER_TEST` env. The env path is what `all.ts` children inherit (`evals:eval/runner/all.ts:339-341` spawns with `process.env`).
  - `resolveGbrainUnderTest(spec)` (line 86): with no spec, the root is `node_modules/gbrain` (the pinned package, which has no `'rust'`).
  - `importGbrain(gut, subpath)` (line 117): `import(join(gut.root, subpath))`. Referenced by 57 files under `eval/` and `scripts/` (grep count).
- `evals:eval/runner/p5-brain.ts:65-71` `openP5Brain`: the one shared in-memory PGLite open for three H scripts (forward-reference-heal, line-grammar-typing, relation-line-variants). Its `edges()` (line 94) is one raw SQL join.
- `evals:eval/runner/memory-trust/sut.ts`: shared SUT for cat37, cat38, cat39. Holds all the raw SQL and the PGLite snapshot logic.
- `evals:eval/runner/evidence-delivery/gbrain.ts` `loadGbrain` (line 85): loads longmemeval modules, not the engine class (`GbrainModules` has no PGLite field). So it is not the place for the switch; evidence-delivery.ts:399-412 constructs directly.
- `evals:eval/runner/hermetic-env.ts`: strips provider keys and sets a fresh `GBRAIN_HOME` (line 76-94). It does not touch `GBRAIN_EVAL_ENGINE`-style vars, so a new env var survives the hermetic wrapper.

Proposed single place: add `openEvalEngine` next to `importGbrain` in `evals:eval/runner/gbrain-under-test.ts` (after line 119). It takes the `gut` that every runner already has or can receive, so the same mechanism that selects the gbrain checkout selects the engine.

```ts
// evals:eval/runner/gbrain-under-test.ts (proposed)
export type EvalEngineKind = 'pglite' | 'rust';
export function evalEngineKind(env: Record<string, string | undefined> = process.env): EvalEngineKind {
  const v = env.GBRAIN_EVAL_ENGINE ?? 'pglite';
  if (v === 'pglite' || v === 'rust') return v;
  throw new Error(`GBRAIN_EVAL_ENGINE must be pglite or rust (got ${JSON.stringify(v)})`);
}
export async function openEvalEngine(gut: GbrainUnderTest, opts: { databasePath?: string } = {}): Promise<any> {
  const kind = evalEngineKind();
  if (kind === 'pglite') {
    const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
    const e = new PGLiteEngine();
    await e.connect(opts.databasePath ? { database_path: opts.databasePath } : {});
    return e;
  }
  const { createEngine } = await importGbrain<any>(gut, 'src/core/engine-factory.ts');
  const cfg = { engine: 'rust', ...(opts.databasePath ? { database_path: opts.databasePath } : {}) };
  const e = await createEngine(cfg);
  await e.connect(cfg);
  return e;
}
```

Notes on the sketch: keep the pglite branch on `new PGLiteEngine()` so existing receipts do not change byte-for-byte. The rust branch needs a checkout with the `'rust'` case, passed as `GBRAIN_UNDER_TEST=<checkout>@<ref>` (env flows to `all.ts` children). `createEngine` adds a chat-usage sink (`gbrain:src/core/engine-factory.ts`), which is harmless for the offline tier.

---

## 4. Connect shapes and engine lifetime (what a Rust engine must support)

In-memory PGLite (`connect({})`):
- H-tier: adversarial, cat11, cat19, cat22, cat23, cat24, cat27, cat28, cat6, identity, mcp-contract, n1 (x2), n12, n13, n2, n3, n4-entity, n4-similar, n6, n7, n8, perf, temporal-edges, temporal-ingest-answer, temporal, generate-v0.41, a4, before-after, agent-retrieval-shapes, n15 via headroom `openBrain`.
- Via `openP5Brain` (p5-brain.ts:71): forward-reference-heal, line-grammar-typing, relation-line-variants.
- Via `sut.ts` (181, 219): cat37, cat38, cat39 (though the snapshot path changes this).
- Non-H: cat14, cat18, cat18b, cat20, cat21, cat25 (per probe), cat26, cat29, cat30-33 (default), cat35, adapters, precisionmembench seed, memory-qa openEngine (614), mcp-contract, skillopt headroom, strict-pageless, n2-judge, n2-3, p8, tool-contract, reach.

Data directory (`connect({database_path})`):
- cat36-production (243, 342): `databasePath` plus a copied PGLite snapshot dir.
- n14 (700): `opts.dataDir`.
- longmemeval-m-pilot-build (200): `<outputDir>/index`; replay (180): working database.
- evidence-delivery (412): per-question brain path (`makeBrainHome`).
- p5-agent (124, 139, 152), chronicle-lift (250), c8k-product (103), messy-company (62), systems/gbrain-agent (158), systems/gbrain (67), graph-backend/worker (43), pg-load (19), store-census (37).
- A `database_path` of `':memory:'` appears only in the in-memory `ctx.config` of openP5Brain (line 85), not as a connect argument.

Engines recycled (disconnect, then new engine):
- memory-qa/run.ts:637-638: `RECYCLE_EVERY` disconnects and reopens; otherwise `reset()` truncates tables with `pg_tables` and `TRUNCATE` (621-623). A Rust engine needs `reconnect()`/re-open after `disconnect()`, plus a non-SQL reset path.
- longmemeval.ts:1268 and 1295: new engine created inside the loop.
- situation-recall-associative.ts:357: new per run.
- cat25-trajectory-routing.ts:30: fresh in-memory engine per probe.
- evidence-delivery.ts: new per question, disconnect at 420.
- p5-agent.ts: opens three times (124, 139, 152).
- n2-contradiction-surfacing: disconnect called three times.

Lifetime requirements for Rust: `connect({})` must give a fresh in-memory store each call, `connect({database_path})` must reopen an existing dir, and `disconnect` must release any file lock. PGLite enforces one writer through `gbrain:src/core/pglite-lock.ts`, and `db-lock.ts` throws for unknown kinds (section 1b). A Rust engine needs the same single-writer rule or a clean equivalent, otherwise the lifecycle runners that pause a server on PGLite (`lifecycle/slice.ts:112`) behave differently.

---

## 5. Cross-cutting observations

1. Wide interface, narrow call sites. The runners call about 20 engine methods directly, but gbrain code they import reaches most of the 197. A Rust engine that implements only the common set will fail inside `operations.ts` and `import-file`, not at the runner.
2. `executeRaw` is a load-bearing contract. The Postgres-dialect SQL the evals use (`$n` params, `ON CONFLICT`, `::jsonb`, `to_regclass`, `pg_tables`, `information_schema`, `md5`, `string_agg`, `lower()` with `~`, `COUNT(*) FILTER`, `TRUNCATE ... CASCADE`, `SET default_transaction_read_only`, `SHOW server_encoding`) must either run in Rust or be replaced with public methods. gbrain core also needs it (19 `INSERT INTO sources` sites).
3. No public source-create on BrainEngine. Only `updateSourceConfig` exists. About ten runners insert sources with raw SQL (cat22, cat27, cat28, n4-entity, n4-similar, n6, n7, n8, situation-recall-associative, cat36-production). Phase 1 can add an `ensureSource` method to the Rust engine or keep the INSERT in `executeRaw`.
4. `engine.kind` must accept `'rust'`, and `db-lock.ts` must branch for it (lines 257, 324, 378, 604, 615, 626, 696, 705). Without that, skillopt (cat30-33) and any path that takes the DB lock throws.
5. PGLite-only internals used by evals: `engine.db.dumpDataDir` (memory-trust/sut.ts:183), `GBRAIN_PGLITE_SNAPSHOT` (sut.ts:177-217), the cat36 snapshot dir copy (cat36-production.ts:244), the longmemeval-m index dir (build.ts:200), and the prototype patch in `test/support/pglite-snapshot.ts`. A Rust engine needs its own snapshot format or those runners must run without the snapshot fast path.
6. Static pinned imports bypass the overlay (section 2e). Fixing that is a prerequisite for measuring a Rust checkout with 14 offline runners.
7. CLI-based runners (cat34, n5, lifecycle-experiment, system-one-jev, the p5 HTTP arm, forward-reference http arm) pick the engine from `GBRAIN_HOME/.gbrain/config.json`. One `constructEngine` case plus one `init --rust` path covers them, but the init pglite path (`init.ts:1092-1216`) does schema, reranker default, and embedding-identity work the Rust engine must support.
8. Postgres-only runners (E) stay Postgres-only: live-recall, graph-backend (a PG vs PGLite benchmark), n6-postgres-http, nightly/worker, refresh-barrier child and trial PG arms, scale-latency PG branch, cat40 pg-arm, and n14's PG branch. Only n14 is in the offline tier, and only its PGLite arm matters for Rust.
9. Offline tier counts: 44 scripts; 13 are B (swap constructor), 26 are C (SQL), 4 are D (CLI), 1 has no engine. Most C files need a few statements removed or an `ensureSource` hook, not a full SQL engine. The single highest-leverage C fix is `openP5Brain.edges()` (p5-brain.ts:94), which unblocks three H scripts.
10. Nothing was run. Classifications come from reading code at the pin and grep over the evals checkout. Files marked "not opened in full" in 2b (cat20, cat29, and the other B-marked non-H files) were checked by construction and connect lines plus a grep for raw SQL, not by reading every call.

### Smallest set of changes for `bun eval/runner/all.ts --tier offline` against a Rust engine

gbrain side, in a checkout passed as `GBRAIN_UNDER_TEST=<checkout>@<ref>`:
1. Implement the Rust engine behind a `BrainEngine` class with `kind: 'rust'`. At minimum the common set plus the methods the 44 H scripts reach through gbrain code (run the offline tier to find them).
2. Add `case 'rust'` to `src/core/engine-construct.ts:10-24`.
3. Widen the unions: `src/core/types.ts:2343`, `src/core/config.ts:37`, `src/core/engine.ts:832`, `src/core/engine-open.ts:94`.
4. Add `'rust'` branches in `src/core/db-lock.ts` (lines 257, 324, 378, 604, 615, 626, 696, 705), mapping to the Rust lock or to a Postgres-style advisory lock.
5. Provide `executeRaw` for the statements in section 2a, or add public `ensureSource` and count methods so the C-bucket runners stop needing SQL.

eval side:
6. Add `evalEngineKind()` and `openEvalEngine(gut, opts)` to `eval/runner/gbrain-under-test.ts` after line 119 (sketch in section 3).
7. Replace the constructor in the 13 B-bucket H scripts and the B-bucket non-H files with `openEvalEngine(gut, ...)`. Pass `gut` into the 14 static-pinned importers (section 2e).
8. Fix `eval/runner/p5-brain.ts:94` `edges()` to use `getLinks` over `listPages`. This unblocks forward-reference-heal, line-grammar-typing, and relation-line-variants.
9. Replace the `sut.sql` counts in `eval/runner/memory-trust/sut.ts` and the constructors in the 26 C-bucket H scripts, one by one, starting with the shortest SQL (agent-retrieval-shapes, cat19, cat22, cat24, cat27, cat28, n4-similar, n8). Skip `dumpDataDir` and the snapshot path on rust.
10. For the four D scripts (cat34, lifecycle-experiment, n5, system-one-jev), write a rust `config.json` under `GBRAIN_HOME` when `GBRAIN_EVAL_ENGINE=rust`, via one helper next to `evidence-delivery/e3.ts:159`, and add `'rust'` to `lifecycle/slice.ts:37`.
11. Run with `GBRAIN_EVAL_ENGINE=rust GBRAIN_UNDER_TEST=<checkout>@<ref> bun eval/runner/all.ts --tier offline`. `all.ts` passes `process.env` to every child (`all.ts:339-341`), so both variables reach each runner.
