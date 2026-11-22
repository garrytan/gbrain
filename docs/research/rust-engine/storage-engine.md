# Research maps: storage engine overview

These maps describe how gbrain (TypeScript, `garrytan/gbrain` at commit `8bbfd0b5e8`) uses Postgres and PGLite today. They are the input for the Rust storage engine. Every claim cites `path:line` in the gbrain repo at that commit.

| Map | What it covers |
|---|---|
| [brain-engine.md](brain-engine.md) | Every `BrainEngine` member by family: signature, behavior, SQL, PGLite vs Postgres differences, tests. Also what a Rust engine needs to pass `test/e2e/engine-parity.test.ts`, and binding options for a third engine in Bun. |
| [schema.md](schema.md) | Every table, column, index, function, trigger and migration (132 tables, 313 migrations), with readers and writers. |
| [postgres-features.md](postgres-features.md) | Every Postgres-specific feature, where it is used, what depends on it, and embedded Rust replacements with parity risks. |

The other research maps (agent contract, background jobs, test suites, subsystems, gbrain-evals) are listed in the [index](README.md).

## Confirmed first build target

Garry confirmed option B as the first build target: a Rust storage engine that implements the `BrainEngine` interface as a third engine inside `garrytan/gbrain`, next to PGLite and Postgres. PGLite and Postgres stay supported. PGLite may be deprecated later if the Rust engine proves itself. The binding (napi-rs, sidecar or another option) is still open; see question 1 below.

## Hardest parity risks

1. **Multi-process access to one brain.** Postgres lets the CLI, the MCP server, cron, hooks and job workers write at the same time; coordination is advisory locks, row locks, `SKIP LOCKED` and a lease table. PGLite allows one process per data directory and returns `pglite_busy` to the others. An embedded Rust engine must pick a model: a single writer daemon, SQLite WAL with `BEGIN IMMEDIATE` across processes, or an exclusive file lock. Only the daemon avoids `pglite_busy`-style failures for concurrent commands.
2. **Logic inside the database.** About 25 plpgsql trigger functions maintain derived state (search vectors, revision counters, projection queues, generation clocks) and refuse writes with typed `P0001` messages. Some read session GUCs (`gbrain.write_trust_tier`, `gbrain.write_sources`). Each one must become an explicit, tested Rust write-path step. A missed trigger breaks search or purge with no error.
3. **Keyword ranking.** Keyword search is `websearch_to_tsquery` + `ts_rank` with A/B/C weights, the Snowball English config, size caps on the tsvector input, and a CJK `ILIKE` fallback. BM25 (FTS5, tantivy) gives different scores and stems. Hybrid RRF uses only list order, so order parity is enough there, but `score_details` and keyset cursors expose raw scores.
4. **Vector search.** pgvector HNSW is approximate and tuned per query (`ef_search`, iterative scan), with an exact-scan fallback on Postgres only. A Rust ANN index returns a different top-k at the margin. The exact scan is the parity oracle. `halfvec` storage and dimension reconciliation at connect must be kept.
5. **The parity test does not fit a third engine yet.** `test/e2e/engine-parity.test.ts` needs `DATABASE_URL` for 16 of its 17 blocks, covers 60 of 197 engine members, and makes 46 raw Postgres SQL calls through `executeRaw`. A Rust engine needs either a SQL compatibility layer or a rewrite of those fixtures into typed methods.
6. **`executeRaw` is part of the interface, and it is used everywhere.** 1,203 files in `src/` outside the engine code call `executeRaw` with Postgres SQL (largest groups: `core/persistence` 232, `commands/doctor` 123, `core/repair` 61, `core/facts` 46, `core/minions` 40). A third engine that implements only the typed methods leaves all of these broken. It must either run that SQL (SQLite cannot run most of it) or the callers must move to typed methods. This is likely the largest single cost of the third-engine plan.
7. **Engine differences that callers can see today.** For example, `searchKeywordChunks` filters and the `stale` flag differ between PGLite and Postgres, and several interface doc comments disagree with the code. The Rust engine needs one chosen reference behavior per method.
8. **Upgrades from existing brains.** 313 migrations include data backfills. In-place upgrade of a PGLite or Postgres brain to the Rust engine would need them; an export-and-import path from the markdown brain plus derived state avoids most of them.

## Open architecture questions for Garry

The engine placement is settled (see [Confirmed first build target](#confirmed-first-build-target)). These questions remain open:

1. **Binding.** napi-rs in-process addon (lowest call cost, reuses the `native/locks` prebuild and `require()` embedding pattern, no crash isolation) or a Rust sidecar over a socket (crash isolation, natural single writer for CLI, MCP and cron, per-call serialization and startup cost)? WASM and `bun:ffi` look weak for this use. See the binding section in `brain-engine.md`.
2. **Storage core.** SQLite (rusqlite, bundled) with FTS5 and a vector extension, or a key-value store (redb or fjall) with tantivy and an HNSW crate? SQLite keeps SQL and transactions and makes porting the shared `engine-sql` statements easier. A key-value store gives more control but requires every query to be written by hand.
3. **Concurrency model.** Is one writer per brain acceptable (daemon or `BEGIN IMMEDIATE`), or must several processes write at the same time as on Postgres today?
4. **`executeRaw`.** Can the Rust engine refuse raw Postgres SQL, so that callers must move to typed engine methods first? If not, how much SQL dialect translation is acceptable?
5. **Ranking parity bar.** Is order parity on the eval suites (gbrain-evals) enough for keyword and vector search, or must raw scores match within a tolerance?
6. **Reference behavior.** Where PGLite and Postgres differ, should the Rust engine match Postgres (the safer reference) by default?
7. **Migration path.** Should the Rust engine import existing PGLite and Postgres brains in place, or only through export and re-import?
8. **Access control.** Is it acceptable to drop RLS and database roles and rely on application authorization plus file permissions for the embedded engine?
