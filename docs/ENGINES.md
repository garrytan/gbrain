# Pluggable Engine Architecture

## The idea

Every GBrain operation goes through `BrainEngine`. The engine is the contract between "what the brain can do" and "how it's stored." Swap the engine, keep everything else.

Two engines ship today: `PGLiteEngine` — embedded Postgres via WASM (@electric-sql/pglite), the zero-config default — and `PostgresEngine`, backed by Supabase or any Postgres + pgvector. The interface is designed so a `DuckDBEngine`, `TursoEngine`, or any custom backend could slot in without touching the CLI, MCP server, skills, or any consumer code.

## Why this matters

Different users have different constraints:

| User | Needs | Best engine |
|------|-------|-------------|
| Getting started | Zero-config, no accounts, no server | PGLiteEngine (the default) |
| Power user (you) | World-class search, 7K+ pages, zero-ops | PostgresEngine + Supabase |
| Open source hacker | Single file, no server, git-friendly | PGLiteEngine |
| Team/enterprise | Multi-user, RLS, audit trail | PostgresEngine + self-hosted |
| Researcher | Analytics, bulk exports, embeddings | DuckDBEngine (someday) |
| Edge/mobile | Offline-first, sync later | PGLiteEngine + sync (someday) |

The engine interface means we don't have to choose. PGLite is the zero-friction default. Supabase is the production scale path. `gbrain migrate --to supabase/pglite` moves between them.

## The interface

**The single source of truth is `export interface BrainEngine` in
`src/core/engine.ts`.** It is large (100+ methods) and grows with every
feature wave — do NOT work from any snapshot of it, including an old copy of
this doc. Read the interface itself, and let
`test/e2e/engine-parity.test.ts` + `test/pglite-engine.test.ts` tell you
whether both engines agree.

The method families, to orient you before opening the file:

- **Lifecycle + identity** — `connect` / `disconnect` / `reconnect`,
  `initSchema`, `transaction`, `withReservedConnection`, and the `kind`
  discriminator (`'pglite' | 'postgres'`) for the rare engine-specific branch.
- **Pages CRUD** — `getPage`, `putPage`, `deletePage`, `listPages`, slug
  resolution.
- **Search** — `searchKeyword`, `searchVector`, chunk-level variants, takes
  search (keyword + vector), and `relationalFanout` (the typed-edge recall
  arm).
- **Chunks + embeddings** — upsert/get, embedding-bearing variants.
- **Graph** — links (single + batch writers), backlinks, `traverseGraph`,
  `traversePaths`.
- **Tags, timeline (single + batch), raw data, versions.**
- **Takes / facts / eval / salience** — the epistemological layer and the
  instruments over it.
- **Stats, health, ingest log, config, migrations.**

### Key design choices

**Slug-based API, not ID-based.** Every method takes slugs, not numeric IDs. The engine resolves slugs to IDs internally. This keeps the interface portable... slugs are strings, IDs are database-specific.

**Embedding is NOT in the engine.** The engine stores embeddings and searches by vector, but it doesn't generate embeddings. `src/core/embedding.ts` handles that (a thin delegation to the provider-agnostic AI gateway in `src/core/ai/gateway.ts`). This is intentional: embedding is an external API call (OpenAI, Voyage, a local Ollama — whichever provider you configured), not a storage concern. All engines share the same embedding service.

**Chunking is NOT in the engine.** Same logic. `src/core/chunkers/` handles chunking. The engine stores and retrieves chunks. All engines share the same chunkers.

**Search returns `SearchResult[]`, not raw rows.** The engine is responsible for its own search implementation (tsvector vs FTS5, pgvector vs sqlite-vss) but must return a uniform result type. RRF fusion and dedup happen above the engine, in `src/core/search/hybrid.ts`.

**`traverseGraph` exists but is engine-specific.** Postgres uses recursive CTEs. SQLite would use a loop with depth tracking. The interface is the same: give me a slug and max depth, return the graph.

## How search works across engines

```
                        +-------------------+
                        |  hybrid.ts        |
                        |  (RRF fusion +    |
                        |   dedup, shared)  |
                        +--------+----------+
                                 |
                    +------------+------------+
                    |                         |
           +--------v--------+       +--------v--------+
           | engine.search   |       | engine.search   |
           |   Keyword()     |       |   Vector()      |
           +-----------------+       +-----------------+
                    |                         |
        +-----------+-----------+   +---------+---------+
        |                       |   |                   |
+-------v-------+  +-------v---+   +-------v---+  +----v--------+
| Postgres:     |  | PGLite:   |   | Postgres: |  | PGLite:     |
| tsvector +    |  | tsvector +|   | pgvector  |  | pgvector    |
| ts_rank +     |  | ts_rank   |   | HNSW      |  | HNSW        |
| websearch_to_ |  | (same SQL)|   | cosine    |  | cosine      |
| tsquery       |  |           |   |           |  | (same SQL)  |
+---------------+  +-----------+   +-----------+  +-------------+
```

RRF fusion, multi-query expansion, and 4-layer dedup are engine-agnostic. They operate on `SearchResult[]` arrays. Only the raw keyword and vector searches are engine-specific.

## PostgresEngine

**Dependencies:** `postgres` (porsager/postgres), `pgvector`

**Postgres-specific features used:**
- `tsvector` + `GIN` index for full-text search with `ts_rank` weighting
- `pgvector` HNSW index for cosine similarity vector search
- `pg_trgm` + `GIN` for fuzzy slug resolution
- Recursive CTEs for graph traversal
- Trigger-based search_vector (spans pages + timeline_entries)
- JSONB for frontmatter with GIN index
- Connection pooling via Supabase Supavisor (port 6543)

**Hosting:** Supabase Pro ($25/mo, zero-ops, pgvector built in) is the managed path; self-hosted Postgres + pgvector (Docker or Homebrew — recipe in the troubleshooting section below) works the same.

### Opt-in RLS source-scope binding (`GBRAIN_RLS_SCOPE_BINDING`)

Defense-in-depth layer for Postgres deployments that want the database itself
to enforce source isolation, in addition to the mandatory app-layer filters
(`sourceScopeOpts` — layer 1, always on).

**Mechanism.** With `GBRAIN_RLS_SCOPE_BINDING=1` (or `true`), the engine's
source-scoped read methods wrap their queries in a transaction that first runs
`SELECT set_config('app.scopes', $1, true)` — the value is a bound parameter
(federated `sourceIds` CSV > scalar `sourceId` > `'*'` for unscoped internal
reads), transaction-local (equivalent to `SET LOCAL`, which itself can't take
bound params). An RLS policy can then filter rows by
`current_setting('app.scopes', true)`.

**Default off.** With the env var unset, reads call through on the shared pool
exactly as before — no per-read transaction, no pool-slot hold (the search
methods keep the transaction they always had for their `SET LOCAL
statement_timeout`). Existing operators see zero behavior change.

**Enabling it** (operator-managed SQL; gbrain ships no DDL for this):

```sql
ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY pages_scope_filter ON pages
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));

-- Required: connections that don't run through the scoped read helper
-- (admin, autopilot, cycle, writes) must default to unscoped, or they
-- see zero rows once the policy exists:
ALTER ROLE <runtime-role> SET app.scopes = '*';

-- If the runtime role OWNS the table, RLS is skipped for it unless forced:
ALTER TABLE pages FORCE ROW LEVEL SECURITY;
```

Safe to enable in either order: the env var without a policy is a no-op
setting; a policy without the env var is enforced only via the role default.

**Honest caveat:** only read paths routed through the scoped helper carry a
per-request scope binding — unwrapped paths (writes, admin/maintenance reads)
run under the role default and are not backstopped per caller. This is layer 2;
the app-layer source filters remain layer 1 and stay mandatory. Behavioral pins
live in `test/postgres-engine-rls-scope.test.ts`.

## PGLiteEngine

**Dependencies:** `@electric-sql/pglite`

**What it is:** Embedded Postgres compiled to WASM via ElectricSQL's PGLite. Runs in-process, no server, no Docker, no accounts. Same SQL as PostgresEngine -- not a separate dialect. Implements the full `BrainEngine` interface; `test/e2e/engine-parity.test.ts` pins that the two engines move in lockstep.

**PGLite-specific details:**
- Uses `pglite-schema.ts` for DDL (pgvector extension, pg_trgm, triggers, indexes)
- Parameterized queries throughout (shared utilities in `src/core/utils.ts`)
- `hybridSearch` keyword-only fallback when `OPENAI_API_KEY` is not set
- Data stored at `~/.gbrain/brain.pglite` (configurable)
- pgvector HNSW index for cosine similarity vector search (same as Postgres)
- tsvector + ts_rank for full-text search (same as Postgres)
- pg_trgm for fuzzy slug resolution (same as Postgres)

**When to use PGLite vs Postgres:**

| Factor | PGLite | PostgresEngine + Supabase |
|--------|--------|--------------------------|
| Setup | `gbrain init` (zero-config) | Account + connection string |
| Scale | Good for < 1,000 files | Production-proven at 10K+ |
| Multi-device | Single machine only | Any device via remote MCP |
| Cost | Free | Supabase Pro ($25/mo) |
| Concurrency | Single process | Connection pooling |
| Backups | Manual (file copy) | Managed by Supabase |

**Migration:** `gbrain migrate --to supabase` exports everything (pages, chunks, embeddings, links, tags, timeline, facts) and imports into Supabase. Config rows copy in full minus the engine-local denylist (`MIGRATE_CONFIG_ENGINE_LOCAL_KEYS`: the target-owned `engine`/`version` connection + schema ledger and the physical embedding-column registry keys); skipped keys are printed, never silent, and the run ends with a per-table copied-count summary. `gbrain migrate --to pglite` goes the other direction. Bidirectional, lossless.

The migration and the autopilot daemon do not race: `migrate --to` claims a
cooperative pause marker before touching the target. The marker doubles as a
migration mutex — a second concurrent migrate refuses to run, and a marker
that cannot be written refuses the migration outright. Background job workers
stop picking up new work while it is parked, and the migration waits for
in-flight sync/embed/cycle work and running jobs to actually drain (watching
the DB lock table, capped by `GBRAIN_MIGRATE_QUIESCE_SECONDS` — default 300;
`0` skips the wait). Cleanup registers the moment the claim lands, so the
marker is released on failure and on catchable signals; a marker orphaned by
an uncleanly killed run is adopted by a later migrate only after a
pid-liveness check (a live migrate's marker is never stolen), and the daemon
clears an orphan whose owning process died on its next poll. `gbrain
autopilot --status` reports `paused` (exit 1) while the marker is parked and
prints the marker path; on a host with no daemon running to self-heal,
remove an orphan by hand only after confirming the pid it names is dead.
After a clean flip the daemon detects the engine change on its next
tick and relaunches onto the new engine, and the migration warns if an
exported connection-string env var would override the new config.

### Troubleshooting: startup abort (`RuntimeError: Aborted()`)

**Symptom:** every PGLite-touching command dies at startup with
`PGLite failed to initialize its WASM runtime … Aborted(). Build with
-sASSERTIONS for more info.` — commonly first seen right after a macOS
upgrade.

**Real root cause:** corrupt WAL/checkpoint state in the data dir after an
unclean shutdown (the OS-upgrade reboot kills gbrain mid-write and tears the
write-ahead log; every subsequent open fails WAL replay inside WASM and
Emscripten surfaces only the opaque abort). It is **not** a macOS/WASM
incompatibility — the same signature reproduces across macOS versions and on
Linux, and rebuilding the data dir on the same OS fixes it. No pglite or Bun
version bump changes it.

**Recovery ladder** (top rung first):

1. **Auto-repair (default).** `PGLiteEngine.connect()` detects the abort,
   backs up `pg_wal/` + `pg_control` into a sibling
   `<dataDir>.wal-repair-backup-<ts>/` dir, resets the WAL in place
   (pg_resetwal semantics — data files preserved; transactions not
   checkpointed before the corruption may be lost), and retries once. On
   success it prints a loud stderr notice naming the backup and recommending
   `gbrain doctor`. Safety bounds: repair only runs under a cleanly-acquired
   data-dir lock (never after reaping another process's lock), skips for a
   cooldown window after a failed attempt
   (`GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS`, default 3600), reuses one
   backup per corruption episode (newest 3 episodes retained), and restores
   the original files if the retry still fails. Kill-switch:
   `GBRAIN_PGLITE_WAL_REPAIR=off`.
2. **Manual repair.** `gbrain pglite-repair --dry-run` diagnoses the data dir
   (read-only); `gbrain pglite-repair --yes` runs the same in-place WAL reset
   deliberately. Refuses when another gbrain process holds the brain (a live
   `gbrain serve` is named explicitly) and never force-removes `.gbrain-lock`.
3. **Rebuild.** `gbrain reinit-pglite` (embedding model/dimensions default
   from your config) wipes and re-creates the brain from your brain repo, or
   manually: back up `~/.gbrain`, move `brain.pglite` aside,
   `gbrain init --pglite`, re-add sources, `gbrain sync`, `gbrain embed`.
   Required for *catalog* corruption (58P01 / pgvector load failure) — WAL
   repair cannot fix that class.
4. **Switch engines.** `gbrain init --supabase`, or native Postgres +
   pgvector (recipe below, contributed by @roysaurav):

   ```bash
   brew install postgresql@17
   brew services start postgresql@17
   createdb gbrain
   cd /tmp && git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git
   cd pgvector && make && make install
   psql gbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"
   # ~/.gbrain/config.json: { "engine": "postgres",
   #   "database_url": "postgresql://localhost:5432/gbrain" }
   gbrain apply-migrations --yes && gbrain doctor
   ```

`gbrain doctor` runs a `pglite_data_dir` check whenever a PGLite brain fails
to connect: it diagnoses the dir from disk, names the repair command, reports
retained repair backups, and escalates when repairs keep recurring (that
means the unclean-shutdown genesis is still active — see the ladder's rung 4).

## JSONB writes: never double-encode (the #2339 trap)

Writing a JS value into a `jsonb` column has exactly two correct forms. Get this
wrong and the write succeeds on PGLite but stores a **jsonb string scalar** on
real Postgres — `col ->> 'k'` returns NULL, `jsonb_array_elements` throws, and a
`jsonb_typeof = 'array'` CHECK rejects the row (this aborted every sync in #2339).

| Form | Verdict |
|---|---|
| Template tag: `` sql`... ${sql.json(obj)}` `` (postgres-engine only) | ✅ native jsonb serialization |
| Positional raw call, raw object: `executeRawJsonb(engine, sql, scalars, [obj])` | ✅ object reaches the wire as jsonb |
| Positional raw call, stringified: `executeRaw(\`... $N::text::jsonb\`, [JSON.stringify(x)])` | ✅ binds as text, the cast parses it |
| Positional raw call, BARE cast: `executeRaw(\`... $N::jsonb\`, [JSON.stringify(x)])` | ❌ **double-encodes** under postgres.js `.unsafe()` |
| Template literal interpolation: `` `... ${JSON.stringify(x)}::jsonb` `` | ❌ double-encodes |

**Why:** postgres.js `.unsafe(sql, params)` (the path behind `executeRaw` /
`executeRawDirect`) binds a JS **string** as a text param. A bare `$N::jsonb`
cast then wraps that already-JSON string into a jsonb scalar string instead of
parsing it. Casting through `$N::text::jsonb` forces a text→jsonb parse.
**PGLite's `db.query` parses text→jsonb natively, so it hides the bug** — which is
why a regression only shows up on Postgres (and why the parity test must run there).

**Two CI guards enforce this, both wired into `scripts/check-jsonb-pattern.sh`:**
- the template-tag grep (`${JSON.stringify(x)}::jsonb`), and
- `scripts/check-jsonb-params.mjs`, an AST-lite scanner for the positional
  `$N::jsonb` + `JSON.stringify` form the grep misses. Sanctioned escapes:
  `$N::text::jsonb`, `$N::text[]`, `executeRawJsonb`, `sql.json`, or an inline
  `jsonb-guard-ok` comment.

The real backstop is `test/e2e/op-checkpoint-jsonb-parity.test.ts` +
`test/e2e/jsonb-roundtrip.test.ts`, which round-trip writes through real Postgres
and assert `jsonb_typeof` — the assertion PGLite cannot make.

## Adding a new engine

1. Create `src/core/<name>-engine.ts` implementing `BrainEngine`
2. Add to engine factory in `src/core/engine-factory.ts`:
   ```typescript
   export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
     switch (config.engine || 'postgres') {
       case 'pglite': {
         const { PGLiteEngine } = await import('./pglite-engine.ts');
         return new PGLiteEngine();
       }
       case 'myengine': {
         const { MyEngine } = await import('./my-engine.ts');
         return new MyEngine();
       }
       // ...
     }
   }
   ```
   The factory uses dynamic imports so an engine's dependencies (e.g. the
   PGLite WASM blob) are only loaded when that engine is selected.
3. Store engine type in `~/.gbrain/config.json`: `{ "engine": "myengine", ... }`
4. Add tests. The test suite should be engine-agnostic where possible... same test cases, different engine constructor.
5. Document in this file + add a design doc in `docs/`

### What you DON'T need to touch

- `src/cli.ts` (dispatches to engine, doesn't know which one)
- `src/mcp/server.ts` (same)
- `src/core/chunkers/*` (shared across engines)
- `src/core/embedding.ts` (shared across engines)
- `src/core/search/hybrid.ts`, `expansion.ts`, `dedup.ts` (shared, operate on SearchResult[])
- `skills/*` (fat markdown, engine-agnostic)

### What you DO need to implement

Every method in `BrainEngine`. The full interface. No optional methods, no feature flags. If your engine can't do vector search (e.g., a pure-text engine), implement `searchVector` to return `[]` and document the limitation.

## Capability matrix

| Capability | PostgresEngine | PGLiteEngine | Notes |
|-----------|---------------|-------------|-------|
| CRUD | Full | Full | Same SQL |
| Keyword search | tsvector + ts_rank | tsvector + ts_rank | Identical (real Postgres) |
| Vector search | pgvector HNSW | pgvector HNSW | Identical (real Postgres) |
| Fuzzy slug | pg_trgm | pg_trgm | Identical (real Postgres) |
| Graph traversal | Recursive CTE | Recursive CTE | Same SQL |
| Transactions | Full ACID | Full ACID | Both support this |
| JSONB queries | GIN index | GIN index | Identical |
| Concurrent access | Connection pooling | Single process | PGLite limitation |
| Hosting | Supabase, self-hosted, Docker | Local file | |
| Migration methods | runMigration, getChunksWithEmbeddings | Same | Identical |

## Future engine ideas

**TursoEngine.** libSQL (SQLite fork) with embedded replicas and HTTP edge access. Would give SQLite's simplicity with cloud sync. Interesting for mobile/edge use cases.

**DuckDBEngine.** Analytical workloads. Bulk exports, embedding analysis, brain-wide statistics. Not for OLTP. Could be a secondary engine for analytics alongside Postgres for operations.

**Custom/Remote.** The interface is clean enough that someone could build an engine backed by any storage: Firestore, DynamoDB, a REST API, even a flat file system. The interface doesn't assume SQL.

Note: The original SQLite engine plan (`docs/SQLITE_ENGINE.md`) was superseded by PGLite. PGLite uses the same SQL as Postgres, eliminating the need for a separate SQLite dialect with FTS5/sqlite-vss translation.
