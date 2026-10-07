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

The engine interface means we don't have to choose. PGLite is the zero-friction default. Supabase is the production scale path. `gbrain migrate --to postgres` moves a PGLite brain to Postgres with its history ([guide](guides/move-to-postgres.md)); `gbrain migrate --to pglite` moves a brain without write history the other way.

## The interface

**The single source of truth is `export interface BrainEngine` in
`src/core/engine.ts`.** It is large (100+ methods) and grows with every
feature — do NOT work from any snapshot of it, including an old copy of
this doc. Read the interface itself, and let
`test/e2e/engine-parity.test.ts` + `test/pglite-engine.test.ts` tell you
whether both engines agree. A method in a migrated storage domain has its
SQL once in `src/core/engine-sql/` (see "Storage domains and engine-sql"
below).

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

**Search returns `SearchResult[]`, not raw rows.** The engine is responsible for its own search implementation (tsvector vs FTS5, pgvector vs sqlite-vss) but must return a uniform result type. RRF fusion and dedup happen above the engine, in `src/core/search/hybrid.ts` and its stages under `src/core/search/hybrid/`.

**`traverseGraph` exists but is engine-specific.** Postgres uses recursive CTEs. SQLite would use a loop with depth tracking. The interface is the same: give me a slug and max depth, return the graph.

## Storage domains and engine-sql

Both engines speak the same SQL dialect, so a storage domain's SQL is written
once. `src/core/engine-sql/<domain>.ts` holds it; each engine method in that
domain is a one-line delegation. The domains migrated so far are the
`migrated` rows of `scripts/engine-sql-baseline.tsv`; the remaining rows of
that file are the engine members that still carry their own SQL, and the file
only shrinks (`check:engine-sql-ratchet` fails on a new SQL-bearing engine
member).

```
PGLiteEngine / PostgresEngine   one-line delegations; RLS scoping per method
      | get engineSql()         fresh adapter per access, never stored
      v
engine-sql/<domain>.ts          the domain's SQL once; sqlFragment composition;
      |                         ScopedRead / LegacyUnscopedRead brands; row kinds
      v
engine-sql/executor.ts          SqlExecutor: query / run / executeRaw / unsafe /
      |                         transaction; results as { rows, affectedRows }
      +--> dialect-pglite.ts    db.query on the engine's checkpoint-admitted handle
      +--> dialect-postgres.ts  runUnsafe(conn, sql, params, { prepare: true, simple: false })
```

The contract, each part pinned by a test listed in
[docs/TESTING.md, "Engine-sql"](TESTING.md#engine-sql):

- **Lifetime.** `engineSql` reads the engine's current connection on every
  access. `transaction()` clones the engine with a swapped connection, so a
  stored executor would write outside the transaction.
- **Parameters.** Positional only, composed with `sqlFragment` (placeholders
  are numbered at render time). Arrays bind as `= ANY($n::type[])`, JSONB
  through `jsonbParam()`, vectors as a text literal with a `::vector` cast.
  Only constant text may be spliced (`check:engine-sql-dynamic`).
- **Results and errors.** `{ rows, affectedRows }`; driver errors pass through
  unchanged. Columns whose decoding differs between drivers are declared once
  per statement with `compileRowNormalizer`.
- **Capabilities.** Real engine differences are capabilities on the executor
  (`maxBindParamsPerStatement`, `transactionAdvisoryLocks`,
  `probesEmbeddingCast`), never `if (engine === ...)` in domain code.
- **RLS scope.** Every read declares how it is scoped: `ScopedRead` (runs
  inside `withScopedReadTransaction` on Postgres, see the RLS section below)
  or `LegacyUnscopedRead` (runs on the pool, obtained with
  `unscopedExecutor(executor, reason)`). The brands are unforgeable
  (`check:engine-sql-brands`).
- **Layering.** Nothing under `engine-sql/` imports an engine façade
  (`check:layering`); take the executor as a parameter.

Code that is genuinely dialect-specific stays in the engine or in
`src/core/pglite-engine/` / `src/core/postgres-engine/`, marked
`// engine-sql-ok: <reason>`. The forward-reference bootstrap both engines run
before replaying the schema blob is `engine-sql/bootstrap.ts`. A step-by-step
read and write example is in
[CONTRIBUTING.md, "Worked example"](../CONTRIBUTING.md#worked-example-an-engine-sql-read-and-write).

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

**Hosting:** Supabase Pro ($25/mo, zero-ops, pgvector built in) is the managed path; self-hosted Postgres + pgvector (Docker or Homebrew — see the "Local Postgres" section below) works the same.

Current-projection filters use `(text_projection_revision = knowledge_revision)
IS TRUE` with matching expression statistics, rather than relying on the
planner's fixed column-equality estimate. Migration 160 creates and collects
those statistics; bulk import, sync, reindex and completed projection recovery
refresh them outside page locks. This also matters on PGLite, where an empty
initial schema sample cannot describe later imports. Maintenance needs an
authorized database role; an RLS-hidden statistics view is not evidence that
the object is absent. Highly selective queries may correctly choose an exact
plan. The [retrieval guide](architecture/RETRIEVAL.md#named-thing-retrieval-per-page-pool--title--alias--evidence)
describes bounded candidate recovery and incomplete-result metadata.

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
with no per-read transaction and no pool-slot hold (the search methods keep
their own transaction for `SET LOCAL statement_timeout` and `jit = off`).

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

**In engine-sql.** A read in a migrated domain takes a `ScopedRead` when it
runs through this helper and a `LegacyUnscopedRead` when it runs on the pool
(`src/core/engine-sql/brands.ts`); the engine obtains the branded executor, so
the type system keeps each read's scoping as it is. Moving a read from
unscoped to scoped adds a transaction and a pool hold per read with the flag
on, so it is a deliberate change with its own load test, never a drive-by.
The non-owner `NOBYPASSRLS` isolation test is
`test/e2e/engine-sql-rls-scope.test.ts`.

## Local Postgres

Self-hosted Postgres + pgvector gives you the PostgresEngine without a Supabase
account. Two paths:

**Homebrew (macOS)**:

```bash
brew install postgresql@17
brew services start postgresql@17
createdb gbrain
cd /tmp && git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git
cd pgvector && make && make install
psql gbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"
gbrain init --url postgresql://localhost:5432/gbrain
gbrain doctor
```

`gbrain init --url <conn>` writes the config file and runs the schema setup in
one step. To point an EXISTING brain config at a different database without
re-initializing, use `gbrain config set database_url <conn>` — it routes to the
file plane (`~/.gbrain/config.json`), infers `engine: postgres`, and works even
when the current database is unreachable.

**Ladder-driven (harness installs)** — `gbrain init --prefer-postgres` probes
for a usable Postgres before falling back to PGLite: an env URL, Supabase
Management-API discovery (`SUPABASE_ACCESS_TOKEN` + `SUPABASE_DB_PASSWORD`), a
local server (only when `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` are set or
`--local-postgres` is passed; `CREATE DATABASE gbrain` needs explicit
`--allow-create-db`), or — with explicit `--allow-docker` — gbrain's own
container `gbrain-postgres` (image `pgvector/pgvector:pg16`, loopback-only
host port 5434, data on the named `gbrain-pgdata` volume,
`--restart unless-stopped`). The ladder REFUSES over an already-configured
brain (re-runs during an outage must never let the PGLite floor overwrite a
healthy Postgres config — that lane is `gbrain db-repair`), and a bare
`DATABASE_URL` is adopted only when the target is already a gbrain brain or
holds no tables at all (`GBRAIN_DATABASE_URL` is always stated intent).
gbrain starts and reuses that container but never stops or removes it; an
existing container is reused with its REAL credentials recovered via
`docker inspect`, never a freshly generated password — and never reused when
its database already holds a brain this home's config doesn't record.
Details in INSTALL_FOR_AGENTS.md ("Engine preference for harness installs").

## PGLiteEngine

**Dependencies:** `@electric-sql/pglite`

**What it is:** Embedded Postgres compiled to WASM via ElectricSQL's PGLite. Runs in-process, no server, no Docker, no accounts. Same SQL as PostgresEngine -- not a separate dialect. Implements the full `BrainEngine` interface; `test/e2e/engine-parity.test.ts` pins that the two engines move in lockstep.

**PGLite-specific details:**
- Uses the generated `pglite-schema.generated.ts` template for DDL (pgvector extension, pg_trgm, triggers, indexes; see "Canonical schema sources" below)
- Parameterized queries throughout (shared utilities in `src/core/utils.ts`)
- `hybridSearch` keyword-only fallback when no embedding provider key is configured
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

**Migration:** on a PGLite brain, `gbrain migrate --to postgres` (alias `--to supabase`) graduates the brain to Postgres. Without `--yes` it prints the plan and exits 3; `--yes --expect <plan_hash>` runs it. Graduation drains pending writes, copies every table verbatim with its primary keys (pages, facts, takes, versions, links, timeline, embeddings, transcripts and paid caches, request history and withdrawals, token and OAuth rows) into a fenced target, verifies row counts and digests, runs `gbrain doctor` on the target, and only then flips routing. It works for brains with write history and for managed brains. The PGLite data dir is retained as `<path>.graduated-<run_id>` and a tombstone file takes its place. Walkthrough, recovery by error code, rollback and what stays on this computer: [Move a PGLite brain to Postgres](guides/move-to-postgres.md).

**Say to your agent:** *"Upgrade my brain to Postgres. Show me the plan first."*

The legacy copier handles every other direction: `gbrain migrate --to pglite`, PGLite to Postgres when `gbrain config set migrate.graduation false` opts out of graduation, and history-free brains on Windows. It re-creates pages through `putPage` (chunks, embeddings, links, tags, timeline, facts) and copies config rows minus the engine-local denylist (`MIGRATE_CONFIG_ENGINE_LOCAL_KEYS`: the target-owned `engine`/`version` connection + schema ledger and the physical embedding-column registry keys); skipped keys are printed, never silent, and the run ends with a per-table copied-count summary. It does not carry request IDs, withdrawals, attribution or ownership, so it refuses a managed brain and any brain with durable write history, fact withdrawals or canonical worktree ownership (rows in `persistence_requests`, `fact_withdrawals` or `persistence_worktrees`).

<a id="engine-migration-refused"></a>**Engine migration refused (`writer_coordinator_required`).** The legacy copier's refusal is an agent-contract envelope whose `fix` names the refusing side; every branch verifies with the read-only `gbrain doctor --no-migrate --json`, and nothing has changed in either datastore:

| Refusing side | `fix.next` | Next step |
|---|---|---|
| A PGLite brain with history (or a managed one) moving to Postgres with graduation turned off | `ask_user` (consent `egress`) | Relay `user_message`: turn graduation back on (`fix.argv`: `gbrain config unset migrate.graduation`) and preview the move with the read-only plan (`fix.then`: `gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --plan --json`, then the [two-command flow](guides/move-to-postgres.md#move-the-brain)), or keep it on PGLite and share it through `gbrain mcp expose`. |
| A Postgres brain moving to PGLite | `report` | The brain stays on Postgres; moving down would drop its history. |
| A target that already holds persistence history | `tell_user_to_run` | Rerun with an empty database the user provides (`--path` for a PGLite target). |

On Windows, a PGLite brain with history gets `graduation_unsupported_platform` instead: it stays on PGLite and is shared with `gbrain mcp expose`.

<a id="graduation-writer-held"></a>**Graduation refused: the brain is held (`graduation_source_writer_held`).** Graduation needs the PGLite kernel lock. A live stdio `gbrain serve` hands the brain over through the intent marker `<path>.gbrain-graduation.json` and exits; autopilot pauses. When another holder (an HTTP serve, a daemon, another command) does not release the brain within 30 seconds, the run refuses and names it with its pid and transport (`fix.next: tell_user_to_run`). The user stops that process, then the agent reruns the same `gbrain migrate` command. Verify with the read-only `gbrain migrate --status --json`. Nothing has changed in either datastore.

The migration and the autopilot daemon do not race: both graduation and the
legacy copier claim a cooperative pause marker before touching the target. The
marker doubles as a migration mutex — a second concurrent migrate refuses to
run (graduation exits 75 with `graduation_in_progress`), and a marker that
cannot be written refuses the migration outright. Background job workers stop
picking up new work while it is parked. The legacy copier then waits for
in-flight sync/embed/cycle work and running jobs to drain (watching the DB lock
table, capped by `GBRAIN_MIGRATE_QUIESCE_SECONDS` — default 300; `0` skips the
wait). Graduation holds the PGLite kernel lock instead, so no other process has
the brain open: expired run locks and active job leases are orphans it resets
at once, and it waits only for queued write requests, bounded by
`--drain-timeout` (default 60 seconds; exhaustion exits 11 with a
`resume_command`). Cleanup registers the moment the claim lands, so the marker
is released on failure and on catchable signals; a marker orphaned by an
uncleanly killed run is adopted by a later migrate only after a pid-liveness
check (a live migrate's marker is never stolen), and the daemon clears an
orphan whose owning process died on its next poll. `gbrain autopilot --status`
reports `paused` (exit 1) while the marker is parked and prints the marker
path; on a host with no daemon running to self-heal, remove an orphan by hand
only after confirming the pid it names is dead. After a clean flip the daemon
detects the engine change on its next tick and relaunches onto the new engine,
and the migration warns if an exported connection-string env var would
override the new config (graduation lists such a variable as a plan blocker).

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
   checkpointed before the corruption may be lost), and retries once. The
   reset does not rebuild indexes, so a page written just before the crash
   can be missing from vector search while keyword search still finds it.
   On success it prints a loud stderr notice naming the backup and the next
   commands: `gbrain reindex --vectors` (rebuilds every HNSW index from the
   stored vectors, no re-embedding) and then `gbrain doctor`. Safety bounds: repair only runs under a cleanly-acquired
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
   pgvector — see the "Local Postgres" section above for the full recipe
   (Homebrew or the `gbrain init --prefer-postgres` ladder).

`gbrain doctor` runs a `pglite_data_dir` check whenever a PGLite brain fails
to connect: it diagnoses the dir from disk, names the repair command, reports
retained repair backups, and escalates when repairs keep recurring (that
means the unclean-shutdown genesis is still active — see the ladder's rung 4).

## Canonical schema sources

Schema DDL text has one hand-edited copy. `bun run build:schema`
(`scripts/build-schema.ts`) generates everything else in a fixed order:

```
TS fragment modules (canonical for their tables) ─┐
src/schema.sql (canonical for every other table) ─┴─> src/schema.sql BEGIN/END GENERATED regions
                                                        ├─> src/core/schema-embedded.generated.ts (Postgres blob)
                                                        └─> src/core/pglite-schema.generated.ts   (PGLite template)
```

- **Fragments** (`FRAGMENTS` in the generator): `grants/schema.ts`, `facts/withdrawal-schema.ts`,
  `lease-schema.ts`, `page-state/schema.ts`, `persistence/schema.ts`,
  `page-state/projection-schema.ts`, `persistence/topology-schema.ts`,
  `company-brain/receipt-schema.ts`, `shared-skills/schema-all.ts`. Migrations import the same
  constants, so a fragment is also the migration text. Each has one region in `src/schema.sql`
  whose banner names the file to edit; never edit inside a region.
- **PGLite template**: every `src/schema.sql` statement and fragment, transformed by explicit
  capability rules (`PGLITE_RULES`, `PGLITE_DO_BLOCKS`, `PGLITE_ADDITIONS`, each with a reason).
  `getPGLiteSchema(dims, model)` fills `__EMBEDDING_DIMS__` / `__EMBEDDING_MODEL__` and applies the
  chunk-index and FTS-language policies at runtime. An unknown statement kind, an unclassified
  `DO` block, or a rule that no longer matches fails the build.
- **Guards**: `check:schema-fresh` regenerates the whole chain into a temp dir and names the source
  to edit on drift; the catalog goldens (`test/schema-catalog-golden.test.ts`,
  `test/e2e/schema-catalog-golden.test.ts`) and `test/pglite-upgrade-replay.test.ts` pin the end
  state.

Engine differences in the bootstrap (not reconciled; changing them is a schema change):
`file_migration_ledger` is Postgres-only. PGLite gets `code_edges_chunk`, `code_edges_symbol`,
`dream_verdicts`, `sources.chunker_version`, the `content_chunks` code-symbol and `search_vector`
columns (with their indexes and trigger), `pages_generation_idx` and `idx_pages_updated_at_desc`
from migrations. Postgres gets `slug_aliases`, `page_aliases`, the `page_links` view and
`persistence_requests_database_pending` from migrations.

Worked examples:

1. **Add a column or index to a hand-written table** (say `pages.foo`). Scaffold the migration
   (`bun run new:migration add_pages_foo`: `ALTER TABLE pages ADD COLUMN IF NOT EXISTS foo TEXT;`,
   and for an index on Postgres `CREATE INDEX CONCURRENTLY` with `transaction: false` plus a plain
   `sqlFor.pglite`). Add the column to the `pages` `CREATE TABLE` in `src/schema.sql` so fresh
   installs get it, then `bun run build:schema`; both blobs follow.
2. **Add a table.** Put its `CREATE TABLE` in `src/schema.sql` and create it in a migration. If
   migrations and the blob should share one text, make it a TS fragment instead: export the SQL
   constant, import it from the migration, add a `FRAGMENTS` entry and an empty region
   (`-- BEGIN GENERATED from <path> (<CONST>). ...` / `-- END GENERATED from <path> (<CONST>)`)
   where the table belongs, then `bun run build:schema`. A Postgres-only table gets a
   `PGLITE_RULES` drop entry with its reason.
3. **When the forward-reference bootstrap changes.** Existing brains replay the blob before
   migrations run. If the blob gains an index, FK, trigger or view that references a column an
   older brain may lack, add that column's probe and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   to the forward-reference bootstrap both engines run (`src/core/engine-sql/bootstrap.ts`:
   probe, gap, DDL). A column only defined in a
   `CREATE TABLE` needs no bootstrap entry. `test/schema-bootstrap-coverage.test.ts` names any gap.

## Engine detection and access repair

Two engine-free commands answer "which engine is this brain on?" and "why can't
I reach it, and what fixes it?" — both work with the database down, which is the
point. They anchor the runtime availability loop: classified failure →
`GBRAIN_DB_ACCESS <reason>` marker → the bundled `skills/db-repair/` skill →
`gbrain db-repair`.

### `gbrain engine status [--json] [--probe] [--brain <id>]`

Reports (JSON `schema_version: 1`): the effective engine vs the config-file
engine (they can differ under a transient env URL), `db_url_source`, an
env-shadow note when a cwd-.env `DATABASE_URL` is being excluded by the
cwd-.env guard (gbrain never adopts a `DATABASE_URL` that Bun auto-loaded
from the working directory's `.env` family: `.env`, `.env.local`, and the
`.env.<NODE_ENV>` / `.env.<NODE_ENV>.local` variants for `development`,
`production` and `test`; with the precedence note when both `GBRAIN_DATABASE_URL` and
`DATABASE_URL` are set — this `DATABASE_URL` guard matches the file's VALUE; the
security-relevant `GBRAIN_*` variables get the stricter key-presence quarantine
described under "Environment variables and cwd `.env` files" in `SECURITY.md`),
redacted URLs only, and — on Postgres — a
zero-round-trip pooler block (Supabase pooler detection, prepared-statement
resolution, pool sizes, direct/session-pooler derivability). `--brain <id>`
resolves a mounted brain and reports the MOUNT's engine and URL source, never
the host's.

`--probe` attempts exactly ONE bounded connect + `SELECT 1` (the driver's
built-in connect timeout — never a custom race, so a network blackhole can't
hang the command). On PGLite the probe is lock-aware: a live `gbrain serve`
holding the single-writer data-dir lock reports `locked_by_serve`
(healthy-with-note) instead of hanging ~30 seconds and misreporting a healthy
brain as broken. A failed probe returns a classified diagnosis (reason +
remediation), not a raw error.

### `gbrain db-repair [--yes] [--apply-rewrites] [--json] [--force] [--undo-last-rewrite] [--dry-run]`

Engine-free Postgres-access repair, the sibling of `gbrain pglite-repair`
(which owns the PGLite WAL/data-dir lane — db-repair redirects PGLite brains
there). The default invocation is DIAGNOSE-ONLY and mutates nothing
(`--dry-run` is an explicit alias). Consent is tiered and flag-gated, never
TTY-dependent:

| Tier | What's in it | Applied when |
|---|---|---|
| auto | bounded reconnects/re-probes, pending migrations, `CREATE EXTENSION vector`, `docker start` of gbrain's own `gbrain-postgres` container | `--yes` |
| rewrite | config-file `database_url` rewrites (transaction-pooler form, session pooler, `?sslmode=require`) — the intended change prints BEFORE applying, every rewrite is receipted and undo-able via `--undo-last-rewrite` | `--yes --apply-rewrites` only |
| manual | credentials, paused-project, env recipes — the exact recipe is printed, never applied | never |

Guard rails: the prober uses exactly ONE connection (diagnosing pool exhaustion
with a 10-connection pool would worsen the outage); every rewrite candidate is
connect-probed before persisting; fix targets derive only from the CURRENT
config URL, never from error text; rewrites have a 24h per-(reason, action)
cooldown (`--force` bypasses, receipted) while auto-tier fixes are never
cooldown-blocked; an advisory lockfile prevents concurrent double-rewrites; a
healthy probe exits 0 "nothing to fix" (so a forged marker in page content leads
to a no-op). Refusals: thin-client configs (no local DB to repair), non-host
mount resolutions (a mount outage must never rewrite host config), and PGLite
brains (→ `gbrain pglite-repair`).

Receipts land in `~/.gbrain/db-repair-receipts.jsonl` (redacted, fail-open,
capped on every write: 200 rows, plus up to 200 recent applied repairs kept
separately so the recurrence window survives the cap — read by doctor's
`db_repair_recurrence` check, which warns
on 3+ same-reason applied repairs per brain in 7 days: a genesis problem, not a
transient). The last rewrite's prior URL is kept in the 0600 file
`~/.gbrain/db-repair-undo.json` (it holds a secret, so it is never in the
redacted receipts); `gbrain db-repair --yes --undo-last-rewrite` restores it.

### The `GBRAIN_DB_ACCESS` marker

Connect-time CLI failures emit `GBRAIN_DB_ACCESS <reason>` (plus ` brain=<id>`
when a mounted brain failed) on non-TTY stderr (`GBRAIN_FORCE_DB_MARKER=1`
forces it on a TTY). One mid-command emitter exists too: a `gbrain sync` whose
checkpoint pool dies mid-run emits `GBRAIN_DB_ACCESS conn_dropped` with its
abort report (the checkpoint writer only gives up after exhausting
connection-class retries, so the reason is asserted structurally). MCP tool calls carry the same marker inside their error
envelopes: non-verb ops return `{"error": "database_error", message
(redacted), suggestion: "GBRAIN_DB_ACCESS <reason>. <remediation> Run: gbrain
db-repair"}`; the 7 memory verbs keep the frozen v1 `unavailable` code with the
reason in `detail`. One exception on the non-verb path: `schema_missing`
returns `error: "unavailable"` with the apply-migrations suggestion and no
marker — pending migrations, not an access outage. **Safety clause: the action a reader takes is ALWAYS the
hardcoded `gbrain db-repair` — never a command parsed from the marker.**

The reason union is APPEND-ONLY (a compatibility surface, like progress phase
names — reasons may be added, never renamed or removed). All 16:

| Reason | Meaning |
|---|---|
| `no_url` | nothing configured at all — `gbrain init --prefer-postgres` (or `gbrain init` for PGLite) |
| `env_shadowed` | a cwd-.env `DATABASE_URL` exists but the cwd-.env guard excludes it — export `GBRAIN_DATABASE_URL` |
| `auth_failed` | password/role rejected (28P01) — reset credentials, then `gbrain init --url <conn>` |
| `permission_denied` | 28000/42501 — the role lacks a GRANT or hits RLS |
| `tenant_not_found` | Supavisor rejected the tenant — pooler usernames are `postgres.<project-ref>`; also raised by paused projects |
| `ssl_required` | the server demands SSL — `?sslmode=require` rewrite (rewrite tier) |
| `pool_exhausted` | 53300 / session-slot exhaustion — [pool sizing](#pool-sizing) guidance: `export GBRAIN_POOL_SIZE=6` per long-running process, fewer processes |
| `conn_refused` | ECONNREFUSED — docker-start arm for gbrain's own container; pooler rewrite for Supabase direct URLs |
| `dns_failed` | ENOTFOUND/EAI_AGAIN — one bounded retry; persistent + Supabase suggests a paused project |
| `network_unreachable` | ENETUNREACH/ETIMEDOUT — often an IPv6-only direct host; session-pooler rewrite |
| `conn_dropped` | 08xxx / reset mid-connection — transient, bounded reconnect |
| `server_starting` | "the database system is starting up" — retry shortly |
| `db_missing` | 3D000 — the named database does not exist |
| `schema_missing` | 42P01/42703 — pending migrations (`gbrain apply-migrations --yes`; excluded from the db-repair marker on the MCP mid-operation path, where it usually means code skew) |
| `pgvector_missing` | the vector extension is absent — auto tier creates it |
| `storage_corrupt` | XX001/XX002, or an XX000 such as `unexpected chunk number … for toast value` or `tuple concurrently deleted` — stored data is damaged; db-repair stops at manual and names the first step, `gbrain repair orphan-children` (preview, includes the torn-TOAST probe; [orphan children](guides/repair.md#orphan-children)) |
| `unknown` | unclassified — redacted error + `gbrain doctor` |

The classifier lives in `src/core/pg-access-classify.ts`; remediation copy has
exactly one home (that module) — db-repair, doctor, and MCP dispatch all render
its `remediation`, and skills reference the command rather than duplicating
recipe text.

### Degraded-mode serve

When Postgres is unreachable at `gbrain serve` STARTUP, serve does not die:
it boots on a lazy-reconnect engine, each tool call attempts a single reconnect
(minimum ~5s between real attempts — no connect storms), and until one succeeds
tool calls return the classified envelopes above. The call that triggers the
successful reconnect gets a retry-once error rather than a result
(`GBRAIN_RECOVERED_RETRY` — "retry this call"; its source scope was resolved
before recovery); every call after it gets full service, and MCP
`tools/list_changed` tells clients that handshook during degraded mode to
refresh their catalog. Structured
`[gbrain-serve] DEGRADED:` / `[gbrain-serve] RECOVERED:` lines land on stderr
for harness-log forensics. Kill switch: `GBRAIN_SERVE_DEGRADED=0` (or `false`)
restores die-on-startup. Scope: Postgres startup failures only — PGLite startup failures
keep die-on-startup (that lane's repair is `gbrain pglite-repair`), and
mid-session outages ride the engine's own reconnect plus the per-call
classified envelopes.

### Pool sizing

<a id="pool-sizing"></a>Each gbrain process opens its own ordinary pool of
`GBRAIN_POOL_SIZE` connections (default 10; environment variable only, no
config key). A long-running process (`gbrain serve`, `gbrain autopilot`,
`gbrain jobs work`) needs at least **6**: two for write publication, one for the
idle work probe, one each for the projection and effects workers, and one for
reads and tool calls. Below that, boot or projection draining stalls under
traffic. One-shot CLI commands can use `GBRAIN_POOL_SIZE=2`. With
`GBRAIN_POOL_SIZE=1`, schema setup and maintenance still run (`gbrain init
--db-only`, `apply-migrations`, `repair request-indexes`, `backfill`), but
managed writes need two connections: they stay queued with
`writer_pool_capacity`, so `gbrain init` without `--db-only` stops at its
packaged-skill install. Long holds keep one connection free for reads and
control work; only holds that use nothing but their own connection (migration
DDL, concurrent index builds, backfill batches) may take a single
connection.

Size the pooler for every process at once:

```
long-running processes x GBRAIN_POOL_SIZE
  + processes with GBRAIN_DIRECT_DATABASE_URL x GBRAIN_DIRECT_POOL_SIZE (default 3)
  + one-shot commands running at the same time x their pool
  <= the pooler's client limit (Supabase Supavisor: the project's pool_size)
```

When the sum does not fit, run fewer long-running processes (for example one
shared `gbrain serve --http` instead of one stdio `serve` per agent session),
or raise the pooler's limit. Do not lower a long-running process below 6.
`pool_exhausted` errors (SQLSTATE `53300`) and the
[serve boot timeout](#serve-boot-timeout) print this guidance.

<a id="serve-boot-timeout"></a>**`serve_boot_timeout`** (stderr, exit 1).
`gbrain serve` made no boot progress for `GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS`
(default 60; 0 disables), so it released the database and exited. The window
restarts at every boot phase, progress note and answered request, so a large
brain whose boot is slow but advancing is never stopped; the line also says how long the
boot had been running. The line
names the boot phase that never finished (`source_preflight`,
`writeback_config`, `mcp_connect`, `source_scope`, `persistence_consumer`,
`resolve_ipc_bind`, `startup_sweep`) and the pool pressure
(`pool=<tracked checkouts>/<pool max>`). When the pool is below 6 or saturated,
the fix is `export GBRAIN_POOL_SIZE=6` plus pooler sizing as above; otherwise
check the configured provider endpoints for the named phase, or raise the
timeout.

### Pool and transaction diagnostics

These warn lines and errors come from the Postgres engine's connection pools.
Each one names a stable code, its cause, a command and this anchor.

<a id="pg-connection-poisoned"></a>**`pg_connection_poisoned`** (warn).
A pooled connection came back to the pool inside a transaction (ReadyForQuery
status `T`) or a failed one (`E`), usually because a caller released a reserved
connection without `COMMIT` or `ROLLBACK`. The driver terminates that connection
instead of reusing it, so later statements never run inside the leftover
transaction and never fail with SQLSTATE `25P02`. Queued statements move to a
fresh connection. The line names the status byte and the pool (`read` or
`direct`) and carries no query text. `getPoolDiagnostics().poisonedDiscards`
counts discards per engine. There is no opt-out. Nothing needs to be repaired;
if the line repeats, run `gbrain doctor --json` and report the warn lines with
the operations that preceded them. A pool created with `max: 1` keeps the
driver's documented single-connection idiom (`BEGIN` as an ordinary query)
for unreserved statements.

<a id="backfill-rollback-failed"></a>**`backfill_rollback_failed`** (error).
A `gbrain backfill` batch failed, and its `ROLLBACK` failed too. The run stops
rather than retrying on a connection whose transaction state is unknown; the
driver discards that connection. Nothing from the batch was committed and the
checkpoint did not advance. The message names both errors (redacted, at most
200 characters each). Fix the cause they name, then run
`gbrain backfill <kind> --resume`.

<a id="persistence-consumer-log"></a>**`[persistence] phase=<phase> reason=<code>`**
(stderr). The resident write consumer could not finish a phase. `reason` is
the SQLSTATE (for example `53300` when a pooler's client limit is reached),
a write-error code, `storage_error`, or `deadline_exceeded` when the phase
overran its five-second budget. `message` is the redacted error text, one line,
at most 200 characters. When an unexpected exception in the owner failed a
write (`storage_error` with a generic public message; the class and frame stay owner-only),
the line also carries `class=`, `errno=` and `frame=` (the top gbrain source
frame, repo-relative, for example `src/core/persistence/page-prepare.ts:120`):
the owner diagnostics the receipt points at. The stored receipt keeps the same
identifiers (never the error message) owner-side in `error_detail`, with the
build that ran the attempt; `gbrain write-request <id>` names an owner on
another build than the CLI (`owner_build`) and the restart to run. Connection-wait evidence follows on Postgres:
`first_conn_ms` is the time from phase start until the phase obtained a
connection; `checkout=not_observed conn_wait_ms=<n>` means it had not obtained
one after `n` milliseconds (a saturated pool or pooler, not a slow query); and
`loop_lag_ms` is the longest event-loop delay during the phase (a busy or
starved process). The same fields appear in the consumer's status snapshot
under `phase`. Unfinished work stays tracked and is retried; nothing is lost. Run `gbrain sources writer status --json` to see what is waiting. The
line is rate-limited (one per second, one per phase and code every 30 seconds).
An idle consumer keeps one ordinary-pool connection for its work probe and
never holds a direct or session-pooler connection, so a
`GBRAIN_DIRECT_DATABASE_URL` that points at a session pooler is not pinned by
idle `gbrain serve` processes.

<a id="persistence-claim-phase"></a>**Claim phases.** Each claim renewal also records the claimed write's phase
(`preparing` or `publishing`); `gbrain sources writer status --json` shows it as
`claim` on running blockers, and doctor `persistence_write_stall` warns past
`persistence.max_claim_ms` (default 600000, 60000 to 86400000). See
[troubleshooting](guides/troubleshooting.md#persistence-write-stall).

## JSONB writes: never double-encode

Writing a JS value into a `jsonb` column has exactly two correct forms. Get this
wrong and the write succeeds on PGLite but stores a **jsonb string scalar** on
real Postgres — `col ->> 'k'` returns NULL, `jsonb_array_elements` throws, and a
`jsonb_typeof = 'array'` CHECK rejects the row (which aborts the sync that wrote it).

| Form | Verdict |
|---|---|
| Template tag: `` sql`... ${sql.json(obj)}` `` (postgres-engine only) | ✅ native jsonb serialization |
| Positional raw call, raw object: `executeRawJsonb(engine, sql, scalars, [obj])` | ✅ object reaches the wire as jsonb |
| engine-sql domain code: `` sqlFragment`... ${jsonbParam(obj)}` `` | ✅ bound as `sql.json` on Postgres, serialized for PGLite's native text→jsonb parse |
| Positional raw call, stringified: `executeRaw(\`... $N::text::jsonb\`, [JSON.stringify(x)])` | ✅ binds as text, the cast parses it |
| Positional raw call, BARE cast: `executeRaw(\`... $N::jsonb\`, [JSON.stringify(x)])` | ❌ **double-encodes** under postgres.js `.unsafe()` |
| Template literal interpolation: `` `... ${JSON.stringify(x)}::jsonb` `` | ❌ double-encodes |

**Why:** postgres.js `.unsafe(sql, params)` (the path behind `executeRaw` /
`executeRawDirect`) binds a JS **string** as a text param. A bare `$N::jsonb`
cast then wraps that already-JSON string into a jsonb scalar string instead of
parsing it. Casting through `$N::text::jsonb` forces a text→jsonb parse.
**PGLite's `db.query` parses text→jsonb natively, so it hides the bug** — which is
why the bug only shows up on Postgres (and why the parity test must run there).

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
3. If the engine speaks the Postgres dialect, add a dialect adapter that
   implements `SqlExecutor` (`src/core/engine-sql/executor.ts`) beside
   `dialect-pglite.ts` and `dialect-postgres.ts`, expose it through a private
   `engineSql` getter over the current connection, and delegate every method
   of a migrated domain to `src/core/engine-sql/<domain>.ts` the way both
   engines do. Declare its capabilities honestly. The binding matrix
   (`test/helpers/executor-binding-matrix.ts`) and the engine-sql contract
   tests tell you whether the adapter binds, counts, fails and cancels like the
   others. A non-SQL engine implements every method itself.
4. Store engine type in `~/.gbrain/config.json`: `{ "engine": "myengine", ... }`
5. Add tests. The test suite should be engine-agnostic where possible... same test cases, different engine constructor.
6. Document in this file + add a design doc in `docs/`

### What you DON'T need to touch

- `src/cli.ts` (dispatches to engine, doesn't know which one)
- `src/mcp/server.ts` (same)
- `src/core/chunkers/*` (shared across engines)
- `src/core/embedding.ts` (shared across engines)
- `src/core/search/hybrid.ts` + `hybrid/`, `expansion.ts`, `dedup.ts` (shared, operate on SearchResult[])
- `src/core/engine-sql/<domain>.ts` (shared domain SQL, when your engine has a Postgres-dialect adapter)
- `skills/*` (fat markdown, engine-agnostic)

### What you DO need to implement

Every method in `BrainEngine`. The full interface. No optional methods, no feature flags. If your engine can't do vector search (e.g., a pure-text engine), implement `searchVector` to return `[]` and document the limitation.

## Capability matrix

| Capability | PostgresEngine | PGLiteEngine | Notes |
|-----------|---------------|-------------|-------|
| CRUD | Full | Full | Same SQL |
| Keyword search | tsvector + ts_rank | tsvector + ts_rank | Identical (real Postgres) |
| Vector search | pgvector HNSW | pgvector HNSW | Same operators; bounded fallback/cancellation differs |
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

Note: there is no SQLite engine. PGLite uses the same SQL as Postgres, so no separate SQLite dialect with FTS5/sqlite-vss translation is needed.
