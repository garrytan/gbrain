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
- Recursive CTEs for graph traversal (breadth-first, each page visited once)
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

On Postgres the same refresh also analyzes the page columns every search
filter reads (`deleted_at`, `source_id`, `type`, `slug`) and
`content_chunks(model, modality, page_id, body_generation)`, and an embed drain that embedded
anything analyzes those chunk columns once at its end (each ANALYZE bounded by
a 30 s statement and 2 s lock timeout). Without those statistics the vector
candidate statement sorts every eligible chunk instead of walking the HNSW
index, and at 1M chunks and above that sort runs past the 8 s vector budget,
so hybrid search falls back to keyword-only results until autovacuum
analyzes the tables. If a refresh is skipped (a lock, or a role that does not
own the tables), run `ANALYZE content_chunks(model, modality, page_id, body_generation)` and
`ANALYZE pages` as the table owner.

### TLS for Postgres connections

Every Postgres connection gbrain opens to a host that is **not on this
machine** requires TLS unless the database URL says otherwise. On this
machine means `localhost`, `127.0.0.0/8`, `::1` or a Unix socket path;
everything else needs TLS, including private addresses (`10.x`,
`192.168.x`) and Docker service names such as `postgres-1`, because gbrain
cannot tell a trusted network from an untrusted one by its name.
(`src/core/pg-tls.ts` is the one resolver every connection pool uses.)

| URL says | What gbrain does |
|---|---|
| no `sslmode`, host on this machine | plaintext, as before |
| no `sslmode`, any other host | `sslmode=require` |
| `?sslmode=require` | encrypts the connection; does **not** verify the server certificate |
| `?sslmode=verify-full` | encrypts and verifies the certificate and host name against the CA store |
| `?sslmode=disable` | plaintext; the one opt-out, for a network you trust |

An sslmode (or `ssl=`, or `sslrootcert=system`) in the URL is always
honored and never weakened, and so is the driver's own `PGSSL` variable.

`require` stops anyone on the network from reading the traffic, but it would
not notice an attacker who sits in the middle and presents their own
certificate. For that, use `verify-full`. It checks the server certificate
against Node's CA store, so a provider with its own CA needs that CA added:
Supabase publishes it under **Project Settings → Database → SSL
Configuration → Download certificate**. Put the file on the brain host and set
`NODE_EXTRA_CA_CERTS=/path/to/prod-ca-2021.crt` in the environment gbrain
runs in (for the installed service, `~/.gbrain/env`), then use
`?sslmode=verify-full`. A `sslrootcert=<file>` parameter is not read by the
driver; use `NODE_EXTRA_CA_CERTS` instead.

A server that does not accept TLS fails the connection with
[`postgres_tls_required`](guides/error-codes.md#postgres_tls_required),
which names both choices: turn TLS on at the server, or add
`sslmode=disable` to the URL. Nothing falls back to plaintext on its own.
`gbrain doctor --only postgres_tls` reports whether this machine's own
connection to a non-local server uses TLS. It judges that from the client side:
`sslmode=require`, `verify-ca` and `verify-full` make the driver refuse a
server without TLS. It warns on `sslmode=disable`, and on `sslmode=prefer` when
the server does not offer TLS or reports the session unencrypted (prefer falls
back to plaintext without saying so, so doctor never certifies a prefer
connection as encrypted). Behind a
pooler, the server's `pg_stat_ssl` row describes the pooler's own hop to the
database, which can't be checked from your machine, so doctor shows it as detail
and never warns about it. PGLite opens no network connection, so none of this
applies to it.

### Vector index sizing

The chunk HNSW index stores each vector beside its graph links, so at 1,024
dimensions it takes about 7.6 GiB per million chunks as `vector` (about
9.8 GiB for a 1.28M-chunk brain) and a third of that as `halfvec`. The
deferred ANN build (`gbrain migrate embeddings`, `gbrain reindex --vectors`)
runs `CREATE INDEX CONCURRENTLY` with the server's `maintenance_work_mem`.
When the graph does not fit, pgvector logs `hnsw graph no longer fits into
maintenance_work_mem` and the build slows several-fold: 4.3x at 250k chunks
with 256 MB. Before a large build, raise it on the brain host to the index
size plus about 10% (Supabase: `supabase postgres-config update --config
maintenance_work_mem=12GB --project-ref <ref> --experimental`, which reloads
without a restart; self-hosted: `ALTER SYSTEM SET maintenance_work_mem =
'12GB'` and `SELECT pg_reload_conf()`), and give it
`max_parallel_maintenance_workers` of about half the cores: a 1M-chunk build
took 103 s on 16 vCPU with 12 GB and 8 workers. Measured, not shipped:
`halfvec` gives the same recall with an index a third the size, and
`ef_construction` 128 adds about 0.02 to 0.03 unfiltered recall@10 for about
25% more build time. Both need a migration or a rebuild, so the defaults stay
(m 16, ef_construction 64, `vector`). Measurements and method:
[`docs/eval/hnsw-scale-bench.md`](eval/hnsw-scale-bench.md).

### Vector index prewarm

<a id="vector-index-prewarm"></a>

After a Postgres restart or a cache eviction, the first searches walk HNSW
pages nobody has read yet: on a brain whose index is bigger than the cache,
an unseen query reads 2,000 to 4,500 index pages and spends 1.2 to 2.7 s in
the vector stage. `gbrain embeddings prewarm` loads every HNSW index of the
brain into `shared_buffers` once with `pg_prewarm(<index>, 'buffer')`, so
those pages are already cached. It is opt-in and local to the brain host: a
CLI-only command (no MCP tool, refused by thin clients), and
`gbrain config set serve.vector_prewarm true` runs it once in the
background each time `gbrain serve` starts (off by default; a refusal is
logged and the serve carries on).

`shared_buffers` decides whether it runs. The indexes must total at most
half of it, read with `current_setting('shared_buffers')`; past that the
prewarm would evict the heap and keyword-index pages every other read needs.
`effective_cache_size` is printed but never decides: it is a planner hint
the operator sets, not memory the server holds. The check reads only catalog
rows and file sizes, so a refusal reads no index page.

| Command | Does |
|---|---|
| `gbrain embeddings prewarm --dry-run --json` | Index sizes, `shared_buffers`, `effective_cache_size`, the budget and the fit; reads nothing |
| `gbrain embeddings prewarm` | Prewarms when the indexes fit and `pg_prewarm` exists |
| `gbrain config set serve.vector_prewarm true` | Prewarms at each serve start (restart the serve) |

Refusals, each with a fix: `vector_prewarm_wont_fit` (raise
`shared_buffers` to at least twice the index size and restart Postgres; a
managed database sizes it with the instance), `vector_prewarm_extension_missing`
(`CREATE EXTENSION IF NOT EXISTS pg_prewarm;` as a role that may create
extensions) and `vector_prewarm_unsupported_engine` (PGLite has no server
cache to fill). Prewarmed pages stay cached until Postgres restarts or other
reads evict them; pg_prewarm's own `autoprewarm` worker
(`shared_preload_libraries = 'pg_prewarm'`) can reload them after a restart
without gbrain.

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

**Segmented page tables.** A page over 1 MiB stored in segments (`pages.segmented_storage`)
keeps its text in `page_segment_texts`, its layout and headings in
`page_body_manifest`, uploads in progress in `page_body_stagings` /
`page_body_staging_parts` (with the segment texts each one holds in
`page_body_staging_texts`), view sizes in `page_view_digests`, and per-segment
derivation results (link candidates, window anchors) in `page_segment_derivations`,
with each page's derivation spend in `page_derivation_spend` and derivation purges
in progress in `page_segment_derivation_purges` / `page_segment_derivation_purge_pages`.
gbrain enables RLS on all ten on every schema replay, as it does on `pages` and
`content_chunks`, so with no policy a role that does not bypass RLS reads no row
of them. Title search, the source-scoped vector scan, the chunk windows search
reads around its hits, `get_chunks` and get_page check a chunk of a page stored
in segments against `page_body_manifest`. A restricted read role that can see
such a chunk (a segmented page of one of its sources) needs `SELECT` on it;
without it those reads fail with `permission_denied` (42501). A role that sees
no such chunk, as every role does while no page is segmented
(`pages.segmented_storage` is off by default), reads as before without the
grant (`test/e2e/segmented-switch-off-rls.test.ts`). Grant it together with
these policies, never with an open one, or the role reads every source's segment
text. A scoped role then sees exactly the segment rows of its sources:

<!-- gbrain:segmented-rls-recipe:begin (applied verbatim by test/e2e/segmented-rls-scope.test.ts) -->
```sql
-- The pages_scope_filter predicate, on each table's own source_id.
CREATE POLICY page_segment_texts_scope_filter ON page_segment_texts
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY page_body_manifest_scope_filter ON page_body_manifest
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY page_body_stagings_scope_filter ON page_body_stagings
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
-- A write role records the texts each staging holds here; without a policy its
-- segmented writes are refused.
CREATE POLICY page_body_staging_texts_scope_filter ON page_body_staging_texts
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
-- Search joins sources; a scoped role sees its own.
CREATE POLICY sources_scope_filter ON sources
  USING (current_setting('app.scopes', true) = '*'
         OR id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
-- No source_id of their own: visible exactly when their staging or page is
-- (the pages policy filters the subquery). content_chunks holds every page's
-- chunk text, segmented or not.
CREATE POLICY page_body_staging_parts_scope_filter ON page_body_staging_parts
  USING (current_setting('app.scopes', true) = '*'
         OR EXISTS (SELECT 1 FROM page_body_stagings s WHERE s.id = staging_id));
CREATE POLICY page_view_digests_scope_filter ON page_view_digests
  USING (current_setting('app.scopes', true) = '*'
         OR EXISTS (SELECT 1 FROM pages p WHERE p.id = page_id));
CREATE POLICY page_segment_derivations_scope_filter ON page_segment_derivations
  USING (current_setting('app.scopes', true) = '*'
         OR EXISTS (SELECT 1 FROM pages p WHERE p.id = page_id));
CREATE POLICY content_chunks_scope_filter ON content_chunks
  USING (current_setting('app.scopes', true) = '*'
         OR EXISTS (SELECT 1 FROM pages p WHERE p.id = page_id));
-- A write role books segmented derivation spend and records derivation purges
-- here; without a policy those writes are refused.
CREATE POLICY page_derivation_spend_scope_filter ON page_derivation_spend
  USING (current_setting('app.scopes', true) = '*'
         OR EXISTS (SELECT 1 FROM pages p WHERE p.id = page_id));
CREATE POLICY page_segment_derivation_purges_scope_filter ON page_segment_derivation_purges
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY page_segment_derivation_purge_pages_scope_filter ON page_segment_derivation_purge_pages
  USING (current_setting('app.scopes', true) = '*'
         OR EXISTS (SELECT 1 FROM page_segment_derivation_purges r WHERE r.request_id = page_segment_derivation_purge_pages.request_id));

-- A read role that searches and reads pages. The other tables it reads
-- (config, timeline_entries, facts, ...) need policies of their own.
GRANT SELECT ON pages, content_chunks, page_body_manifest, page_segment_texts,
  page_view_digests, sources TO <reader-role>;

-- If the runtime role OWNS these tables, as for pages:
ALTER TABLE page_segment_texts FORCE ROW LEVEL SECURITY;
ALTER TABLE page_body_manifest FORCE ROW LEVEL SECURITY;
ALTER TABLE page_body_stagings FORCE ROW LEVEL SECURITY;
ALTER TABLE page_body_staging_parts FORCE ROW LEVEL SECURITY;
ALTER TABLE page_body_staging_texts FORCE ROW LEVEL SECURITY;
ALTER TABLE page_view_digests FORCE ROW LEVEL SECURITY;
ALTER TABLE page_segment_derivations FORCE ROW LEVEL SECURITY;
ALTER TABLE page_derivation_spend FORCE ROW LEVEL SECURITY;
ALTER TABLE page_segment_derivation_purges FORCE ROW LEVEL SECURITY;
ALTER TABLE page_segment_derivation_purge_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE content_chunks FORCE ROW LEVEL SECURITY;
```
<!-- gbrain:segmented-rls-recipe:end -->

A role whose reads do not run through the scoped helper is scoped by its own
default (`ALTER ROLE <reader-role> SET app.scopes = 'source-a,source-b'`). The
policies read `app.scopes` only; the app-layer source filters stay layer 1.

A write role that does not own the tables needs `SELECT, INSERT, UPDATE, DELETE`
on all ten, as on any table a migration adds, even while no page is segmented:
purging soft-deleted pages, fact withdrawal (`forget_fact`, `purge_fact`), the
maintenance sweep's facts pass, doctor's credential check and the segment
storage sweep name them. Its ordinary writes (`put_page`, `remember`, sync
imports, their embedding and the unchanged-file check) do not, while it sees no
segmented chunk (`test/e2e/segmented-switch-off-write-role.test.ts`). With the
policies above it creates segmented pages and sees only its sources' rows
(`test/e2e/segmented-rls-scope.test.ts`).

<a id="purge-and-withdrawal-guards"></a>
**Purge and withdrawal guards.** The guards that refuse purged content and keep withdrawn
facts withdrawn run as the writing role (`SECURITY INVOKER`) and read their ledgers
(`fact_purges`, `fact_withdrawals`, `take_purges`, `page_purges` and the derivation purge
tables) under that role's RLS. Since migration v318 (#7632, #7659) they fail closed: when
RLS applies to the writing role on a ledger and no permissive policy of the role covers it,
the guard refuses the write with `writer_coordinator_required: writer state is unreadable to
this database role` (P0001, relationship `unreadable_state`), whose `HINT` names the table
and the policy to add, instead of reading the ledger as empty and letting a purged claim,
take, page or derivation, or a withdrawn fact, through. The refused writes are fact inserts
and claim updates, fact re-activations, take writes, page content writes, segment derivation
writes, and page soft-deletes or segment retirements while the derivation purge tables are
unreadable. The owner (without `FORCE ROW LEVEL SECURITY`), a role that bypasses RLS, a
ledger without RLS and PGLite are not affected. A scoped write role needs these policies, on
top of the maintainer recipe below for `pages` and `sources`; they let it read only the
ledger rows of the sources it writes and change none:

<!-- gbrain:ledger-rls-recipe:begin (applied verbatim by test/guard-ledgers-fail-closed-7632.test.ts) -->
```sql
-- The ledgers of the writer's own sources, with the pages_scope_filter predicate.
CREATE POLICY fact_purges_writer_scope ON fact_purges FOR SELECT TO <writer-role>
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY fact_withdrawals_writer_scope ON fact_withdrawals FOR SELECT TO <writer-role>
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY take_purges_writer_scope ON take_purges FOR SELECT TO <writer-role>
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY page_purges_writer_scope ON page_purges FOR SELECT TO <writer-role>
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY page_segment_derivation_purges_writer_scope ON page_segment_derivation_purges FOR SELECT TO <writer-role>
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
-- The note a page leaving a running derivation sweep's scope leaves for that sweep.
CREATE POLICY page_segment_derivation_purge_pages_writer_note ON page_segment_derivation_purge_pages FOR INSERT TO <writer-role>
  WITH CHECK (EXISTS (SELECT 1 FROM page_segment_derivation_purges r
                      WHERE r.request_id = page_segment_derivation_purge_pages.request_id));
```
<!-- gbrain:ledger-rls-recipe:end -->

The segmented storage recipe above already covers the two derivation purge tables for a
role it applies to. A policy that filters out ledger rows of a source the role writes hides
them from the guard, as before. Every gbrain function that pins a search_path ends it with
`pg_temp` (migration v277, #7632), so a session's temp table or view named like a ledger
cannot hide it from a guard; before, any session, the owner included, could store purged
content that way. Each definition outside
`src/core/schema-migrations/` pins `pg_catalog, public, pg_temp` itself (`bun run check:search-path`
fails one that does not, or a pinned function missing from `PINNED_FUNCTION_NAMES`), so a schema
replay keeps it; historical migration bodies still pin the old path, so every migration run ends by
putting `pg_temp` back (`hardenFunctionSearchPaths` in `src/core/function-search-path.ts`), and the
schema blob's generated hardening region must stay its last statement. Where the migrating role
does not own a function, the run that applies migrations names it on stderr and leaves it;
`gbrain doctor` (`function_search_path`) prints the schema-qualified `ALTER FUNCTION` to run as its
owner, or `gbrain apply-migrations --yes` below v277 ([function search path](guides/troubleshooting.md#function-search-path);
`test/e2e/function-search-path-postgres.test.ts`).

<a id="writer-protocol-fences"></a>
**Writer-protocol fences.** The managed-writer guard, the persistence protocol floor, protocol
activation and the Git-canonical source counter also run as the writing role and read their state
under its RLS. Since migration v278 (#7636) they fail closed: a role that cannot see the
`persistence_brain` row is refused on every guarded write, managed brain or not, instead of being
treated as unmanaged. The message is `writer_coordinator_required: writer state is unreadable to
this database role`: the managed-writer guard raises it as P0001, the request, effect and
activation guards of the persistence protocol as SQLSTATE 42501. During a coordinated write's
publication either one is stored on the receipt as `writer_coordinator_required` (relationship
`unreadable_state`, the role remedy, and the owner-only `error_detail.state` naming the table; since
#7777 for the protocol guards, #7780 for the state and remedy). A protocol guard's
refusal outside publication (write admission, protocol activation) reaches the command as that
database error, which gbrain's generic database output labels `permission_denied` with grant
advice: the code at the start of the message names the refusal. On a managed brain the same refusal covers, for a writer without the git protocol, a
hidden `git_canonical_brain` row and, while the brain has any Git-canonical source, a hidden
target or old source row whether or not that source is Git-canonical; and a hidden page row behind a tag,
timeline entry or take. Protocol activation (row-level security on `sources`, `persistence_requests`,
`persistence_effects`, `persistence_worktrees` or `persistence_source_bindings`) and a change to
which sources are Git-canonical (row-level security on `sources`) refuse any role it applies to,
whatever its policies; only the table owner (without `FORCE ROW LEVEL SECURITY`) or a role that
bypasses RLS passes them ([write refusals](guides/write-refusals.md#writer-coordinator-required);
`test/writer-fence-fail-closed-7636.test.ts`).

<a id="derived-state-maintainers"></a>**Derived-state maintainers.** Eight triggers keep derived state as the writing role:
deleting a page removes its `page_retrievals` rows, soft-deleting or moving it clears its
`extract_atoms_page_state` rows, a tag write moves its page's revision, a `page_versions` row copies the page's
trust tier and writer, a page update re-indexes its `timeline_entries` text, a page write queues or drops its
`page_projection_jobs` row (reading `sources`), and a trust-relevant change bumps `trust_policy_state`. Since
migration v281 (#7637) each refuses with `writer_coordinator_required` (relationship `unreadable_state`, the error
names the table) when row-level security applies to the role on a table it needs and no permissive policy for the role
covers a command it runs there. Before, such a role kept stale derived state (a deleted page's retrieval rows stayed)
or failed with a raw RLS error. The owner (without `FORCE ROW LEVEL SECURITY`) and a role that bypasses RLS are not
affected. The guest-source guard in the trust trigger and guest admission read `guest_sources` the same way: since
migration v314 a role that row-level security keeps from reading it is refused (`writer_coordinator_required`,
`unreadable_state`, state `guest_sources`) on every page, fact, take and timeline write, because it cannot tell a guest
source from an ordinary one. A scoped write role that does not own these tables needs these policies; the maintainer tables hold ids,
timestamps and counters but no page text, so the writer sees every row, and a policy that filters them would leave the
rows it hides stale:

<!-- gbrain:maintainer-rls-recipe:begin (applied verbatim by test/derived-state-maintainers-7637.test.ts) -->
```sql
-- The writer's own pages and sources, with the pages_scope_filter predicate.
-- Tag writes update the page revision; version rows and the projection queue
-- read the page and its source.
CREATE POLICY pages_writer_scope ON pages FOR ALL TO <writer-role>
  USING (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')))
  WITH CHECK (current_setting('app.scopes', true) = '*'
         OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
CREATE POLICY sources_writer_scope ON sources FOR SELECT TO <writer-role>
  USING (current_setting('app.scopes', true) = '*'
         OR id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
-- The timeline text a page update indexes: the entries of pages the writer sees.
CREATE POLICY timeline_entries_writer_scope ON timeline_entries FOR SELECT TO <writer-role>
  USING (EXISTS (SELECT 1 FROM pages p WHERE p.id = page_id));
-- Derived state with no page text: every row, so a deleted page's rows go too.
CREATE POLICY page_retrievals_writer ON page_retrievals FOR ALL TO <writer-role>
  USING (true) WITH CHECK (true);
CREATE POLICY extract_atoms_page_state_writer ON extract_atoms_page_state FOR ALL TO <writer-role>
  USING (true) WITH CHECK (true);
CREATE POLICY page_projection_jobs_writer ON page_projection_jobs FOR ALL TO <writer-role>
  USING (true) WITH CHECK (true);
CREATE POLICY trust_policy_state_writer ON trust_policy_state FOR ALL TO <writer-role>
  USING (true) WITH CHECK (true);
-- Which sources are guest sources and who writes them: every row, read only.
CREATE POLICY guest_sources_writer ON guest_sources FOR SELECT TO <writer-role>
  USING (true);
```
<!-- gbrain:maintainer-rls-recipe:end -->

<a id="folder-access-tables"></a>**Folder access tables.** A page write stamps the folder rules covering its slug
from `access_policy_state` and `access_rules`, and remote reads hide the prefixes listed in
`access_pending_coverage`, all as the database role doing the write or read. A role that row-level security keeps
from reading those tables never reads them as "no rule": the stamp refuses the write with
`writer_coordinator_required` (relationship `unreadable_state`, naming the table), and reads treat every page as
under a pending prefix, so nothing is shown. The owner (without `FORCE ROW LEVEL SECURITY`) and a role that
bypasses RLS are not affected, and `gbrain access` rule commands refuse such a role with `permission_denied`. A scoped
role that writes or serves pages needs these policies; they let it read the rules and lock a source's policy row while
stamping, but not change either. Row-level security does not cover TRUNCATE or triggers, so the recipe also revokes
those. A policy that filters these rows hides rules from the role and so reveals the pages under them: keep `USING (true)`. The folder-rule lineage test also reads `slug_rename_history` (every slug a renamed page has had), which renames write; a role that cannot read it reads every page as covered, so a scoped role needs a `USING (true)` policy there like the other tables it writes. The recipe for the three access tables:

<!-- gbrain:access-rls-recipe:begin (applied verbatim by test/access-folder-scoped-role.test.ts) -->
```sql
CREATE POLICY access_policy_state_reader ON access_policy_state FOR SELECT TO <writer-role> USING (true);
CREATE POLICY access_policy_state_stamp_lock ON access_policy_state FOR UPDATE TO <writer-role>
  USING (true) WITH CHECK (false);
CREATE POLICY access_rules_reader ON access_rules FOR SELECT TO <writer-role> USING (true);
CREATE POLICY access_pending_coverage_reader ON access_pending_coverage FOR SELECT TO <writer-role> USING (true);
REVOKE TRUNCATE, TRIGGER, REFERENCES ON access_policy_state, access_rules, access_pending_coverage FROM <writer-role>;
```
<!-- gbrain:access-rls-recipe:end -->

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