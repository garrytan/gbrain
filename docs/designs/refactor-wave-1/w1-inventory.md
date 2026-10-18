# Refactor wave 1: W1-core per-method inventory

Every PostgresEngine / PGLiteEngine method of the five W1-core domains, classified before its conversion
(plan W1, "Engineering contracts: Dialect capabilities"). Classes:

- **identical**: same SQL text on both engines on master.
- **identical-after-normalization**: same statement modulo placeholder numbering, whitespace, bind-vs-inline of
  equivalent values, redundant casts, or clause order with identical semantics.
- **identical SQL, different driver post-processing**: the statements agree but the engines decoded rows
  differently (int8 as string vs number, timestamps as `Date` vs string, vector text parsing). The unified code keeps
  Postgres's mapping and declares the difference once (`engine-sql/normalize.ts` kinds or an explicit conversion).
- **dialect-specific**: the engines' SQL differs in behavior on master; the method keeps per-engine code and is
  listed in `scripts/engine-sql-baseline.tsv`.

The unified statement text is always PostgresEngine's master text (pinned byte for byte by
`test/fixtures/goldens/sql-text/<domain>.json`); PGLite now runs that text. Engine differences that remain are
expressed as executor capabilities (`src/core/engine-sql/executor.ts` `DialectCapabilities`), not
`if (engine === ...)` branches.

RLS scoping is unchanged per method (`test/fixtures/goldens/rls-scope-inventory.json`): every salience, facts,
takes and code-edges read was unscoped on master and takes `LegacyUnscopedRead`; the CJK keyword read was scoped and
takes `ScopedRead`.

## Capabilities

| Capability | PGLite | Postgres | Consumer | Tests |
|---|---|---|---|---|
| `maxBindParamsPerStatement` | 30,000 (the WASM parameter bridge corrupts the session past 32,767 binds) | `Infinity` (master never batched) | `code-edges.addCodeEdges` | boundary 5,000 / 5,001 unresolved rows (1 vs 2 statements on PGLite, 1 on Postgres) and three overlapping concurrent writers, `test/engine-sql-capabilities.test.ts` + `test/e2e/engine-sql-capabilities-parity.test.ts` |
| `transactionAdvisoryLocks` | false (single connection; the plain insert never opened a transaction) | true (`pg_advisory_xact_lock(hashtextextended(source_id \|\| ':' \|\| entity_slug, 0))` inside the insert transaction) | `facts.insertFact` | eight concurrent same-entity inserts, an entity-less insert, three concurrent supersedes of one fact |
| `probesEmbeddingCast` | false (master always cast `::vector`; the bundled pgvector assignment-casts to the `halfvec` column) | true (`PostgresEngine#resolveFactsEmbeddingCast` probes `format_type` once per process) | `facts.insertFact`, `facts.insertFacts` | three concurrent vector writes at the live column dimension round-trip exactly |

## salience (`engine-sql/salience.ts`, C10)

| Method | Class | Notes |
|---|---|---|
| `batchLoadEmotionalInputs` | identical-after-normalization | PGLite appended ` WHERE p.slug = ANY($1::text[])` to a shared base string. |
| `setEmotionalWeightBatch` | identical-after-normalization | Placeholder numbering only; returns `RETURNING 1` row count on both. |
| `getRecentSalience` | identical-after-normalization | PGLite built clauses into a params array (`$N` reuse); same predicates, order, recency builder. |
| `listEnrichCandidates` | identical-after-normalization | PGLite joined a WHERE array; same predicates and whitelisted ORDER BY. |
| `findAnomalies` | identical-after-normalization | PGLite reused `$1/$2/$3` across CTEs; Postgres binds each occurrence. |

## facts (`engine-sql/facts.ts`, C11)

| Method | Class | Notes |
|---|---|---|
| `insertFact` | dialect-specific via capabilities | Advisory lock + insert transaction on Postgres only (`transactionAdvisoryLocks`); cast suffix probed on Postgres only (`probesEmbeddingCast`). The vector literal stays inlined text on both (master's planner behavior). `md5(fact)` vs `CASE WHEN model THEN md5($3)` compute the same hash. |
| `expireFact` | identical-after-normalization | `affectedRows` replaces `.count` / `.affectedRows`. |
| `insertFacts` | identical-after-normalization | Same transaction, delete-first, per-row insert and supersede second pass; PGLite bound `$14::vector`, Postgres inlines the literal. |
| `deleteFactsForPage` | identical-after-normalization | PGLite cast `LIKE ANY($3::text[])`; Postgres binds the array uncast (PGLite infers `text[]` from context, verified). |
| `listFactsByEntity`, `listFactsSince`, `listFactsBySession` | identical SQL, different driver post-processing | PGLite's `_listFacts` built `NOT (source = ANY(...))` and inlined LIMIT/OFFSET; same predicates. PGLite returned some timestamps as strings: `rowToFact` declares six `date` columns. |
| `listSupersessions` | identical SQL, different driver post-processing | As above. |
| `countUnconsolidatedFacts` | identical-after-normalization | `source != ALL` vs `NOT (source = ANY)`: identical for the NOT NULL `source`. |
| `findCandidateDuplicates` | identical-after-normalization | PGLite bound the query vector; Postgres inlines it. |
| `consolidateFact` | identical-after-normalization | |
| `findTrajectory` | identical SQL, different driver post-processing | PGLite selected `embedding` and parsed inline; Postgres selects `embedding::text` and uses `tryParseEmbedding` (same result for valid vectors). `valid_from` string on PGLite is converted to `Date`. |
| `getFactsHealth` | identical SQL, different driver post-processing | Postgres returns `COUNT(*)` as int8 text; PGLite cast `::int`. Both map through `Number()`. |
| Stays in the engines (listed in the baseline): `resolveFactsEmbeddingCast` (Postgres probe), `migrateFactsToCanonical`, `mergeOntologyFact`, `getOntology`, `discoverOntologyDimensions`, `findOntologyConflicts` (never in the per-engine facts modules). | | |

## takes (`engine-sql/takes.ts`, C12)

| Method | Class | Notes |
|---|---|---|
| `addTakesBatch`, `updateTakeEmbeddings` | identical | Already shared text through `executeRawJsonb`; keep master's executeRaw path (raw gauge) and re-resolve the executor per `batchRetry` attempt. |
| `listActiveTakesForPages`, `listTakes`, `searchTakes`, `searchTakesVector`, `countStaleTakes`, `listStaleTakes` | identical-after-normalization | Clause builders vs tagged fragments; row mappers already shared (`takeRowToTake`, `takeHitRowToHit`, `staleTakeRowToRow`). |
| `writeContradictionsRun`, `putContradictionCacheEntry` | identical-after-normalization | `sql.json` becomes `jsonbParam` (still `sql.json` on Postgres; PGLite binds the serialized value to the jsonb column, as its raw object bind did). |
| `loadContradictionsTrend`, `getContradictionCacheEntry`, `sweepContradictionCache` | identical-after-normalization | |
| `getTakeEmbeddings` | identical SQL, different driver post-processing | PGLite parsed the vector text inline; unified on `tryParseEmbedding`. |
| `updateTake`, `supersedeTake`, `resolveTake` | identical-after-normalization | `supersedeTake` runs through `exec.transaction`. |
| `getScorecard`, `getCalibrationCurve`, `addSynthesisEvidence` | identical-after-normalization | |

## code-edges (`engine-sql/code-edges.ts`, C13)

| Method | Class | Notes |
|---|---|---|
| `addCodeEdges` | dialect-specific via capabilities | PGLite batched below 30,000 binds (`maxBindParamsPerStatement`); casts `::int` / `::text::jsonb` now on both. Keeps master's direct `unsafe` path. |
| `deleteCodeEdgesForChunks` | identical-after-normalization | |
| `getCallersOf`, `getCalleesOf` | identical-after-normalization | PGLite inlined an escaped `source_id` literal; Postgres binds it. `NULL` vs `NULL::int` in the UNION. |
| `getEdgesByChunk` | **dialect-specific (kept per engine)** | PGLite's master SQL is one UNION ALL under a single shared LIMIT, and for direction `both` its edge-type filter binds only to the `to_chunk_id` arm (operator precedence); Postgres runs two statements, each with its own LIMIT, filter parenthesized. Unifying would change PGLite results, so PGLite keeps `src/core/pglite-engine/code-edges.ts` (baseline row) and Postgres uses the engine-sql version. Aligning PGLite is a behavior change: TODO. |

## cjk-search (`engine-sql/cjk-search.ts`, C14)

| Method | Class | Notes |
|---|---|---|
| `searchKeyword` / `searchKeywordChunks` CJK branch (`_searchKeywordCJK`) | identical | SQL already built once in `search/cjk-keyword-sql.ts`. Postgres's statement timeout (`SET LOCAL statement_timeout = '8s'`) and RLS scope transaction stay in the engine hook (dialect-specific; `PostgresEngine._searchKeywordCJK` keeps its baseline row). |

## Forward-reference bootstrap (E1)

Sources compared: `PGLiteEngine#applyForwardReferenceBootstrap` (`src/core/pglite-engine.ts`, 604 lines) and
`applyPostgresForwardReferenceBootstrap(conn)` (`src/core/postgres-engine/forward-reference-bootstrap.ts`, 655 lines),
both at the E1 base. Destination: `src/core/engine-sql/bootstrap.ts`. Classes: **identical**; **identical after
normalization** (whitespace, comment wording, variable typing); **identical SQL, different driver post-processing**;
**dialect-specific** (kept as an explicit hook).

### Probe statement (one round-trip)

| Item | Class | Notes |
|---|---|---|
| 55 `EXISTS` probes on `information_schema.tables` / `.columns` (`pages`, `links`, `content_chunks`, `mcp_request_log`, `subagent_messages`, `ingest_log`, `files`, `oauth_clients`, `sources`, `timeline_entries`, `minion_jobs`, `facts` targets) | identical after normalization | Same aliases and table/column pairs on both engines. Column order in the SELECT list differed (`effective_date_exists` position); results are read by alias, so order has no effect. Now rendered once from `FORWARD_REFERENCE_PROBES`. |
| `oauth_client_grants_exist` (`COUNT(*) = 6` over the six grant columns) | identical after normalization | Rendered once. |
| `table_schema` predicate | dialect-specific | Postgres `current_schema()`, PGLite `'public'`. Hook `probeSchema`; kept per engine because the two differ when `search_path` is not `public`. |
| `dream_verdicts_exists`, `dream_verdicts_expires_at_exists` | dialect-specific | Postgres only (its blob carries `dream_verdicts` + `dream_verdicts_expires_idx`; PGLite creates the table by migration v30). Hook `dreamVerdictsForwardReference` gates the probes, the gap and the ALTER. |
| Driver call | identical SQL, different driver post-processing | Postgres ran a zero-parameter tagged template (named prepared statement on direct Postgres, unprepared through PgBouncer, extended protocol); now `conn.unsafe(sql, [], { prepare: true, simple: false })`, which postgres.js treats identically (per-call `prepare` ANDed with the connection option; `simple: false`). PGLite keeps `db.query(sql)`. Both return one row of booleans. |

### Gap predicates

All 26 shared `needs*` predicates are identical after normalization: Postgres read some probes through widened
`probe as {...}` casts and compared `=== true`; PGLite read them directly. Both drivers return JS booleans for
`EXISTS`/`=` columns, so truthiness and `=== true` agree. `needsDreamVerdictsExpiresAt` is dialect-specific (above).
The early-return conjunction lists the same flags on both engines (plus the dream_verdicts flag on Postgres).

### DDL blocks (in execution order)

| Block | Class | Notes |
|---|---|---|
| stderr `Schema forward-reference gap detected, applying bootstrap` | identical | |
| facts `embedding_model`, `embedded_text_hash` | identical after normalization | |
| `sources` CREATE TABLE + default seed + `pages.source_id` | identical after normalization | |
| links `link_source`, `origin_page_id` | identical after normalization | |
| content_chunks v26/v27 columns | identical after normalization | |
| pages `deleted_at` | identical after normalization | |
| content_chunks v39 `modality`, `embedding_image` | dialect-specific (position only) | Same statements. PGLite ran it right after `deleted_at`; Postgres after `subagent_messages.provider_id`. Hook `chunksEmbeddingImageStep` keeps each engine's order; the SQL text is one constant. |
| mcp_request_log `agent_name`, `params`, `error_message` | identical after normalization | |
| subagent_messages `provider_id` | identical after normalization | |
| pages v40/v41 recency columns | identical after normalization | |
| ingest_log `source_id` | identical after normalization | |
| files `source_id`, `page_id` | identical after normalization | |
| oauth_clients `source_id`, `federated_read` | identical after normalization | |
| `GRANT_COLUMNS_SQL` | identical | Same imported constant. |
| oauth_clients `surface`, `surface_set_by` | identical after normalization | |
| sources archive columns | identical after normalization | |
| pages `last_retrieved_at`; provenance; contextual-retrieval (+ sources); `generation`; `embedding_signature`; `links_extracted_at` | identical after normalization | |
| timeline_entries `event_page_id` | identical after normalization | |
| minion_jobs `timeout_at`; `idempotency_key` | identical after normalization | |
| dream_verdicts `expires_at` + `SET DEFAULT` (two statements) | dialect-specific | Postgres only, between `idempotency_key` and the private-queue block, as on master; wrapped in `dialect-only:postgres` markers so the PGLite half of `test/schema-bootstrap-coverage.test.ts` does not count it. |
| minion_jobs private-queue columns; `submission_authority`, `claim_generation` | identical after normalization | |

DDL driver calls are unchanged: PGLite `db.exec(sql)`, Postgres `conn.unsafe(sql)` (simple protocol, multi-statement).

### Equivalence evidence

A trace harness ran master's and E1's bootstrap on the same states (empty database, current schema, every probed
column dropped at once, then each probed column dropped singly: 48 scenarios per engine) and recorded probe rows, every
DDL batch (whitespace-normalized) and the stderr line. PGLite traces are byte-identical. Postgres traces are identical
except the recorded probe call form (tagged template vs `unsafe` with tagged-template options); on a single direct
connection both leave the probe as a named prepared statement.

# W1-extended (lane a): pages, tags, links, timeline

Same classes and rules as above; compared at `origin/refactor/wave-1` 98c155835 (master text unchanged by W1-core for
these domains). The unified statement text is PostgresEngine's text, pinned by
`test/fixtures/goldens/sql-text/{pages,tags,links,timeline}.json`. Members listed as "already one copy" carry no SQL
in the engines (their SQL lives in a shared module the engines call with themselves) and have no baseline row; they
stay in the engines unchanged. No method in these four domains keeps dialect-specific SQL in the engines.

RLS scoping is unchanged per method (`rls-scope-inventory.json`): the eleven members that called
`withScopedReadTransaction` on master (`readPageSnapshot`, `findDuplicatePage`, `listPages`, `getAllSlugs`,
`listPrefixSampledPages`, `listCorpusSample`, `countStalePagesForExtraction`, `listStalePagesForExtraction`,
`getLinks`, `getBacklinks`, `listLinkSources`) still call it directly in PostgresEngine and hand the engine-sql
function a `ScopedRead` over the scoped handle (PGLite: `scopedRead(this.engineSql)`); every other read takes
`LegacyUnscopedRead`. `listCorpusSample` keeps `alwaysTransaction` when seeded (setseed pins the connection).

## pages (`engine-sql/pages.ts`)

| Method | Class | Notes |
|---|---|---|
| `getPage`, `readPageSnapshot` | already one copy | SQL in `page-state/snapshot.ts`; transport differs (Postgres: scoped `tx.unsafe`, PGLite: `executeRaw`). Hot path left untouched. |
| `lockPageKeys`, `createVersion`, `putPage` (outer transaction, page-key lock, `assertPageRevision`) | already one copy / dialect-specific orchestration without SQL | Page-state guards (`page-state/guards.ts`, `versions.ts`, `types.ts`); PGLite tracks held keys in-process, Postgres locks `page_write_guards` rows. Stays in the engines. |
| `_putPage` (row upsert) | identical SQL, different driver post-processing | PGLite cast `$8::jsonb`, `$10::timestamptz`, `$18::timestamptz` and pre-serialized `effective_date` / `ingested_at` to ISO strings; the unified text has no casts (column context types the binds; frontmatter binds through `jsonbParam`). Nested `sql.unsafe(bodyWriteChunkVersion(...))` becomes trusted text. PGLite can return zero rows from `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` in trigger edge cases: its re-read fallback is kept as a PGLite-only hook (Postgres keeps `rowToPage(rows[0])`). Blank-body data-loss guard read is identical. |
| `deletePage`, `deletePages`, `resolveSlugsByPaths`, `softDeletePages`, `updatePageContextualRetrievalState`, `getPageTimestamps` | identical-after-normalization | Placeholder numbering / whitespace only. |
| `softDeletePage`, `restorePage` | identical-after-normalization | PGLite joined a WHERE array; same optional `source_id` predicate. |
| `purgeDeletedPages` | identical SQL, different driver post-processing | Same statements; both coerce `deleted_at` to `Date`. |
| `refreshPageBody` | identical-after-normalization | Both splice `bodyWriteChunkVersion('$1', '$2')`, which reuses the first two binds (compiled_truth, timeline); the unified fragment keeps them first so the reuse still points at them (same 5 params). |
| `findDuplicatePage` | identical-after-normalization | PGLite reused `$3`/`$4`; Postgres binds each occurrence with `::text` casts. |
| `listPages` | identical-after-normalization | PGLite built a WHERE array (no `1=1`), same predicates, `PAGE_SORT_SQL` allowlist, limit/offset bound. |
| `getAllSlugs`, `listAllPageRefs` | identical SQL, different driver post-processing | `listAllPageRefs` coerces `updated_at` to `Date` on both. |
| `listPrefixSampledPages`, `listCorpusSample` | identical SQL, different driver post-processing | PGLite reused `$n`; Postgres binds per occurrence. PGLite converted `last_retrieved_at` to `Date`; the unified mapper declares it a `date` column (Postgres already returns `Date`). Seeded `setseed` runs on the same executor before the sample. |
| `resolveSlugs` | identical-after-normalization | PGLite substituted `__N__` placeholders; same exact-then-fuzzy statements. |
| `countStalePagesForExtraction`, `listStalePagesForExtraction` (+ private `buildStalePagesWhere`) | identical-after-normalization | Both engines built the same predicate text and ran it raw (Postgres `tx.unsafe`, PGLite `db.query`); the predicate is now a `sqlFragment` rendered once and run through the executor's `unsafe` path (master's direct `unsafe`, unchanged driver options). |
| `markPagesExtractedBatch` | identical-after-normalization | PGLite appended `RETURNING 1` and counted rows; Postgres read `.count`. Unified on Postgres's text + `affectedRows` (EO18). |
| `getVersions` | identical-after-normalization | |
| `revertToVersion` | identical-after-normalization | Same spliced `bodyWriteChunkVersion('pv.compiled_truth', 'pages.timeline')`. |
| `updateSlug` | identical | Same `executeRaw` text on both, inside `engine.transaction()` with `recordRenameAlias` / `moveSlugBindings`; the statement moves, the transaction and alias bookkeeping stay in the engines. |
| `setPageAliases` | identical | Same `executeRaw` statements after the page-key lock; the lock and transaction stay in the engines. |
| `resolveSlugWithAlias` | already one copy | Delegates to `resolveSlugWithAliasDetailed`. |
| `resolveSlugWithAliasDetailed` | identical-after-normalization | PGLite expanded `source_id IN ($2, ...)`, ordered by `id` and stable-sorted by source position in JS; Postgres binds `= ANY($n::text[])` and orders by `array_position(...), id` (same order). Unified on Postgres's statement (EO8 list binding). The multi-match warning text is Postgres's (`returning first by sourceOrSources order.`); PGLite's said `returning first.` |

## tags (`engine-sql/tags.ts`)

| Method | Class | Notes |
|---|---|---|
| `getTags` | identical-after-normalization | Same scope precedence, privacy and live filters; PGLite numbered the scope bind `$2`. |
| `addTag`, `removeTag` | already one copy | `mutatePageTag` (page-state guarded) runs identical `executeRaw` SQL on both engines. |

## links (`engine-sql/links.ts`)

| Method | Class | Notes |
|---|---|---|
| `addLink` | identical-after-normalization | Postgres locks endpoint rows `FOR KEY SHARE` inside the upsert snapshot (#4109); PGLite omitted it. PGLite is a single-connection database, so the lock has no concurrent writer to order; the unified text keeps the clause. |
| `addLinksBatch` (+ private `_addLinksBatchOnce`) | identical | Same `executeRawJsonb` text (PGLite also early-returned on empty input, which the public wrapper already does); keeps master's `executeRaw` path and re-resolves the executor on each `batchRetry` attempt. |
| `removeLinksByPagesAndSource` | identical | Same `executeRawJsonb` statement. |
| `removeLink` | identical-after-normalization | Four branches, same statements. |
| `getLinks`, `getBacklinks` | identical-after-normalization | Three branches (federated, scalar, unscoped), same privacy text. |
| `listLinkSources` | identical-after-normalization | Postgres always inner-joins `pages f`; PGLite joined only when scoped. `links.from_page_id` is `NOT NULL REFERENCES pages(id) ON DELETE CASCADE`, so the unscoped join drops no row. |
| `findOrphanPages` | identical-after-normalization | |
| `traverseGraph` | identical-after-normalization | PGLite inlined `TRAVERSE_WALK_ROW_CAP`; Postgres binds it. |
| `traversePathsDetailed` | identical SQL, different driver post-processing | PGLite emitted `AND l.link_type = $3` only when a type was given; Postgres binds `(${!linkTypeMatches} OR l.link_type = ...)` (same predicate). PGLite read `depth` as-is, Postgres `Number(depth)` (int4 on both). |
| `traversePaths` | already one copy | Delegates to `traversePathsDetailed`. |
| `replaceDerivedLinks` | already one copy | `derived-links.ts`. |

## timeline (`engine-sql/timeline.ts`)

| Method | Class | Notes |
|---|---|---|
| `addTimelineEntry` | identical-after-normalization | `FOR KEY SHARE` as in `addLink` (Postgres only on master; no effect on single-connection PGLite). |
| `addTimelineEntriesBatch` (+ private `_addTimelineEntriesBatchOnce`) | identical | As `addLinksBatch`. |
| `getTimeline` | identical-after-normalization | PGLite put the privacy predicates before the date/scope predicates; AND order has no semantic effect. |
| `getTimelineForDate`, `getSince`, `getOnThisDay`, `getLastSeen` (+ PostgresEngine `chronicleSourceCond`, PGLiteEngine `pushChronicleSource` / `chronicleSelect`) | identical-after-normalization | Same chronicle shape, scope precedence and event-page scope; PGLite reused `$1`. |
| `upsertEventProjection` | identical-after-normalization | PGLite reused `$6` for both source predicates. |

# W1-extended (lane b): sources, files, chunks

Same classes and rules as W1-core above. Sources compared: `PostgresEngine` / `PGLiteEngine` at
`origin/refactor/wave-1` 98c155835 (master's SQL for these methods; W1-core did not touch them). Destinations:
`src/core/engine-sql/{sources,files,chunks}.ts`. Statement text is PostgresEngine's text, pinned by
`test/fixtures/goldens/sql-text/{sources,files,chunks}.json`; PGLite runs it. RLS scoping per method matches
`rls-scope-inventory.json`: reads that ran inside `withScopedReadTransaction` on master take `ScopedRead` and the
engine keeps the literal `withScopedReadTransaction(...)` call in the public method (the AST inventory counts direct
sites per method); every other read takes `LegacyUnscopedRead`. Source scope (`sourceId` / `sourceIds` precedence and
the `'default'` fallback) and the registry-active embedding column are resolved in the engine and passed in; engine-sql
never resolves them.

Driver paths are preserved per statement: Postgres tagged templates become `query` / `run` (`runUnsafe` with
`{prepare: true, simple: false}`), master's direct `conn.unsafe(...)` stays `unsafe`, and master's `executeRaw`
(raw gauge) stays `executeRaw`. Hand-numbered `$N` text built by string concatenation is recomposed with
`sqlFragment`; where master numbered placeholders out of textual order (`_upsertChunksOnce`'s embedding
placeholders, the invalidations' lock-array index), the fragment numbers them by occurrence. Every such placeholder
occurs exactly once in master's text, so the bound parameter count is unchanged and the golden's
occurrence-renumbered text hash is identical.

## sources (`engine-sql/sources.ts`)

| Method | Class | Notes |
|---|---|---|
| `listAllSources` | identical-after-normalization | PGLite cast `$1::boolean` / `$2::boolean`; Postgres binds uncast (the `OR` context types them boolean on both). Row mapping was already the same code (`last_sync_at` to `Date`, string `config` parsed). Unscoped on master: `LegacyUnscopedRead`. |
| `updateSourceConfig` | identical-after-normalization | Same `SOURCE_CONFIG_OBJECT_SQL` merge. PGLite bound `JSON.stringify(patch)` to `$1::jsonb` and returned `RETURNING id` row count; Postgres binds `sql.json(patch)` uncast and reads `.count`. Unified: `jsonbParam(patch)` (postgres.js `sql.json` on Postgres, serialized value on PGLite, never pre-stringified on Postgres) and `affectedRows > 0`. |

## files (`engine-sql/files.ts`)

| Method | Class | Notes |
|---|---|---|
| `upsertFile` | identical-after-normalization | PGLite bound `JSON.stringify(metadata)` to `$9::jsonb`; Postgres binds `sql.json(metadata)` uncast. Unified on `jsonbParam`. Same `ON CONFLICT (storage_path)` update and `(xmax = 0) AS created`. |
| `getFile`, `listFilesForPage` | identical-after-normalization | Placeholder numbering only. Rows returned as the driver decodes them on both engines (no mapping on master). Unscoped: `LegacyUnscopedRead`. |

## chunks (`engine-sql/chunks.ts`)

| Method | Class | Notes |
|---|---|---|
| `upsertChunks` / `_upsertChunksOnce` | identical-after-normalization | PGLite cast `chunk_index != ALL($2::int[])`; Postgres binds the array uncast (the `ALL` context types it `int[]`). The multi-row `INSERT ... ON CONFLICT` text is the same on both; built once with `sqlFragment` (occurrence numbering, see above). Kept in the engine: the `batchRetry` + `transaction()` wrapper (retry ownership) and the page-state guard calls `lockPageKeys` / `readPageSnapshot` + `assertPageRevision`, which the store receives as engine callbacks and runs in master's order. The lazy gateway import keeps its `engine-dynamic-import-ok` marker. No bind batching: master PGLite never batched this statement (19 binds per chunk). Statements: page lookup, delete and the two config reads were tagged on Postgres (`query`); the `chunkWriteInvalidation` update and the `INSERT` were `unsafe` (stay `unsafe`). |
| `getChunks` | identical-after-normalization | Scoped on master: `ScopedRead` (Postgres: `withScopedReadTransaction(sourceIds, sourceIds ? undefined : sourceId)`; PGLite brands its own executor). Shared `rowToChunk`. |
| `countStaleChunks` | identical-after-normalization | Shared `buildStaleChunkWhere` (both engines) becomes a fragment builder. Scoped: `ScopedRead`. Postgres ran `tx.unsafe`: stays `unsafe`. |
| `sumStaleChunkChars` | identical-after-normalization | Same predicate builder; `::bigint` sum mapped through `Number()` on both. Unscoped: `LegacyUnscopedRead`; stays `unsafe`. |
| `setPageEmbeddingSignature` | identical-after-normalization | Placeholder numbering only. |
| `invalidateStaleSignatureEmbeddings`, `invalidateContentDriftEmbeddings` | identical | Same code on both engines (`executeRaw` inside `engine.transaction()` after `lockEmbeddingSources`). The transaction stays the engine's (`tx` gauge, transaction-clone flags) and the store runs the source lock and the UPDATE through the clone's own `executeRaw`, as master did (the clone's `executeRaw` is a seam `test/embedding-recovery.serial.test.ts` intercepts). `currentSpaceChunkPredicate(colId, 2, 3)` (hand-numbered, `embedding-invalidation.ts`) is expressed as a fragment with identical text, pinned against the shared builder by `test/engine-sql-chunks.test.ts`. |
| `listStaleChunks` | identical-after-normalization | PGLite reused `$1` for the three `afterUpdatedAt` comparisons; Postgres binds each occurrence. Scoped: `ScopedRead`. |
| `countChunklessPagesWithContent`, `listChunklessPagesWithContent` | identical | Shared `buildChunklessPagesWhere` becomes a fragment builder. Scoped: `ScopedRead`; Postgres ran `tx.unsafe`: stays `unsafe`. |
| `deleteChunks` | identical-after-normalization | Placeholder numbering only. |
| `getEmbeddingsByChunkIds` | identical SQL, different driver post-processing | Same statement (raw on both); both drivers return the vector as its text literal. PGLite decoded it with `JSON.parse` (throwing on a malformed row), Postgres with `tryParseEmbedding` (skip and warn once). Unified on Postgres's contract through `decodeEmbedding`: `JSON.parse` when the text is an all-finite numeric array (JSON's number grammar is a subset of `Number()`'s with equal values, so the vector is identical), otherwise `tryParseEmbedding`. The column is a pgvector `vector`/`halfvec`, which rejects NaN/Infinity on input and always emits a well-formed literal, so the two engines' malformed-row branches are unreachable here and results are identical on both. Keeps PGLite's decode speed on the hybrid rescoring path (a first cut on plain `tryParseEmbedding` cost PGLite `hybridSearchCached` about +7%). Since v0.60.131.0 both read `vector_send(col::vector)` and decode it with `decodeVectorSend` (same float4 values, about 2x faster at 100 ids: no vector_out text, smaller wire, no parse). Pinned by `test/engine-sql-chunks.test.ts`. Unscoped: `LegacyUnscopedRead`. |
| `getChunksWithEmbeddings` | identical-after-normalization | Placeholder numbering only; shared `rowToChunk(r, true)`. Unscoped: `LegacyUnscopedRead`. |
| Stays in the engines: `activeEmbeddingColId` (also serves `getStats` / `getHealth`, out of scope), `upsertChunks`'s retry/transaction wrapper, `lockPageKeys` / `readPageSnapshot` (pages domain). No chunks, files or sources method is dialect-specific. | | |
