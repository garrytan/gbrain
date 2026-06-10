# Performance Review — 2026-06-10

A full-codebase efficiency review of MBrain (~42k lines in `src/core` alone),
split into three areas: the database engine layer, the search/embedding/import
pipeline, and the operations/services/MCP layer. No security or correctness
issues were found; every finding below is a performance or maintainability
concern. Findings are ranked by impact, with file:line references against
commit `81a3424`.

Findings **F1–F6** are addressed on the `worktree-perf-improvements` branch
(one commit per finding). The remaining findings are documented here as future
work.

---

## Fixed in this branch

### F1 (HIGH) — MCP hot path: O(n) dispatch + config file read per tool call

**Files:** `src/mcp/server.ts:684`, `src/mcp/server.ts:694`

Every `CallToolRequest` did two avoidable pieces of work:

1. `operations.find(o => o.name === name)` — a linear scan over 100+
   operations per call. A prebuilt `operationsByName` map already exists at
   `src/core/operations.ts:6185` and was simply not used here.
2. `options.config ?? loadConfig() ?? DEFAULT_RUNTIME_CONFIG` — when
   `options.config` is not supplied (the normal `mbrain serve` path),
   `loadConfig()` performs a synchronous `readFileSync` + `JSON.parse` + env
   resolution on **every** tool invocation. The config is immutable for the
   lifetime of a serve process.

Related: `mcpResultTextBudgetForFinalFrame()` re-parsed
`MBRAIN_MCP_MAX_STDIO_FRAME_BYTES` from `process.env` on every success and
error response.

**Impact:** constant per-call overhead on every single MCP operation —
`retrieve_context`, `read_context`, `get_page`, etc. These are called on
nearly every agent turn.

**Fix:** resolve the operation via `operationsByName`; resolve config and the
result-text budget once at server construction and close over them in the
request handler.

### F2 (HIGH) — Hybrid search serializes independent work

**Files:** `src/core/search/hybrid.ts:29–53`,
`src/core/services/retrieve-context-service.ts:244–250`

The hybrid search flow was:

```
keyword (start) → await expansion → await keyword → await embedding → vector
```

The query embedding has no data dependency on the keyword results — it only
needs the query string — yet it could not start until keyword search fully
completed. On a local embedding runtime each leg costs tens to hundreds of
milliseconds, so every hybrid search paid the full latency of whichever leg
finished later, serially.

Similarly, in `retrieveContext`, `buildOrientation` (a context-map route DB
query) was awaited after the candidate search phase despite being independent
of the search results.

**Impact:** a constant ~50–200 ms tax on every search and every
`retrieve_context` call.

**Fix:** run expansion + embedding concurrently with the keyword search via
`Promise.all`; start `buildOrientation` concurrently with the candidate
search/resolution phase. Embedding-provider resolution moves inside the
parallel branch, so the config read also happens off the critical path.

### F3 (HIGH) — `replaceNoteSectionEntries` N+1 writes + read-back (all 3 engines)

**Files:** `src/core/postgres-engine.ts:3141`, `src/core/pglite-engine.ts:3043`,
`src/core/sqlite-engine.ts:3680`

All three engines deleted a page's section entries and then inserted the
replacements **one row at a time** in a loop — one `await db.query(INSERT...)`
per entry for Postgres/PGLite. A structured note with 40 headings issued 40
sequential round-trips. After the loop, every engine then re-queried the rows
it had just written (`listNoteSectionEntries`) purely to build the return
value, adding one more round-trip.

This runs on every derived re-index of a page's sections: at 1,000 pages ×
30 sections, a full re-index issued ~30,000 serial round-trips.

**Fix:** single multi-row `INSERT ... VALUES` per page (the same pattern
`upsertChunks` already uses in postgres-engine.ts:755–803); construct the
return value in memory from the input entries plus the known timestamp
instead of reading back. SQLite wraps the prepared-statement loop in one
transaction.

### F4 (HIGH) — SQLite `upsertChunks`: one autocommit per chunk

**File:** `src/core/sqlite-engine.ts:1206–1242`

The SQLite engine looped over chunks calling `db.run(INSERT ON CONFLICT ...)`
individually. Outside an explicit transaction, each `run()` is its own
commit — a page with 20 chunks performed 20 separate journal writes. This is
on the hot write path (`putPage` → `ensurePageChunks` → `upsertChunks`); bulk
imports of 1,000 pages × 20 chunks meant 20,000 individual commits, typically
5–10× slower than a single transaction. (The Postgres engine already batches
all chunks into one multi-row INSERT.)

**Fix:** wrap the loop in `this.database.transaction(...)`. The prepared
statement was already hoisted out of the loop.

### F5 (HIGH) — SQLite vector search scans every chunk embedding twice

**File:** `src/core/sqlite-engine.ts:1165–1178`

`searchVector` issued four sequential queries:

1. `getLocalVectorPrefilterPageIds` — load all `page_embedding` blobs, score
   in JS, keep top-N page IDs
2. `queryLocalVectorChunkRows` — load all chunk rows (with embeddings) for
   the shortlisted pages
3. `getOmittedLocalVectorChunkIds` — load **all chunk embeddings for every
   page not in the shortlist**, score in JS, keep top-M chunk IDs
4. `queryLocalVectorChunkRowsByIds` — load full rows for those IDs

Steps 2+3 together deserialized the entire `content_chunks` embedding column
on every query — at 10,000 chunks × 1024 dims × 4 bytes, ~40 MB of Float32
data per search, split across two scans plus an extra round trip.

**Fix:** merge steps 2 and 3 into a single pass over chunk embeddings, then
split shortlist/non-shortlist results in JS. Longer term, an ANN index
(e.g. sqlite-vec) would remove the full scan entirely; that is out of scope
for this branch.

### F6 (HIGH) — Postgres keyword search recomputes tsvectors and stale flags per row

**File:** `src/core/postgres-engine.ts:644–680`

Three per-row inefficiencies in the keyword-search SQL:

1. **Ranking re-parsed raw text.** The `WHERE` clause correctly used the
   trigger-maintained `search_vector` GIN column, but the `SELECT` list
   computed four separate `ts_rank(to_tsvector(...), websearch_to_tsquery(...))`
   expressions from the raw `search_text` / `compiled_truth` / `timeline` /
   `chunk_text` columns. With the `LEFT JOIN content_chunks`, a page with 10
   chunks re-vectorized its multi-KB `compiled_truth` 10 times.
   `websearch_to_tsquery($1)` was also re-evaluated four times per row.
2. **Per-row correlated subquery for `stale`.** Each result row independently
   ran `SELECT MAX(created_at) FROM timeline_entries WHERE page_id = p.id`.
   20 pages × 10 chunks = 200 timeline index probes per search. The same
   pattern existed in the vector search query (postgres-engine.ts:707–710).
3. **Full-column transfer for snippets.** `compiled_truth` and `timeline`
   were shipped to the client in full for every candidate row just so a
   snippet could be extracted in JS.

**Fix:** compute all page-level expressions — the four `ts_rank` scores, the
stale flag, and the derived-state join — once per matched page inside a
`MATERIALIZED` CTE (the keyword prevents the planner from flattening the
subquery and re-inlining the expressions per joined row), then join
`content_chunks` against the CTE so only the per-chunk rank is evaluated per
chunk row. The GIN-indexed `search_vector @@` condition stays inside the CTE.
Applied to both postgres-engine and pglite-engine, which duplicate this
query. (Snippet extraction is left as a follow-up; switching to
`ts_headline` changes snippet output and deserves its own verification
pass — see F18.)

---

## Documented for future work

### F7 (HIGH, maintenance) — postgres-engine ↔ pglite-engine near-total duplication

`postgres-engine.ts` (4,123 lines) and `pglite-engine.ts` (4,096 lines)
implement ~152 methods each; only 2–3 differ meaningfully. The rest are
mechanical translations of the same SQL between the `postgres` tagged-template
API and the PGlite `query()` API. F3 above is direct evidence of the drift
risk: the same N+1 bug existed in both files and had to be fixed twice.

**Suggested fix:** extract a shared base class (or mixin) holding all SQL
logic over a `query(sql, params)` abstraction; each engine supplies only the
transport (`connect`, `query`, `withSearchTimeout`). Highest-leverage
refactor in the codebase — it halves the cost of every future engine fix.

### F8 (HIGH, maintenance) — duplicated validation helpers across operations files

`requiredString` / `optionalString` / `optionalBoolean` / `optionalNumber` /
`requiredObject` / `optionalObject` and the `OperationErrorCtor` type are
re-declared identically in at least:

- `src/core/operations-source-registry.ts:2455–2540`
- `src/core/operations-memory-mutation-ledger.ts:166–307`
- `src/core/operations-memory-control-plane.ts:66–126`
- `src/core/operations-assertions.ts:237–267`

400+ lines of pure duplication; any validation change must be applied N
times. **Suggested fix:** shared `operations-param-utils.ts` module.

### F9 (MEDIUM) — repeated config queries in bulk loops

- `src/commands/embed.ts:116` + `src/core/page-chunk-options.ts:20–22`:
  `embedAll` calls `ensurePageChunks` per page, which calls
  `resolvePageChunkOptions` → two `getConfig` DB queries per page. 1,000
  pages = 2,000 wasted round-trips for values static within a command.
  Resolve once before the loop and pass through. Same issue in
  `replacePageDerivedStorage` (`src/core/import-file.ts:287`) inside the
  derived worker.

### F10 (MEDIUM) — derived artifact state machinery: 13 sequential round-trips per import

`src/core/import-file.ts:346–450`: `enqueuePageDerivedRefresh`,
`markPageDerivedStorageReady`, `getPageDerivedRefreshTargetState`, and
`isPageDerivedStorageCurrent` each iterate the 3-element
`PAGE_DERIVED_ARTIFACTS` array with `await` inside the loop — up to 13
sequential queries per content-changed `put_page`. Use `Promise.all` per
loop; `isPageDerivedStorageCurrent` can use the already-existing plural
`listDerivedIndexStates` engine method.

### F11 (MEDIUM) — tag reconciliation is serial inside the import transaction

`src/core/import-file.ts:158–166`: each `removeTag`/`addTag` is awaited
individually. Independent; can be issued concurrently.

### F12 (MEDIUM) — auto-promote judges candidates strictly sequentially

`src/core/auto-promote/service.ts:72–82`: one LLM subprocess at a time per
candidate. Independent per candidate; bounded parallelism (respecting
`max_runner_calls`) would cut wall-clock roughly by the concurrency factor.

### F13 (MEDIUM) — migrate loop touches all versions on up-to-date schema

`src/core/migrate.ts:3044–3102`: `runMigrations` runs on every serve startup
and iterates all 51 migrations even when none are pending. Use `findIndex`
for the first pending migration and early-return.

### F14 (MEDIUM) — `get_skillpack` re-reads file from disk per call

`src/core/operations.ts:6033`: `readFileSync` + full line-split on every
call. Cache by resolved path in a module-level map.

### F15 (MEDIUM) — `getPageEmbeddings()` loads every embedding unbounded

`postgres-engine.ts:826–850`, `sqlite-engine.ts:1276–1298`,
`pglite-engine.ts:702`: `SELECT id, slug, page_embedding FROM pages` with no
limit — 4 KB per page; 5,000 pages ≈ 20 MB materialized at once. Callers are
migration paths (`migrate.ts:3145`, `migrate-engine.ts:213`); add cursor or
batch parameter and stream in batches of ~500.

### F16 (MEDIUM) — missing index for embedding-coverage counts

`src/schema.sql`: health/stats queries count
`content_chunks WHERE embedded_at IS [NOT] NULL` with no supporting index —
full scans on every `mbrain health` / `mbrain report`. Add a partial index
on `content_chunks(page_id) WHERE embedded_at IS NOT NULL`.

### F17 (MEDIUM) — SQLite `getHealth` issues 5 queries where Postgres uses 1

`src/core/sqlite-engine.ts:1572–1605`: consolidate into one statement with
scalar subqueries, mirroring `postgres-engine.ts:1172`.

### F18 (MEDIUM) — keyword search ships full page content for snippets

Both engines transfer full `compiled_truth`/`timeline` columns per candidate
row to extract a snippet client-side. Postgres can use `ts_headline`
server-side; SQLite can use `substr`/`snippet()`. Changes snippet rendering,
so needs its own test pass (deliberately excluded from F6).

### F19 (MEDIUM) — `read_context` reads selectors sequentially

`src/core/services/read-context-service.ts:89–127`: the token-budget guard
serializes selector reads. For the common small-N, ample-budget case, fetch
in parallel and apply the budget post-hoc.

### F20 (LOW) — chunker micro-inefficiencies

- `src/core/chunkers/semantic.ts:124–215`: Savitzky-Golay coefficients for
  the fixed (5, 3, 1) configuration recomputed per call — precompute at
  module level.
- `src/core/chunkers/recursive.ts:117–152`: `remaining.slice()` reallocation
  per split plus a dead `pieces.includes(remaining)` linear scan; use index
  tracking.
- `src/core/chunkers/recursive.ts:217–295`: `greedyMerge` re-measures the
  full concatenated string per iteration — track a running token count.

### F21 (LOW) — `listBy*InteractionIds` batches run serially

postgres-engine.ts:1976, 2792, 2875, 2897, 3003 (and SQLite equivalents):
500-ID batches issued with `for...await`; `Promise.all` over batches.

### F22 (LOW) — MCP result truncation double-serializes

`src/mcp/server.ts:306–361`: result is `JSON.stringify`ed, immediately
`JSON.parse`d back, then re-stringified up to 8 times in the bisection loop.
Pass the object through and serialize once per attempt.

---

## Suggested roadmap

| Priority | Items | Rationale |
|----------|-------|-----------|
| Done (this branch) | F1–F6 | Hot-path wins, no contract changes |
| Next | F9, F10, F13, F16 | Cheap, measurable import/startup wins |
| Then | F8, F14, F17, F19, F21, F22 | Small cleanups |
| Structural (own PR) | F7 engine unification | Halves all future engine maintenance |
| Needs design | F5 follow-up (ANN index), F18 (server-side snippets), F12, F15, F20 | Behavior-visible or dependency decisions |
