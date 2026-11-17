# 01. Storage engine seam: BrainEngine, engine-sql, and raw-SQL bypass

Line numbers refer to gbrain 36bd05806a.

Reference repo: `garrytan/gbrain` (v0.60.733.0, commit 36bd05806a). All paths below are relative to that root unless marked otherwise.

Legend: **[V]** verified by reading the code. **[C]** counted with a ripgrep regex, so approximate (comments and docs can match). **[I]** inferred from the code, not executed.

No tests were run. Nothing in the reference repos was modified.

## 1. Bottom line

- The seam exists and is well structured: one interface, `BrainEngine` (src/core/engine.ts:830), with 197 callable members (194 required, 3 optional), two engine classes, and a SQL-sharing layer `src/core/engine-sql/` for 15 storage domains. [V]
- The seam is not closed. `BrainEngine` exposes `executeRaw(sql: string, params?)` (src/core/engine.ts:2714) and `executeRawDirect` (:2732). About 5,100 raw-SQL call-site lines sit outside the engine files, in about 1,140 files. [C]
- Therefore the interface is a viable seam for a Rust core only for the typed domain methods. Every raw `executeRaw` caller needs a separate plan: port it to a typed method, or give the Rust core a SQL executor. [I]

## 2. The BrainEngine interface (src/core/engine.ts:830-2890)

The interface has a `readonly kind: 'postgres' | 'pglite'` discriminator (:832) and three optional members: `holdSchemaMigrationLock?` (:848), `findDuplicatePage?` (:922) and `findDuplicatePages?` (:926). The callable members, grouped by the section comments in the file:

| Family (engine.ts lines) | Count | Representative members (signature, one-line purpose) |
|---|---|---|
| Lifecycle (834-859) | 9 | `connect(config)`, `disconnect()`, `reconnect(ctx?)` (recovers with the config captured at last connect, #2034), `initSchema()`, `transaction<T>(fn, opts?)` (:849), `transactionDirect<T>` (:851, control txn on the direct pool), `registerBeforeDisconnect(stop)` (:853, returns unregister), `withReservedConnection<T>(fn, opts?)` (:859) |
| Pages CRUD (861-1196) | 24 | `getPage(slug, opts?)` (:869), `readPageSnapshot(s)`, `lockPageKeys(keys)`, `putPage(slug, page, opts?)` (:891), `deletePage(s)`, `softDeletePage(s)`, `restorePage`, `purgeDeletedPages`, `listPages`, `findPages`, `countPagesBy`, `resolveSlugs`, `getAllSlugs`, `listAllSources`, `updateSourceConfig`, `listCorpusSample` |
| Search (1197-1239) | 6 | `searchKeyword(query, opts?)` (:1198), `countKeywordPages`, `searchKeywordPages`, `searchTitles`, `searchVector(embedding: Float32Array, opts?)` (:1224), `getEmbeddingsByChunkIds` |
| Chunks + embedding state (1240-1423) | 15 | `upsertChunks(slug, chunks, opts?)` (:1269), `getChunks`, `getChunkPage`, `getChunkWindows`, `countStaleChunks`, `sumStaleChunkChars`, `setPageEmbeddingSignature`, `invalidateStaleSignatureEmbeddings`, `invalidateContentDriftEmbeddings`, `listStaleChunks`, `readEmbeddingStateCounts`, `listEmbeddingStateRows`, `deleteChunks` |
| Extraction watermark (1424-1483) | 7 | `countStalePagesForExtraction`, `listStalePagesForExtraction`, `markPagesExtractedBatch`, `markPagesAttendanceBlocked`, `countStaleFrontmatterKeyPages`, `listStaleFrontmatterKeyPages`, `stripStaleFrontmatterKeys` |
| Links / graph (1484-1841) | 23 | `addLink`, `addLinksBatch(links)` (:1521), `replaceDerivedLinks(origin, links)`, `removeLink`, `getLinks`, `getBacklinks`, `traverseGraph` (:1643), `traversePaths` (:1658), `traversePathsDetailed`, `relationalFanout`, `relationalChainHop`, `getBacklinkCounts`, `getAdjacencyBoosts`, `getSalienceScores`, `findOrphanPages` |
| Tags (1842-1860) | 3 | `addTag`, `removeTag`, `getTags` |
| Timeline + chronicle + ontology (1861-1935) | 12 | `addTimelineEntry(s)`, `getTimeline`, `getTimelineForDate`, `getSince`, `getOnThisDay`, `getLastSeen`, `upsertEventProjection`, `mergeOntologyFact`, `getOntology`, `discoverOntologyDimensions`, `findOntologyConflicts` |
| Raw data + files (1936-1957) | 5 | `putRawData`, `getRawData`, `upsertFile(spec)`, `getFile(sourceId, storagePath)`, `listFilesForPage` |
| Takes (1958-2074) | 14 | `addTakesBatch`, `updateTakeEmbeddings`, `listTakes`, `searchTakes`, `searchTakesVector`, `updateTake`, `supersedeTake`, `resolveTake`, `getScorecard`, `getCalibrationCurve`, `addSynthesisEvidence` |
| Dream verdict cache (2075-2085) | 3 | `getDreamVerdict(filePath, contentHash)`, `putDreamVerdict`, `sweepDreamVerdicts` (TTL `DREAM_VERDICT_TTL_SECONDS = 30 * 86400`, :528) |
| Contradiction probe (2086-2195) | 6 | `listActiveTakesForPages`, `writeContradictionsRun`, `loadContradictionsTrend`, `get/putContradictionCacheEntry`, `sweepContradictionCache` |
| Facts (2196-2426) | 14 | `insertFact`, `insertFacts`, `deleteFactsForPage`, `expireFact`, `listFactsByEntity`, `listFactsSince`, `listFactsKeyset`, `listFactsBySession`, `listSupersessions`, `countUnconsolidatedFacts`, `findCandidateDuplicates`, `consolidateFact`, `findTrajectory`, `getFactsHealth` |
| Segmented body (2427-2457) | 14 | `allocateBodyOccurrenceIds`, `stageSegmentTexts`, `readSegmentTexts`, `stageManifestRows`, `readManifest`, `stageSegmentChunks`, `createSegmentedPageShell`, `flipBodyGeneration`, `openBodyStaging`, `setBodyStagingState`, `sweepSegments`, segment derivation watermarks |
| Versions (2458-2478) | 3 | `createVersion`, `getVersions<B>`, `revertToVersion` |
| Stats + health (2479-2490) | 2 | `getStats`, `getHealth` |
| Ingest log (2491-2498) | 2 | `logIngest`, `getIngestLog` |
| Sync, slugs, aliases (2499-2655) | 9 | `updateSlug`, `rewriteLinks`, `resolveSlugWithAlias(Detailed)`, `resolveAliases`, `setPageAliases`, `refreshPageBody`, `updatePageContextualRetrievalState`, `migrateFactsToCanonical` |
| Config (2656-2685) | 5 | `getConfig`, `setConfig`, `unsetConfig`, `listConfigKeys`, `getAllConfig` |
| Migration + raw SQL (2686-2746) | 3 (+2) | `runMigration(version, sql)` (:2687), `getChunksWithEmbeddings`, `keywordBoundedRead(read)` (:2745). Plus `executeRaw` (:2714) and `executeRawDirect` (:2732) |
| Code edges (2747-2805) | 6 | `addCodeEdges`, `deleteCodeEdgesForChunks`, `getCallersOf`, `getCalleesOf`, `getEdgesByChunk`, `searchKeywordChunks` (:2804) |
| Eval capture (2806-2821) | 5 | `logEvalCandidate`, `listEvalCandidates`, `deleteEvalCandidatesBefore`, `logEvalCaptureFailure`, `listEvalCaptureFailures` |
| Salience + enrich (2822-2889) | 5 | `batchLoadEmotionalInputs`, `setEmotionalWeightBatch`, `getRecentSalience`, `listEnrichCandidates`, `findAnomalies` |

Total: 197 callable members, counted by a line regex that accepts optional (`name?(`) and generic (`name<T>(`) members: 194 required and 3 optional. The Lifecycle and Pages CRUD rows include the optional ones. [V] (counted by line range)

Key shape facts [V]:
- Public page operations take slugs, not numeric page IDs (docs/ENGINES.md:24-50 states this as a design choice). Some storage methods take a numeric `pageId`: `readManifest`, `stageSegmentChunks`, `readSegmentDerivations` and `retireSegmentDerivations` (src/core/engine.ts:2437-2456).
- Two result envelopes: `SearchResult[]` for search (ranking happens above the engine in `src/core/search/hybrid.ts`), and `{ rows, affectedRows }` inside the SQL layer.
- Limits are clamped by `clampSearchLimit` with `MAX_SEARCH_LIMIT = 100` (:821-828).
- Engine-level constants that the Rust engine must match (src/core/engine-constants.ts): `DELETE_BATCH_SIZE = 500`, `TRAVERSE_PATH_ROW_CAP = 5000`, `TRAVERSE_WALK_ROW_CAP = 20000`, `LINK_READ_DEFAULT_LIMIT = 500`, `LINK_READ_MAX_LIMIT = 5000`, `LINK_READ_CONTEXT_MAX_CHARS = 2000`.

### Escape hatches (engine.ts:2694-2745, 249-263)

- `executeRaw<T>(sql, params?, opts?: { signal, timeoutMs, deadlineAt, jitOff, prepare })` (:2714). Takes arbitrary positional SQL text. The doc comment describes Postgres `statement_timeout`, PGLite cancellation, and JIT-off. [V]
- `executeRawDirect` (:2732). Same, but routed to the session-mode pool when dual-pool is active. Used by the Minion lock heartbeat. [V]
- `keywordBoundedRead(read)` (:2745). Runs `read` in one unscoped read transaction under `search.keyword_statement_timeout_ms`. [V]
- `ReservedConnection` (:249-263) exposes only `executeRaw`, and is documented as unsafe to take inside `transaction()`. [V]

## 3. Factory, open, connect

- `createEngine(config)` (src/core/engine-factory.ts) calls `constructEngine`, registers a chat-usage sink, and wraps `disconnect` to deregister it. [V]
- `constructEngine(config)` (src/core/engine-construct.ts) switches on `config.engine` (`'pglite'` or `'postgres'`, default `'postgres'`) and dynamically imports `PGLiteEngine` or `PostgresEngine`. Any other value throws; a `'sqlite'` value gets a specific error. [V]
- `openEngine(settings)` (src/core/engine-open.ts, experimental) is the settings-only path. It requires `embedded_core: true`. It validates every key (unknown keys are rejected). It requires `host.id` as a UUID. It rejects `pool.max` outside 1-100. It reads no env vars, config file, or home dir. Default embedded pool is `DEFAULT_EMBEDDED_POOL_MAX = 4`. After `disconnect()` the engine is closed for good, and `connect()` throws `engine_closed`. [V]
- `connectEngineForServe` (src/core/engine-connect.ts) is the CLI and serve path. Sequence: `loadConfig` → `configureGateway` → `createEngine` → `connectWithRetry` (db.ts) → `gateGraduationConnect` → `completeStartup` (migrations). One-shot read tuning: PGLite `shared_buffers = '32MB'` (`ONE_SHOT_READ_SHARED_BUFFERS`), Postgres `pool_max = 2` (`ONE_SHOT_READ_POOL_MAX`) unless `GBRAIN_POOL_SIZE` is set. [V]
- `engineKey(engine)` (src/core/engine-key.ts) walks page-transaction clones and views back to the root engine, so per-engine caches (AI gateway, settings) key on the real engine. [V]
- Engine scope (src/core/engine-scope.ts, engine-scope-store.ts) uses `AsyncLocalStorage`. A call with no scope in a process holding an open embedded engine is refused (`engine_scope_required`). [V]

## 4. The SQL layer: src/core/engine-sql/

Layout (33 `.ts` files, 8,718 lines total) [V]:

- Migrated domains (15 files, about 7,040 lines), matching the `migrated` rows of `scripts/engine-sql-baseline.tsv`: `chunks` (1210 lines), `pages` (1225), `facts` (903), `links` (813), `takes` (712), `page-body` (552), `timeline` (269), `health` (273), `code-edges` (195), `cjk-search` (190), `titles` (145), `salience` (384), `sources` (81), `files` (54), `tags` (34).
- Shared infrastructure, not domains: `bootstrap.ts` (756, forward-reference bootstrap run before the schema blob), `executor.ts` (113, `SqlExecutor` contract), `fragment.ts` (98, `sqlFragment` composition), `brands.ts` (52), `dialect-pglite.ts` (76), `dialect-postgres.ts` (94).
- Helper modules that carry SQL but are not listed as domains in the baseline: `graph-rank.ts` (185 lines, about 20 SQL-keyword hits), `exact-identity.ts` (101, about 7), `page-lookup.ts` (109, about 4). `keyword-pages.ts` (54) and `normalize.ts` (40) had no literal SQL keywords in my check [C].

Baseline (`scripts/engine-sql-baseline.tsv`, 79 lines) [V]:
- 15 `migrated` rows (the domains above).
- 54 `method` rows: 26 in `src/core/pglite-engine.ts`, 25 in `src/core/postgres-engine.ts`, plus 1 each in `pglite-engine/checkpoint-guard.ts`, `pglite-engine/code-edges.ts`, and `postgres-engine/init-schema-lock.ts`.
- The 24 names shared by both engines are: `deleteEvalCandidatesBefore`, `discoverOntologyDimensions`, `findOntologyConflicts`, `getAllConfig`, `getConfig`, `getDreamVerdict`, `getIngestLog`, `getOntology`, `getRawData`, `getStats`, `listConfigKeys`, `listEvalCandidates`, `listEvalCaptureFailures`, `logEvalCaptureFailure`, `logIngest`, `mergeOntologyFact`, `migrateFactsToCanonical`, `putDreamVerdict`, `putRawData`, `searchKeyword`, `searchKeywordChunks`, `setConfig`, `sweepDreamVerdicts`, `unsetConfig`. That is 48 rows; the other 6 are engine-only (`_connectInternal`, `probePgliteScratchStore`, `issueProbe`, `getEdgesByChunk` on PGLite; `resolveFactsEmbeddingCast`, `acquireInitSchemaAdvisoryLock` on Postgres).

Practical reading: the unmigrated families are config, dream verdicts, eval capture, ingest log, ontology, raw data, `getStats`, and the two keyword search methods. Keyword FTS on chunks (`searchKeywordChunks`) and pages (`searchKeyword`) is still implemented inside the engine classes, not in `engine-sql/`. [V]

The ratchet is `scripts/check-engine-sql-ratchet.ts` (TypeScript compiler API). It only looks at class members of the two engine files and `pglite-engine/**`, `postgres-engine/**`. [V] It does not see SQL in helper functions that take the engine as an argument. One confirmed case: `insertEvalCandidate(engine: Pick<BrainEngine,'executeRaw'>, ...)` in src/core/feedback/store.ts:340 runs `INSERT INTO retrieval_events` through `engine.executeRaw`. `PostgresEngine.logEvalCandidate` (src/core/postgres-engine.ts:3101) is a one-line delegation to it, so that row is not in the baseline. [V]

Guards that enforce the layer (scripts/): `check-engine-sql-ratchet.ts`, `check-engine-sql-brands.ts`, `check-engine-sql-dynamic.ts` (only constant text may be spliced), `check-layering.ts`, `check-engine-dynamic-import.ts`, `check-jsonb-pattern.sh`, `check-jsonb-params.mjs`. [V]

## 5. Dialects and capabilities

Two `SqlExecutor` adapters implement one contract (src/core/engine-sql/executor.ts). [V]

| Aspect | PGLite (dialect-pglite.ts, pglite-engine.ts) | Postgres (dialect-postgres.ts, postgres-engine.ts) |
|---|---|---|
| Handle | one in-process `PGlite` (`db.query`), no pool | postgres.js pool (`this.sql`), plus optional direct pool |
| Prepared statements | none | `prepare: true, simple: false` on the extended protocol (`query`) |
| JSONB bind | `JSON.stringify(p.value)` (`bind()`) | `conn.json(p.value)` |
| `maxBindParamsPerStatement` | 30,000 (`PGLITE_CAPABILITIES`) | `Infinity` (`POSTGRES_CAPABILITIES`) |
| `transactionAdvisoryLocks` | false | true |
| `probesEmbeddingCast` | false (always `::vector`) | true (`resolveFactsEmbeddingCast`, postgres-engine.ts:2271) |
| Cancellation | pre-check, then race (no kernel cancel) | `query.cancel()` / driver `signal` |
| `timeoutMs` in `executeRaw` | ignored | `SET LOCAL statement_timeout` in a BEGIN |
| RLS scope binding | none (brand is identity) | `withScopedReadTransaction` (postgres-engine.ts:368) |
| `withReservedConnection` | pass-through (pglite-engine.ts:1196) | `pool.reserve()` with a long-hold permit (postgres-engine.ts:763) |
| Pool diagnostics | none | `getPoolDiagnostics` (:831) |

Capabilities are three flags on the executor (`DialectCapabilities`), not on the engine. The engine-level `kind` is the only other discriminator. A regex count finds about 482 lines in 269 files that compare `engine`/`kind` to `'pglite'`/`'postgres'` [C]. Most look like config branches, not behavior branches. I did not classify them.

The public capability matrix in docs/ENGINES.md:1598-1611 is a feature table (Full/Full), not a capability API. [V]

## 6. Transactions

- `transaction<T>(fn, opts?)` (engine.ts:849) runs `fn` with a cloned engine whose connection is the transaction handle. Nested calls use savepoints. [V]
- `TransactionOptions` (engine.ts:142-160): `signal` (abort before BEGIN; on Postgres, abort during the transaction discards the connection and rolls back), `pipelineFirst` and `pipelineEarly` (transaction-pooler pipelining hints, both return a predicate over statement text), and `readOnly` (`BEGIN READ ONLY`). [V]
- Postgres: `transactionOn` (postgres-engine.ts:726-760) builds a `txEngine` with `Object.create(this)` and `Object.defineProperty(txEngine, 'sql', { get: () => tx })`. It also sets `_pageTransaction`, `_heldPageKeys`, and `_commitChecks`. A checkout gauge tracks `'tx'`. [V]
- PGLite: `transaction` (pglite-engine.ts:1209) uses `db.transaction`. Work is admitted through a checkpoint guard (`PgliteCheckpointGuard.runOutermost`). It cannot be interrupted after BEGIN. [V]
- `transactionDirect` uses the direct pool when dual-pool is active (postgres-engine.ts:720). [V]
- Usage: about 394 `.transaction(` call sites in 214 files outside the engines, and 10 `withReservedConnection(` sites in 8 files [C].
- The pattern is JS-specific: `transaction(fn)` takes a callback, and the callee receives an engine object. A Rust port needs an explicit transaction handle or a batch API. [I]

## 7. RLS read brands and scope binding

Brands (src/core/engine-sql/brands.ts) [V]:
- `ScopedRead` (`__obtainViaWithScopedReadTransaction`). Obtained only from `scopedRead(executor)` on the handle that `withScopedReadTransaction` yields. Means: the read ran in the RLS scope on master.
- `LegacyUnscopedRead` (`__obtainViaUnscopedExecutor`). Obtained only via `unscopedExecutor(executor, reason)`. Means: the read ran on the pool with no scope transaction. Converting one to `ScopedRead` changes behavior, so it is a TODO, not a drive-by.
- `check-engine-sql-brands.ts` rejects these keys anywhere else and rejects `as unknown as` next to executor types.

Scope binding (src/core/postgres-engine.ts:331-409) [V]:
- Opt-in by env var `GBRAIN_RLS_SCOPE_BINDING=1|true` (:363-364). Off by default.
- When on, a source-scoped read runs in `readTransaction` and issues `set_config('app.scopes', <csv or '*'>, true)`. Precedence matches `sourceScopeOpts`: federated array > scalar > `'*'`.
- The documented policy shape is `current_setting('app.scopes', true) = '*' OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ','))` (:338-342).
- The app layer (`sourceScopeOpts`) stays the mandatory first layer. RLS is defense in depth. The comment says only reads routed through `withScopedReadTransaction` are backstopped.
- Schema: 33 policy/RLS lines in `src/schema.sql`; 166 policy/RLS regex hits across `src` [C]. Whether production runs with the flag on is not verified.

## 8. Connection and pool lifecycle

Postgres [V]:
- `connect(config)` (postgres-engine.ts:433). With `config.poolSize`, it creates an instance pool: `max = min(config.poolSize, db.resolvePoolSize(...))`, `idle_timeout: 20`, `max_lifetime`, `connect_timeout`, `types: { bigint: BigInt }`, NOTICE silenced unless `GBRAIN_PG_NOTICES=1`, and `prepare` chosen by URL (PgBouncer transaction-mode detection). Session timeouts (`statement_timeout`, `idle_in_transaction_session_timeout`) come from db.ts.
- Pool size: `DEFAULT_POOL_SIZE_FALLBACK = 10` (src/core/db.ts:62), overridden by `GBRAIN_POOL_SIZE` (db.ts:246-253).
- `ConnectionManager` owns a read pool and an optional direct pool (dual-pool, for a session-mode URL alongside a transaction-mode pooler).
- `disconnect()` (:516) → `disconnectInternal` (:526): runs `registerBeforeDisconnect` stops first, then tears down the direct pool, then the read pool.
- `reconnect()` (:2859) reuses `_savedConfig`, guarded by `_reconnecting`.
- `holdSchemaMigrationLock` (:687) and `acquireInitSchemaAdvisoryLock` (postgres-engine/init-schema-lock.ts) serialize schema init. 44 `pg_advisory*` occurrences across `src/core` [C].

PGLite [V]:
- `connect` (pglite-engine.ts:799) → `_connectWithRootRegistration` (:808) → `_connectInternal` (:887).
- Data dir is `config.database_path`; undefined means in-memory.
- Exclusive file lock via `acquireLock(dataDir)` (src/core/pglite-lock.ts:319). Failure message: "Could not acquire PGLite lock. Another gbrain process is using the database." `releaseLock` at pglite-lock.ts:410.
- In-memory snapshot fast-restore only when `GBRAIN_PGLITE_SNAPSHOT` is set and the engine is not embedded (pglite-engine.ts:917).
- WAL repair on `wasm-abort`, and a "repair failed" marker that blocks the open. Both are described in comments in `_connectInternal`.
- Embedded WASM bundle with its own `vector` and `pg_trgm` extensions replaces the stock ones (pglite-engine.ts:33; src/core/pglite-embedded-assets.ts:267).
- `disconnect()` (:1050) → `_closeInternal` (:1088): checkpoint, then close, then release the lock. A failed close retains the lock until process exit.

## 9. How much SQL bypasses the engine

These are regex counts over `src/` [C]. "Outside" means not in `src/core/engine*.ts`, `src/core/pglite-engine*`, `src/core/postgres-engine*`, or `src/core/engine-sql/`.

| Pattern | Outside engines: call-site lines | Files |
|---|---|---|
| `.executeRaw(` / `.executeRawDirect(` (with optional generics) | about 4,890 | about 1,140 (1,144 total minus engine files) |
| tagged template `` sql`...` `` | 186 | 44 |
| `.query(` (mostly PGLite `db.query`) | 29 | 8 |
| `.unsafe(` | 20 | 13 |
| Combined | about 5,120 | |

Inside the engine files: 180 matching lines across 22 files (postgres-engine.ts alone has 52 tagged templates). Note that `engine-sql` itself has only 5 `executeRaw` lines [C].

About 1,014 `executeRaw` call sites in 440 files use a template literal with `${` interpolation (multi-line regex, approximate). I did not check whether any guard covers these. [C]

Subsystem breakdown of outside-engine raw SQL (combined count): `core/persistence` 1,414; `commands` 603; `core/repair` 307; `core/facts` 234; `core/cycle` 157; `core/minions` 152; `core/trust` 118; `core/shared-skills` 117; `core/page-state` 109; `core/belief` 102; `core/access` 100; `core/search` 91; `core/page-body` 84; `core/generations` 79; `core/ops` 74. [C]

Top 30 files by outside-engine raw SQL (combined count) [C]:

| Lines | File |
|---|---|
| 65 | src/core/persistence/journal.ts |
| 48 | src/core/minions/queue.ts |
| 43 | src/core/page-state/projections.ts |
| 37 | src/core/facts/purge.ts |
| 35 | src/core/persistence/graduation-copy.ts |
| 35 | src/core/mentions/pass.ts |
| 34 | src/core/embedding-migration.ts |
| 33 | src/core/persistence/source-lifecycle.ts |
| 33 | src/core/page-body/segment-derive.ts |
| 30 | src/core/persistence/worktree-refresh.ts |
| 30 | src/core/persistence/sync-holds.ts |
| 29 | src/core/persistence/page-purge.ts |
| 28 | src/core/persistence/sync-run.ts |
| 27 | src/core/shared-skills/restore.ts |
| 26 | src/core/persistence/connector-sync.ts |
| 26 | src/core/access/policy.ts |
| 25 | src/core/persistence/ownership.ts |
| 24 | src/core/repair/secret-spans.ts |
| 24 | src/core/belief/purge-mirror.ts |
| 23 | src/core/db-lock.ts |
| 23 | src/core/access/members.ts |
| 23 | src/commands/migrate-engine.ts |
| 22 | src/core/persistence/effect-journal.ts |
| 22 | src/core/oauth-provider.ts |
| 22 | src/core/facts/purge-verify.ts |
| 21 | src/core/persistence/atom-maintenance.ts |
| 20 | src/core/persistence/topology-locks.ts |
| 20 | src/core/persistence/deactivation.ts |
| 20 | src/core/facts/conversation-publication.ts |
| 20 | src/core/belief/purge.ts |

Spot-checked [V]: `journal.ts:131` runs `tx.executeRaw` with an aggregate query on `persistence_requests`. `minions/queue.ts:384` runs `pg_advisory_xact_lock(hashtext(...))` through `tx.executeRaw`. `feedback/store.ts:340` runs `INSERT INTO retrieval_events` through a `Pick<BrainEngine,'executeRaw'>`.

Two more facts that matter for the seam [C]: 132 `CREATE TABLE` statements in `src/schema.sql` (3,794 lines), and 317 files in `src/core/schema-migrations/`.

Postgres-only feature usage across `src` (regex hits in `.ts` files, comments included) [C]:

| Feature | Files | Hits | Notes |
|---|---|---|---|
| tsvector / ts_rank / websearch_to_tsquery | 44 | 148 | keyword FTS |
| pgvector operators (`<=>`, halfvec) | 48 | 204 | vector search |
| pg_trgm (`similarity`, `gin_trgm_ops`) | 29 | 74 | fuzzy slugs |
| `WITH RECURSIVE` | 14 | 15 | graph walks |
| advisory locks (`pg_advisory*`) | 32 | 57 | locks |
| `SKIP LOCKED` | 15 | 31 | queues |
| LISTEN / NOTIFY / pg_notify | 28 | 50 | notifications |
| `FOR UPDATE` | 127 | 226 | row locks |
| triggers / plpgsql | 49 | 337 | 70 hits in schema.sql |
| RLS / CREATE POLICY | 49 | 143 | 33 hits in schema.sql |
| JSONB (`::jsonb`) | 486 | 2,593 | |
| `ON CONFLICT` | 249 | 473 | upserts |
| `set_config(` | 57 | 148 | RLS and session settings |
| `pg_stat*` / `pg_locks` / `pg_terminate` | 37 | 110 | diagnostics |

## 10. Rust rewrite implications

**Must preserve exactly**
- The `BrainEngine` method semantics for slugs, soft-delete (`deleted_at`), source scoping (`sourceScopeOpts` precedence: federated array, then scalar, then `'*'`), and the limit clamp (`MAX_SEARCH_LIMIT = 100`).
- The row-cap constants in section 2 (`TRAVERSE_*`, `LINK_READ_*`, `DELETE_BATCH_SIZE`). Callers depend on their truncation semantics.
- Transaction semantics: nested means savepoint; abort rolls back; `readOnly` rejects writes.
- JSON encoding: a JSONB value is stored as a document, not a double-encoded string. CLAUDE.md documents the Postgres double-encoding trap.
- Error codes from `opError` (e.g. `engine_closed`, `engine_embedding_mismatch`, `engine_settings_invalid`), since callers branch on them.
- Dream-verdict TTL (30 days) and the contradiction cache semantics.

**Can be simplified**
- Pool, prepared-statement, PgBouncer, and session-timeout logic (`postgres-engine.ts` connect path and `db.ts` pool helpers). A single-process embedded store needs none of it. I did not measure how much of the 3,182-line file this is.
- RLS scope binding: replace with an app-layer filter that the Rust core always applies. Keep `ScopedRead` semantics as a type-level rule if wanted.
- The PGLite/Postgres parity branches (capabilities, `kind`). One engine means no parity matrix.
- Advisory locks and `SKIP LOCKED` become in-process mutexes and lease-based queues, with a file lock for the datastore.
- LISTEN/NOTIFY becomes in-process channels.
- Triggers, if any are behavior and not just maintenance, become explicit code in the write path. The 337 trigger/plpgsql hits need a per-trigger review.

**Postgres feature each piece depends on (replacement candidates)**
- Keyword search depends on tsvector/ts_rank and `websearch_to_tsquery`. A Rust replacement needs BM25-style ranking with the same query grammar. Ranking will differ.
- Vector search depends on pgvector HNSW and the `halfvec` cast. The Rust core needs an ANN index plus an exact fallback. Recall parity needs measuring.
- Fuzzy slug matching depends on pg_trgm. A trigram index covers it.
- Graph traversal depends on `WITH RECURSIVE`. A BFS in Rust is simpler; the row caps must be kept.
- JSONB depends on GIN indexes and the `->`/`@>` operators. A typed struct or serde_json with secondary indexes covers it.
- RLS depends on `current_setting`. Replace with a scope filter in the Rust query layer.
- Advisory locks depend on `pg_advisory_xact_lock`. Replace with a process-level lock table keyed by hashed IDs.

**Risks**
1. The raw-SQL escape hatch is the real seam. About 5,100 call-site lines in about 1,140 files bypass the interface. A Rust core that implements only the 194 typed methods will fail on the persistence, minions, repair, facts-purge, access, and cycle subsystems. This is the largest risk. [I]
2. The ratchet cannot see SQL in helpers that take `Pick<BrainEngine,'executeRaw'>`. Any port that relies on the baseline to find SQL will under-count. [V]
3. The 54 baseline method rows include the hot keyword-search paths (`searchKeyword`, `searchKeywordChunks`) and config. Those are not yet in `engine-sql/`, so they must be ported before any Rust engine can mirror them. [V]
4. The schema is 3,794 lines, 132 tables, and 317 migration files, with RLS and triggers. A Rust port must decide whether to replay this schema or define a new one with a migration mapping. [V] [I]
5. `openEngine` and `transaction(fn)` are JS-specific shapes. A napi binding would need to expose transactions as handles and map `AbortSignal` to cancellation tokens. [I]
6. Parity tests are written against Postgres text goldens (`test/fixtures/goldens/sql-text/`, per src/core/engine-sql/fragment.ts header). If the Rust core does not run SQL, these goldens need a different oracle. [V] (the goldens are cited in code, not inspected)

**Viability of the seam**
- For the 15 migrated domains and lifecycle: the interface is viable for a Rust core via napi or an MCP/CLI process boundary. It is typed enough to bind.
- For the other roughly 5,100 raw-SQL call sites: not viable without either (a) porting those domains into typed `BrainEngine` methods first (a multi-thousand-line job), or (b) embedding a SQL executor in Rust that accepts the same SQL text. Option (b) keeps Postgres-dialect SQL alive and is less clean.
- Recommendation [I]: first, enumerate the 1,140 files by subsystem and decide per subsystem whether it is a typed domain (port) or an admin/maintenance path (can keep a narrow SQL shim). Treat `executeRaw` as a compatibility shim, not as the seam.

## Open questions

1. Which of the roughly 1,140 raw-SQL files are on the hot path (ingest, search, put_page, minions claim) and which are admin or maintenance (purge, repair, migrate-engine)? The port order depends on this.
2. Where does the SQL for `Contradictions` (6 methods), `Versions` (3), and `keywordBoundedRead` callers live? Neither is a baseline row, and no `engine-sql` module is named for them. I did not trace the delegation.
3. Does the ratchet need a helper-level scan (SQL inside functions that take `Pick<BrainEngine,'executeRaw'>`), or is the feedback store case the only one? I found one confirmed case.
4. Is `GBRAIN_RLS_SCOPE_BINDING` enabled in any production deployment? The code paths are there; usage is not verified.
5. How many of the 482 engine-kind branch sites are behavior branches versus config parsing? A regex cannot tell them apart.
6. The doc at docs/ENGINES.md:1613 says "the interface assumes no SQL", but `BrainEngine` has `executeRaw(sql: string)`. Which statement the Rust design should follow is a product decision.
7. Does the Rust core need to keep Postgres as a supported engine? If yes, the SQL seam must stay; if no, the escape hatch can be retired after porting.
