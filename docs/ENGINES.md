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

<a id="owner-only-delete-triggers"></a>
**Owner-only delete triggers.** Rows derived from an owner-only source (an `imessage` source, or
one with `owner_only: true`) stay owner-only after their origin is gone. Since migration v322
(GST-3032) a `BEFORE DELETE` trigger on `sources`, `pages`, `facts`, `takes` and
`timeline_entries` records the deleted row and every row derived from it in `owner_only_marks`,
and reads treat a marked row, or one derived from a marked row, as owner-only. Nothing derived
is deleted. A take or timeline row counts as owner-only by its own lineage as well as its page's.
The first owner-only source (or mark) sets a one-way flag, a comment on `owner_only_marks`;
from then on the guard stays on even after the last owner-only source is removed. A brain that
never held owner-only data never reads `owner_only_marks`, so its logins need no new grant.
The triggers run as the deleting role. A role whose reads row-level security limits (a scoped
writer, or `FORCE ROW LEVEL SECURITY` on a table it owns) could miss derived rows: its delete
of a row it sees as owner-only is refused with `owner_only_lineage_unreadable` (delete it as
the table owner without `FORCE`, or as a `BYPASSRLS` login, and the derived rows are marked),
and its delete of a row it sees as open goes through but sets the `('*', 'row_security')`
mark, which closes owner-only lineage the way a missing trigger does. `CREATE TRIGGER` needs the table's owner: a table another role owns gets
no trigger, the migration run and `gbrain doctor` (`owner_only_marks_triggers`) name it with
`ALTER TABLE ... OWNER TO`, and `gbrain apply-migrations --force-schema` run by its owner
creates it. While a trigger is missing or disabled on a brain that holds an owner-only source or
a mark, owner-only lineage reads closed: every row with a recorded derivation input and every
synthesized concept or question counts as owner-only. It stays closed after the triggers are
back (a delete in the gap left no marks) until the owner, having checked what was deleted in
the gap, deletes the `('*', 'unguarded')` row by hand; the closed mode itself never adds a mark.

A scoped writer that keeps making permanent deletes (the recipe above) keeps owner-only lineage
closed: while a login whose reads row-level security limits makes permanent deletes on a brain
that holds owner-only data, every derived row and synthesized concept stays owner-only for
everyone but the owner. Deleting the `('*', 'row_security')` row does not end it, because that
login's next permanent delete sets it again. The ways out are to run permanent deletes as the
table owner (without `FORCE`) or a `BYPASSRLS` login, or to stop holding owner-only data:
remove the owner-only source and, once the rows derived from it may be read by others again,
its marks.

<a id="owner-only-marks-privileges"></a>**Privileges on `owner_only_marks`.** The table follows
the sibling pattern: row-level security on and no policy, so a role with only table privileges
(Supabase's `anon` and `authenticated`) neither reads nor adds a mark. No migration grants
anything. On a brain that has held owner-only data, every non-owner login that reads `sources`
needs `SELECT` (to read owner-only lineage exactly) and, if it makes permanent deletes,
`INSERT` on `owner_only_marks`, each with a permissive policy in the shape below (`USING (true)`,
and `WITH CHECK (true)` to add) and no restrictive policy that applies to it; any other policy
counts as none. Without them the login reads
owner-only lineage closed, never open and never an error, and its permanent deletes are
refused with `owner_only_marks_unwritable`, which names the grant. Nobody but the owner
removes a mark, and only the owner of `owner_only_marks` sets the flag, so the first
owner-only source is added by that role. `gbrain doctor` (`owner_only_marks_triggers`) names
each login that still needs the statements and prints them; the owner runs:

<!-- gbrain:owner-only-marks-recipe:begin (applied verbatim by test/e2e/owner-only-marks-scoped-login.test.ts) -->
```sql
-- A login that reads and makes permanent deletes (the writer role above):
GRANT SELECT, INSERT ON owner_only_marks TO <writer-role>;
CREATE POLICY owner_only_marks_read_<writer-role> ON owner_only_marks FOR SELECT TO <writer-role> USING (true);
CREATE POLICY owner_only_marks_add_<writer-role> ON owner_only_marks FOR INSERT TO <writer-role> WITH CHECK (true);
-- A read-only login (the reader role above) needs the read half only:
GRANT SELECT ON owner_only_marks TO <reader-role>;
CREATE POLICY owner_only_marks_read_<reader-role> ON owner_only_marks FOR SELECT TO <reader-role> USING (true);
```
<!-- gbrain:owner-only-marks-recipe:end -->

Owner-only lineage is read exactly only by a login whose reads of the lineage tables (`sources`,
`facts`, `derivation_inputs`, `links`, `pages`, `takes`, `timeline_entries`) are complete: the
table owner without `FORCE`, a `BYPASSRLS` login, or a login with a permissive `USING (true)`
policy and no restrictive one on each. On a brain that has held owner-only data any other login
reads it closed, never open and never an error: every row with a recorded derivation input,
every synthesized concept or question, every row in an owner-only source and every page or
fact whose source row the login cannot read counts as owner-only for it. So the scoped writer above, whose `pages` and `sources` policies read
`app.scopes`, sees every derived row as owner-only. A login that cannot read `derivation_inputs`
in full (the reader role above has no grant on it) sees every row as owner-only, also after the
last owner-only source is removed.

**Who must act.** Nobody has to: such a login reads closed, so owner-only data stays hidden
from it and nothing errors. An operator who runs a scoped login (the writer or reader role
above) on a brain that has held owner-only data, and wants that login to read derived rows
exactly again, so that a row derived only from open rows reads as open, gives it complete reads
of each lineage table `gbrain doctor` names for it (`owner_only_marks_triggers`, details
`closed_logins` and `lineage_sql`). As the table owner, for each named table:

```sql
GRANT SELECT ON public.<table> TO <login>;
DROP POLICY IF EXISTS gbrain_lineage_read_<login> ON public.<table>;
CREATE POLICY gbrain_lineage_read_<login> ON public.<table> FOR SELECT TO <login> USING (true);
```

Then drop any restrictive policy on those tables that applies to the login. This gives the
login every row of those tables, so it undoes the source scoping its own policies give it. That
trade is the operator's to make: no migration grants anything or adds a policy.

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

A bulk fact insert (the fence import in `src/core/engine-sql/facts.ts`) defers the withdrawal
stamp to the end of its statement, so when one of its rows matches a withdrawal the guard
updates that row in `facts`, and the write role then needs a permissive `UPDATE` policy on
`facts` covering the row, beside its `SELECT` policy, or the guard refuses the insert with the
same `writer_coordinator_required` error.

**Check that the upgrade replaced every guard.** Migrations v318 and v321 can only replace a guard
function the role running them owns. A guard owned by another role is left as it was, and each
migration only names it in one stderr line. Left by v318, it still lets a scoped writer without
ledger policies through (`guards: N purge or withdrawal guard(s) still read their ledgers as empty ...`).
Left by v321, a facts guard still lacks the name-tag rule, so a claim forgotten or
purged under another subject can come back on a name tag (`guards: N purge or withdrawal guard(s)
keep their body from before name keys ...`). After upgrading, run this as any role that can read
the catalog. Every one of the seven rows must show `fails_closed = t`:

```sql
SELECT p.proname, pg_get_userbyid(p.proowner) AS owner,
       strpos(p.prosrc, 'row_security_active(') > 0 AS fails_closed
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('gbrain_guard_inserted_facts',
  'gbrain_preserve_fact_withdrawal', 'gbrain_refuse_purged_fact', 'gbrain_refuse_purged_take',
  'gbrain_refuse_purged_page', 'gbrain_refuse_purging_derivation', 'gbrain_mark_derivation_scope_entry')
ORDER BY 1;
```

For a row with `fails_closed = f`, connect as the role in its `owner` column and run
`ALTER FUNCTION public.<proname>() OWNER TO <the role gbrain migrates as>;`. Then run
`gbrain apply-migrations --yes`, or start gbrain: every migration run re-creates a guard that
is missing its check or its current body, provided the migrating role owns it. You can also run
gbrain once as the owning role instead. Run the query again to confirm. The query sees only the
ledger check, so a facts guard v321 left still shows `fails_closed = t`. On Postgres, `gbrain doctor`
(`guard_ledger_checks`) runs the same check, also checks the current body of the three facts guards
(`unbacked_page` in `gbrain_refuse_purged_fact`, `memory/scope` in `gbrain_preserve_fact_withdrawal`
and `gbrain_guard_inserted_facts`), and names each guard left behind with its owner, and the fix:
`gbrain apply-migrations --yes` when the doctor's role may re-create it, else the
`ALTER FUNCTION ... OWNER TO` SQL to run as the owning role first.

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

### PGLite vector index ceiling

PGLite runs Postgres inside WebAssembly, and pglite.wasm caps its memory at
2 GiB. pgvector holds the whole HNSW graph in `maintenance_work_mem` while it
builds, about 4.7 KB per 1,024-dimension chunk (1.16 GB at 250k chunks).
gbrain starts PGLite with `max_parallel_maintenance_workers=0` (PGLite has no
worker processes, and a planned parallel build reserved all of
`maintenance_work_mem` up front) and `max_wal_size=8GB` (a build WAL-logs its
whole index in one statement, and WAL past the automatic checkpoint trigger
wedges PGLite). The deferred ANN build (`gbrain migrate embeddings`) and
`gbrain reindex --vectors` size `maintenance_work_mem` to the graph
(`withHnswBuildMemory` in `src/core/vector-index.ts`): a 248,802-chunk build
takes about 11 minutes and a 1.9 GB index. A graph past the 1.5 GiB budget,
about 300k chunks at 1,024 dimensions, is refused before the build with
`pglite_vector_index_too_large`; vector search keeps working with exact scans,
and the fix is the read-only `gbrain migrate --to postgres --plan --json`.

The ceiling is counted in chunks, not pages, and a page can hold anywhere from
one chunk to dozens: one 50,000-page brain held 248,802 chunks, another 53,324
pages held 375,000. Past the budget the build does not just run slowly, it
never finishes: building the same index over those 375,000 chunks with
`maintenance_work_mem` set by hand to 1 GB (PGLite 0.4.3) had not finished after
10.8 hours, and with 2 GB after 8.8 hours, while 75,000 chunks took 70 seconds
and 15,000 took 14. So plan the move to Postgres + pgvector before a PGLite
brain reaches about 200,000 chunks at 1,024 dimensions (roughly 30,000 pages
of ordinary notes). `gbrain doctor` checks this in `pglite_scale`, at any page
count: it warns once the index needs 65% of the build budget (about 200k
1,024-dimension chunks) and again, saying the index cannot be built, past it;
both warnings carry the read-only move plan as their fix.

**When to use PGLite vs Postgres:**

| Factor | PGLite | PostgresEngine + Supabase |
|--------|--------|--------------------------|
| Setup | `gbrain init` (zero-config) | Account + connection string |
| Scale | Good for < 1,000 files | Production-proven at 10K+ |
| Vector index | Builds in minutes up to about 250k chunks; refused past about 300k (1,024 dimensions) | No PGLite memory ceiling |
| Multi-device | Single machine only | Any device via remote MCP |
| Cost | Free | Supabase Pro ($25/mo) |
| Concurrency | Single process | Connection pooling |
| Backups | Manual (file copy) | Managed by Supabase |
| Largest page | 128 MiB, stored in segments (`pages.max_bytes`) | 256 MiB, stored in segments (`pages.max_bytes`) |

**The belief ledger lives only in the database.** `belief_events` and its side tables record what the brain had recorded, and when (`gbrain beliefs status`). Markdown carries only current state, so a rebuild from Markdown, `gbrain reinit-pglite` or a dropped database starts an empty history; back up the database itself. After restoring a Postgres (or PGLite) backup, replay the purges made after the backup was taken: until then content purged later is readable again, and `gbrain doctor --only belief_ledger_coverage` reports a restore whose purge replay was partial, unavailable or unverified. Graduation copies the ledger verbatim (equal event keys and digests); the legacy copier refuses a brain that has one.

**Migration:** on a PGLite brain, `gbrain migrate --to postgres` (alias `--to supabase`) graduates the brain to Postgres. Without `--yes` it prints the plan and exits 3; `--yes --expect <plan_hash>` runs it. Graduation drains pending writes, copies every table verbatim with its primary keys (pages, facts, takes, versions, links, timeline, embeddings, transcripts and paid caches, request history and withdrawals, token and OAuth rows) into a fenced target, verifies row counts and digests, runs `gbrain doctor` on the target, and only then flips routing. It works for brains with write history and for managed brains. The PGLite data dir is retained as `<path>.graduated-<run_id>` and a tombstone file takes its place. Walkthrough, recovery by error code, rollback and what stays on this computer: [Move a PGLite brain to Postgres](guides/move-to-postgres.md).

**Say to your agent:** *"Upgrade my brain to Postgres. Show me the plan first."*

The legacy copier handles every other direction: `gbrain migrate --to pglite`, PGLite to Postgres when `gbrain config set migrate.graduation false` opts out of graduation, and history-free brains on Windows. It re-creates pages through `putPage` (chunks, embeddings, links, tags, timeline, facts) and copies config rows minus the engine-local denylist (`MIGRATE_CONFIG_ENGINE_LOCAL_KEYS`: the target-owned `engine`/`version` connection + schema ledger and the physical embedding-column registry keys); skipped keys are printed, never silent, and the run ends with a per-table copied-count summary. It forwards the full page row (origin path, kind, provenance, `ingested_at`, aliases, chunk code metadata). Pages the source had sealed are rebuilt on the target before the config flip, without an embedding key, keeping chunk ids and vectors whose input matches. A failed rebuild blocks the flip: the run exits 1 with no error code, prints `The active engine was NOT switched` and the failing pages, and leaves the source engine active; fix them (`gbrain projections drain` on the target) and re-run `gbrain migrate` to resume. Pages the source had not sealed arrive queued, with their verbatim chunks. It does not carry request IDs, withdrawals, attribution or ownership, so it refuses a managed brain and any brain with durable write history, fact withdrawals or canonical worktree ownership (rows in `persistence_requests`, `fact_withdrawals` or `persistence_worktrees`), and a brain with a belief ledger (rows in `belief_events`), which it names.

<a id="engine-migration-refused"></a>**Engine migration refused (`writer_coordinator_required`).** The legacy copier's refusal is an agent-contract envelope whose `fix` names the refusing side; every branch verifies with the read-only `gbrain doctor --no-migrate --json`, and nothing has changed in either datastore:

| Refusing side | `fix.next` | Next step |
|---|---|---|
| A PGLite brain with history (or a managed one) moving to Postgres with graduation turned off | `ask_user` (consent `egress`) | Relay `user_message`: turn graduation back on (`fix.argv`: `gbrain config unset migrate.graduation`) and preview the move with the read-only plan (`fix.then`: `gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --plan --json`, then the [two-command flow](guides/move-to-postgres.md#move-the-brain)), or keep it on PGLite and share it through `gbrain mcp expose`. |
| A Postgres brain moving to PGLite | `report` | The brain stays on Postgres; moving down would drop its history. |
| A target that already holds persistence history | `tell_user_to_run` | Rerun with an empty database the user provides (`--path` for a PGLite target). |

A brain with page versions but no write history gets the same refusal with `reason: page_history` and the number of versions in the message: the legacy copier re-creates pages without their versions, so the copy would discard them. Graduation (PGLite to Postgres) carries them.

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

<a id="pglite-live-serve"></a>
### PGLite while `gbrain serve` runs (`pglite_busy` reason `live_serve`)

One gbrain process opens a PGLite brain at a time. While `gbrain serve` (stdio
or `--http`) holds it, page and fact writes from the CLI (`gbrain put`,
`gbrain remember`) and everyday reads (`gbrain find`, `list`, `search`, `query`,
`get`, `tags`, `links`, `backlinks`, `timeline`, `history`, `graph`, `whois`,
`entity`, `search-exact` and `gbrain waiting`) go through the
running server and print what they print with no server running. A read run
with a read-affecting `GBRAIN_*` variable or provider key the server does not
share stays with the refusal below. Edits to `config.json` reach the server's
answers only after the server restarts. Commands
that need the database to themselves, which includes the admin commands
(`gbrain access …`, `gbrain sources …`, `gbrain auth …`) and the remaining reads,
refuse with `pglite_busy` reason `live_serve`. The refusal names the server's
PID, and its fix is two steps: stop that server, then run the command again.
Never remove the lock of a server that is still running.

On a brain that serves one person this is a short pause: quit the agent
session (a stdio serve) or stop `gbrain serve --http`, run the command, and
start it again. On a brain that serves several people over
`gbrain serve --http`, every member's connection drops while the server is
stopped, for every admin step. Move such a brain to Postgres, where the server
and the admin commands run side by side: preview with the read-only
`gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --plan --json`,
then follow [Move a PGLite brain to Postgres](guides/move-to-postgres.md). The
move carries members, tokens, `readable_by` and facts across.
`gbrain setup <harness> --serves several` on PGLite says this in its
`engine` line.

<a id="legacy-pglite-lock"></a>
### Legacy PGLite lock (`pglite_busy` reason `legacy_owner_unverified`)

A PGLite brain is owned through the stable sibling kernel lock
`<data-dir>.gbrain-owner.lock`. Brains last opened by an older gbrain may
still hold that release's lock folder, `<data-dir>/.gbrain-lock/`. The first
open by a current gbrain removes it automatically only when it can prove the
old owner is dead: readable metadata with a PID that `kill -0` reports gone
and, on Linux, the same PID namespace and boot id as this process. A live
owner keeps the ordinary `pglite_busy` refusal.

When the folder's metadata is torn or missing, records no PID, or (Linux) does
not prove the PID ran in this namespace since the last boot, waiting never
helps, so the open refuses `pglite_busy` with reason
`legacy_owner_unverified` (class consent, exit 3, not retryable). Its fix
asks the user and starts with the read-only preview; `gbrain doctor` shows
the same reason and fix on its `connection` check.

1. **Preview.** `gbrain pglite-repair --legacy-lock --dry-run --json [--path <dir>]`
   never opens the engine and never creates anything. It names the recorded
   PID, whether `kill -0` says it is running and its command, the processes
   an open-file scan of `/proc` (Linux) saw holding files under the data dir,
   and the filesystem type (Linux `statfs`, macOS `df -P` and `mount`), and prints the `plan_hash` and
   the apply command. This evidence is advisory: it covers only this host and
   PID namespace and cannot see other containers or other hosts that share the
   folder.
2. **Apply, after the user agrees.**
   `gbrain pglite-repair --legacy-lock --path <dir> --yes --expect <plan_hash>`
   takes the kernel lock (so no current gbrain can be running), inspects
   again under it and refuses `legacy_lock_removal_refused` while a process
   on this host holds the data dir or the recorded PID runs a command that
   could be gbrain (`live_holder`), or when the data dir is on a network or
   shared filesystem such as NFS, SMB, 9p, virtiofs or FUSE
   (`network_filesystem`), or when it cannot confirm the filesystem is local
   (`filesystem_unverified`: Linux reads `statfs`; macOS reads the mount
   point from `df -P` and its `mount` line, and counts it local only with
   the `local` flag and a local type such as apfs or hfs. Other systems, a
   failed probe, an unrecognised type, a macOS network mount such as smbfs or
   nfs, and a macOS mount without the `local` flag all refuse). A lock that changed since the preview refuses `preview_changed`.
   It inspects again after consent, so a holder or change that appears while
   the prompt waits refuses the same way. Otherwise it moves the folder into
   `<data-dir>.legacy-lock-removed-<timestamp>/` (nothing is deleted) with a
   `receipt.json` and the exact restore command (it also puts back the prior
   `<data-dir>.gbrain-owner.json` bytes, kept as `prior-owner-marker.json`,
   or removes the new marker when there was none), writes the kernel-v1 marker
   `<data-dir>.gbrain-owner.json`, and starts the 10-minute WAL-repair
   quarantine (`<data-dir>.lock-reap.json`). The next ordinary open succeeds.

## Opening an engine from settings (experimental)

`openEngine(settings)` (`src/core/engine-open.ts`, exported as `gbrain/engine-open`) creates and connects an engine
from one value, for a host that embeds several brains in one process or keeps its settings somewhere other than
`~/.gbrain`. It is off by default and refuses unless `settings.embedded_core === true` (`embedded_core_required`).
The CLI, `gbrain serve` and mounts never call it and behave exactly as before.

```ts
import { openEngine } from 'gbrain/engine-open';

const engine = await openEngine({
  embedded_core: true,
  engine: 'postgres',
  database: { url, directUrl },        // PGLite: { path }, or none for an in-memory brain
  pool: { max: 4 },                    // this engine's own pool (default 4), never the db.ts singleton
  host: { id: hostId },                // required UUID: the persistence host identity
  writer: { id, credential, lane: 'stdio' },
  embedding: { model: 'voyage:voyage-4', dimensions: 1024 },
  ai: { providers: { voyage: { apiKey } }, models: { chat } },
});
await engine.initSchema();             // the host migrates; a connect never does
await engine.disconnect();
```

What the settings decide, with nothing read from a config file, an environment variable, the home directory or the
working directory:

- **Connection.** The direct (DDL/session) pool uses only
  `database.directUrl`, or the route a known pooler URL derives; `GBRAIN_DIRECT_DATABASE_URL` is never consulted.
  Each URL must be one single-host URL naming its host, user and database (`engine_settings_invalid` otherwise).
  Both pools pass every connection field to the driver (port 5432 when unnamed; no password when the URL has none),
  so no `PG*` variable picks the server or credentials. The statement-description cache stays in the process
  instead of `<home>/cache/pg-types` unless a CLI-path pool to the same database shares the process. PGLite skips the
  `GBRAIN_PGLITE_SNAPSHOT` fast path.
- **Host identity.** `hostIdFor(engine)` (`src/core/persistence/identity.ts`) answers `host.id` for the engine and
  everything sharing its `engineKey`; every host-id read in `src/core` goes through it (two CLI-only sites
  excepted), and for any other engine it is `localHostId()`. No `host.json` is read or minted; no id refuses
  `engine_host_missing`. The consumer heartbeat records `embedded:<host-id>`, read as identity given at open.
- **Writer.** An unauthenticated write uses `settings.writer` for its lane (a remote call needs a `stdio` writer, a
  local one `cli`), registered in `persistence_local_writers` on first use with the default read/write ceiling. An
  existing registration keeps its own ceiling, another credential or lane under the id refuses `permission_denied`,
  and a revoked one is never replaced. Engines that make their first write at the same moment register the writer once;
  a credential already registered under another id refuses `permission_denied`. No `<brain>.<lane>.json` file is read or minted; with no writer for the lane
  the write refuses `writer_registration_required`.
- **Embedding identity.** `initSchema()` seeds a fresh brain from `settings.embedding` (else the built-in default),
  never from the process gateway, and refuses `engine_embedding_mismatch` on a database that records another model
  or width.
- **AI gateway.** Embed, chat, expansion and rerank calls use only `settings.ai` (`providers`: id to
  `{ apiKey, baseUrl }`; `models`: chat, expansion, reranker) and `settings.embedding`, never a `process.env`
  key, the config file or the process gateway. An unnamed provider refuses `engine_scope_missing` and nothing is
  sent. Operations, persistence consumers, minion jobs, `POST /mcp`, `hybridSearch` and the import paths enter
  their engine's scope; wrap any other direct call in `withEngineScope(engine, fn)`. With an embedded engine open,
  a call in no scope refuses `engine_scope_required`; `withLocalScope(fn)` (the CLI, serve and jobs enter it) uses
  the process gateway. Batch shrink, no-key and structured-output memory, usage rows and the alias policy are per
  engine. Query embeddings are cached per engine until close, unless `cache_namespace` (a host's name for
  one tenant database) keeps them warm; a new key starts cold.
- **Read back.** `embeddedSettings(engine)` returns a frozen copy with no secrets.
- **Close.** `disconnect()` closes the engine for good and drops its settings, even while a reconnect is in flight
  (any pool that reconnect builds is ended). A later `connect()` or `reconnect()` refuses `engine_closed`; call
  `openEngine` again instead.
- **Files.** File ops use `settings.storage` (local, or s3 with an endpoint) and its key `prefix`.

Still process-wide: CLI file storage, transcription, the AI call log and timeouts, `GBRAIN_*` tuning variables (pool lifetime,
connect and session timeouts, `GBRAIN_PREPARE`, `GBRAIN_DIRECT_POOL_SIZE`, `GBRAIN_DISABLE_DIRECT_POOL`,
`GBRAIN_RLS_SCOPE_BINDING`, the PGLite close watchdog), `PG*` TLS and tuning
variables, the connection-events audit log, and operation-level
config reads (content-sanity screening, schema-pack resolution, the embedding switch on publication). None of them
picks an engine's database, host identity, writer, embedding identity or AI keys. A source with a git checkout keeps its native coordination lock under the
process's persistence home.

### Upgrading an embedded host

- Unscoped AI calls refuse `engine_scope_required` even after `configureGateway`; wrap them as above.
- `openEngine` refuses an unknown settings key, top-level or nested (`engine_settings_invalid` names it).
- `examples/embedded-two-brains.ts` is a two-brain host on package exports only: `bun examples/embedded-two-brains.ts`.

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
   probe, gap, DDL). A partial index's `WHERE` predicate and `INCLUDE` list count as references (an
   index filtering on a column a later migration adds wedges the replay). A column only defined in a
   `CREATE TABLE` needs no bootstrap entry. `test/schema-bootstrap-coverage.test.ts` names any gap.
   The schema-history upgrade tests (`test/schema-history-upgrade.slow.test.ts` on PGLite,
   `test/e2e/schema-history-upgrade.test.ts` on Postgres) upgrade a stored fresh brain of each release
   from schema v260 on (`test/fixtures/schema-history/`, written by
   `scripts/capture-schema-history-fixture.ts`) and compare the result with a fresh install.

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

A probe that reaches the brain also prints `brain_ref` (JSON `probe.brain_ref`, human line `Ref:`): a 16-character
one-way digest of the brain's persistence identity (`persistence_brain.brain_id`), which a reviewed policy uses to
name one brain, such as the engine swap's dated readiness override. The digest cannot be turned back into the
identity, and the command never prints the identity itself. While `gbrain serve` holds a PGLite brain, the probe
reads the reference that serve recorded at start and after each reconnect (`<data dir>.gbrain-brain-ref.json`, 0600, holding the reference and
a digest of the serve's lock token, never the identity); a file another lock holder wrote is refused
(`brain_ref_note: serve_brain_ref_stale`). Other notes, with `brain_ref: null`: `no_persistence_identity`,
`brain_ref_unreadable`, `locked_by_other_process`, `serve_brain_ref_missing` (a serve from before this field).

**Say to your agent:** *"Give me my brain's brain_ref from gbrain engine status, not its id."*

On a Rust brain the report names `rust` as the engine and the probe is typed. It checks the addon first and reports
`rust_engine_addon_missing`, `rust_engine_addon_mismatch` or `engine_capability_missing` as a `refusal` (code, reason,
message), not as a database diagnosis. A `database_path` with no `records.redb` (a missing path or an empty directory)
probes as `data_dir_missing`, and a `records.redb` that is empty or has no `FORMAT` file beside it (a first open
that stopped early, or a lost `FORMAT`) as `store_incomplete`;
the probe creates nothing in either case. Otherwise it opens the store and reads one config key, since the Rust
engine serves no `SELECT 1`.

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
marker — pending migrations, not an access outage. A second: `storage_interrupted`
keeps the `database_error` envelope and the marker but drops the `Run: gbrain
db-repair` tail and names the database host's operator (`fix.actor: host_admin`),
because db-repair's connection probe reports healthy during that host storage
fault. **Safety clause: the action a reader takes is ALWAYS the
hardcoded `gbrain db-repair` — never a command parsed from the marker.**

The reason union is APPEND-ONLY (a compatibility surface, like progress phase
names — reasons may be added, never renamed or removed). All 19:

| Reason | Meaning |
|---|---|
| `no_url` | nothing configured at all — `gbrain init --prefer-postgres` (or `gbrain init` for PGLite) |
| `env_shadowed` | a cwd-.env `DATABASE_URL` exists but the cwd-.env guard excludes it — export `GBRAIN_DATABASE_URL` |
| `auth_failed` | password/role rejected (28P01) — reset credentials, then `gbrain init --url <conn>` |
| `permission_denied` | 28000/42501 — the role lacks a GRANT or hits RLS; a 42501 whose message starts with a writer code (`writer_coordinator_required:`, `writer_upgrade_required:`, `writer_not_quiesced:`, `unsupported_mutation_protocol:`) is a persistence protocol guard's refusal ([write refusals](guides/write-refusals.md#protocol-guard)) |
| `tenant_not_found` | Supavisor rejected the tenant — pooler usernames are `postgres.<project-ref>`; also raised by paused projects |
| `ssl_required` | the server demands SSL — `?sslmode=require` rewrite (rewrite tier) |
| `pool_exhausted` | 53300 / session-slot exhaustion — [pool sizing](#pool-sizing) guidance: `export GBRAIN_POOL_SIZE=6` per long-running process, fewer processes |
| `conn_refused` | ECONNREFUSED — docker-start arm for gbrain's own container; pooler rewrite for Supabase direct URLs |
| `dns_failed` | ENOTFOUND/EAI_AGAIN — one bounded retry; persistent on a Supabase direct host suggests a paused project, while on a Supabase pooler URL it points at this machine's DNS and network (the shared pooler host resolves whatever a project's state) |
| `network_unreachable` | ENETUNREACH/ETIMEDOUT — often an IPv6-only direct host; session-pooler rewrite |
| `conn_dropped` | 08xxx / reset mid-connection — transient, bounded reconnect |
| `server_starting` | "the database system is starting up" — retry shortly |
| `db_missing` | 3D000 — the named database does not exist |
| `schema_missing` | 42P01/42703 — pending migrations (`gbrain apply-migrations --yes`; excluded from the db-repair marker on the MCP mid-operation path, where it usually means code skew) |
| `pgvector_missing` | the vector extension is absent — auto tier creates it |
| `storage_corrupt` | XX001/XX002, or an XX000 such as `unexpected chunk number … for toast value` or `tuple concurrently deleted` — stored data is damaged; db-repair stops at manual and names the first step, `gbrain repair orphan-children` (preview, includes the torn-TOAST probe; [orphan children](guides/repair.md#orphan-children)) |
| `storage_interrupted` | XX000 `could not open file …` / `could not read block … in file …` ending `Interrupted system call` — PostgreSQL's read of a data file was interrupted (EINTR) on the host; not damaged data, so no repair is offered; db-repair stops at manual: check the host's storage and PostgreSQL log, then the original job or write receipt before resubmitting |
| `tls_required_default` | `postgres_tls_required`: gbrain's TLS default met a non-local server without TLS — db-repair stops at manual; turn TLS on at the server or add `sslmode=disable` ([TLS](#tls-for-postgres-connections)) |
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
  + processes whose direct route lands on this pooler x their direct pool (see below)
  + one-shot commands running at the same time x their pool (a full `gbrain sync` is one too)
  + parallel import workers x 2 (an unmanaged sync of more than 100 files, `--workers N`, or the sync a serve runs)
  <= the pooler's client limit (Supabase Supavisor: the project's pool_size)
```

The direct route lands on the pooler when `GBRAIN_DIRECT_DATABASE_URL` names it,
and also when gbrain derives it from a Supabase pooler URL whose user does not
name the project (`postgres.<ref>`): the derived route keeps the pooler host on
port 5432, its session port, even when the main URL uses transaction mode
(6543). Two long-running processes at the
defaults (10 + 3 each) already pass a client limit of 25, so a scheduled
`gbrain sync` next to a `gbrain serve` on the same session port can exhaust it.
`GBRAIN_MAX_CONNECTIONS` caps a sync's worker fan-out to fit a budget.

<a id="direct-pool-by-command"></a>The direct pool's size follows the command.
`gbrain serve`, `gbrain jobs`, `gbrain autopilot` and `gbrain sync --watch`
open up to 3 direct connections. A command that exits but owns writes or takes
a lease (`sync`, `put`, `import`, `dream`, `cycle`, `sources`, `mcp`,
`migrate-graduation`) and the diagnostics that report the route (`doctor`,
`engine`) open 1. Every other command routes nothing through the direct pool:
its statements use the ordinary pool, as with `GBRAIN_DISABLE_DIRECT_POOL=1`.
Two exceptions keep the direct route for it: applying pending schema
migrations (one connection, for the session advisory lock and the 30-minute
statement timeout), and taking a lease such as an embed or extract lock
(the command then opens 1, so the lease heartbeat keeps its own connection).
`GBRAIN_DIRECT_POOL_SIZE` still sets the size wherever a direct pool opens.
`GBRAIN_DIRECT_POOL_BY_COMMAND=0` restores the earlier behavior: every command
may open the full 3-connection direct pool.

When the sum does not fit, run fewer long-running processes (for example one
shared `gbrain serve --http` instead of one stdio `serve` per agent session),
or raise the pooler's limit. Do not lower a long-running process below 6.

`gbrain doctor` check `session_lane_budget` (read-only) counts this role's
connections in `pg_stat_activity` across every process, by process kind
(`serve`, `sync`, `jobs`, … from the `gbrain <kind>:<pid>:<nonce>`
connection name) and host, and warns at 80% of the limit with the kinds
holding the most. Postgres cannot read a pooler's per-role limit, so behind a
Supabase pooler set `GBRAIN_SESSION_LANE_LIMIT` to the project's `pool_size`;
without it the check reports the counts only. Without a pooler the limit is
`max_connections` less the reserved slots. Behind a pooler the count is an
upper bound: connections that bypass it (a direct `db.<ref>` host) count too,
and a transaction pooler's server connections carry its own name, so they are
counted apart, not attributed to a process.

With a direct route configured, the persistence consumer's own tick
statements (idle probe, switch read, recovery and expired-claim scans,
capacity marking) take the direct pool beside the claims, renewals and the
heartbeat, so a transaction-mode pooler never sits between the owner and its
bookkeeping (#6317; `gbrain sources writer status --json` shows
`connection.lane: direct`). `GBRAIN_CONSUMER_DIRECT_LANE=0` keeps those scans
on the ordinary pool when the direct pool is too small for them.
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

<a id="schema-lock-blocked"></a>**`schema_lock_blocked`** (error, retryable).
A schema step waited its `lock_timeout` for a table lock another session holds
and stopped instead of hanging (#5227). `gbrain init` and `upgrade` replay
`schema.sql` on the reserved DDL backend; every `ALTER TABLE` there takes an
ACCESS EXCLUSIVE lock even as a no-op, so one open transaction in another
client (idle in transaction, a stuck job) used to park the whole command in
`wait_event_type=Lock` with no output. The replay runs under a session-level
`lock_timeout` on that backend (`GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS`, default
60; the value found before is restored on release, so a pooled backend never
leaks it), a transaction-wrapped migration binds the same wait with
`SET LOCAL lock_timeout`, and a `transaction: false` migration sets and
restores it on its own reserved backend. Handler migrations and the
post-migration `verifySchema` run outside the bound: they issue their own
statements (`CREATE INDEX CONCURRENTLY` cannot run in a transaction) and stay
as they were. While the wait is active a separate one-backend connection
samples `pg_blocking_pids()` of the waiting backend once, so the refusal names
the blocking sessions by pid, `application_name`, state and transaction age;
after the cancel the blocker may already be gone, and the message says when the
sample came late. Query text is never read or shown. `detail` names the step
(`replay`, `migration v<N>`). The RLS block skips tables whose
`relrowsecurity` is already set, so a re-run on a live brain no longer takes
ACCESS EXCLUSIVE on them. `init` retries a blocked step a few times with a
short backoff (`init-schema-retry.ts`); a lock that never clears is a bounded
failure, not a hang. Fix: let the named session finish or, with the user's
agreement, end it on the database host with `SELECT pg_terminate_backend(<pid>)`,
then rerun the same command. Test: `test/e2e/init-schema-lock-blocked.test.ts`.

<a id="pg-connection-stuck"></a>**`pg_connection_stuck`** (warn). A pooled
statement ran past its in-flight budget, either with nothing coming back from
the server (`reason=idle`) or while bytes kept arriving (`reason=age`, #6543),
so the vendored driver retired that connection:
the statement and every statement queued behind it failed with the driver error
`CONNECTION_STUCK`, the connection left the pool before its socket closed, and
the pool reconnected on its own (#6383). Usually only a wedged connection
reaches the budget: a pipeline the client and server no longer agree on, a
transaction-mode pooler that swallowed a `CancelRequest` and left the backend
in `ClientRead`, or a dead peer. It is not proof: behind a transaction-mode
pooler (port 6543) the startup `statement_timeout` never reaches the backend
(`SHOW statement_timeout` reads `0`; `/health?deep=1` reports it as
`transport.session_timeouts_not_applied`), so a legitimately slow statement can
reach the budget too (#6543). The budget is the pool's own startup `statement_timeout` (5 min on
the read pool, 30 min on the direct pool, `GBRAIN_STATEMENT_TIMEOUT` for the
read pool) plus `GBRAIN_PG_STUCK_GRACE_MS` (default `30000`); it follows the
configured timeout even through a pooler that drops the startup parameter, and
`GBRAIN_PG_STUCK_GRACE_MS=0` or `off` disables the watchdog. Two clocks run
against it: the idle clock restarts on every byte the server sends, the age
clock never does, so a statement that keeps streaming rows or notices past the
budget is retired too. The budget is derived per statement and travels with the
operation: a statement after a `SET [LOCAL] statement_timeout` or
`set_config('statement_timeout', …)` on its connection (inside a transaction,
on a reserved connection, or in the same simple query) gets
`max(budget, that timeout + grace)`, and a declared `0` (an index build, a bulk
copy) has no cap. The driver reads the declaration from the statements it
sends, so it holds behind a transaction-mode pooler that never applies a
session `SET`; a transaction's `SET LOCAL` ends with it, `RESET` restores the
pool's budget. An operation that must run longer declares its own timeout that
way; `GBRAIN_STATEMENT_TIMEOUT` raises it for every read-pool statement. The
line names the pool, `reason`, `age_ms`, `budget_ms` (that statement's own
cap), `queued` (statements that failed with it) and the statement by first
keyword and table (`sql=SELECT_pages`), never its text or parameters. `getPoolDiagnostics().stuckDiscards` counts retirements per
engine; `/health?deep=1` reports them as `stuck_discards`. Retry the failed
call; if the line repeats, run `gbrain doctor --json` and report the warn lines
with the operations that preceded them.

<a id="pg-connection-desync"></a>**`pg_connection_desync`** (warn). A statement's
answer (columns, rows, a completion, a parse or bind acknowledgement, or a
statement error) arrived on a pooled connection with no statement waiting for
it, so the client and the server no longer agreed on which answer belonged to
which statement. The vendored driver retired that connection, statements
queued on it failed with a connection error, and the pool reconnected on its
own. The line names the pool, the message type, the driver's connection id and
the last statement written on it by first keyword and table, never its text or
parameters. Notices, notifications and parameter changes never trigger it.
`getPoolDiagnostics().desyncDiscards` counts retirements per engine;
`/health?deep=1` reports them as `desync_discards`.

<a id="pg-connection-recovery-failed"></a>**`pg_connection_recovery_failed`**
(warn). A connection the driver retired after an incident (stuck, desynced, or
closed under running statements, for example by `pg_terminate_backend` or a
pooler reap) could not reconnect; statements waiting for it failed with the
connect error, and the next statement retries. The line names the pool, the
driver's connection id, the incident (`cause=stuck|desync|closed`) and the
error code. `getPoolDiagnostics()` counts reconnects of retired connections as
`recovered` and failures as `recoveryFailed`; `/health?deep=1` reports them as
`recovered` and `recovery_failed` (#6543). A resident `gbrain serve` writes its
stuck, desync and recovery events to the pool-recovery audit
(`~/.gbrain/audit/pool-recovery-YYYY-Www.jsonl`), so
`gbrain doctor --only pool_reap_health` fails on a recovery failure and warns
on a stuck or desynced connection in the last hour.
Retry the failed call; if the line repeats, run `gbrain doctor --json` and
report the warn lines.

<a id="pg-statement-build-failed"></a>**`pg_statement_build_failed`** (warn). A
statement could not be built from its parameters (`error=UNDEFINED_VALUE`: a
parameter was `undefined`; `error=MAX_PARAMETERS_EXCEEDED`: more than 65534
parameters). It was answered in its place in the pipeline by a query the server
refuses, so only it failed and a transaction it was part of was aborted rather
than committed without it. Before #6383 the same failure, when the statement was
pipelined behind another on its connection, rejected that other statement with
its error, left the culprit queued with nothing on the wire, and delivered every
later reply one statement late until the process restarted (the
`null is not an object (evaluating 'query.statement.types')` line and a backend
stuck `active / ClientRead` were that desync). The line names the pool and the
statement by first keyword and table, and an `UNDEFINED_VALUE` line names the
parameter (`param=$2`, or `param=?` for an array element). Behind a
transaction-mode pooler (port 6543, `?prepare=false`) a build failure usually
means a misrouted answer: the statement bound a value read from a row that
belonged to another statement, so earlier reads on that pool are suspect too.
Check `/health?deep=1` `transport.max_pipeline` (gbrain sends `0` there since
v0.60.187.0; `PGMAX_PIPELINE=0` forces it) and audit the window with
[the pooler misroute audit](guides/pooler-misroute-audit.md). Elsewhere the
call site that bound `undefined` is a gbrain bug, so report the line.
`getPoolDiagnostics().buildFailures` counts them.

<a id="pg-pool-stalled"></a>**`pg_pool_stalled`** (warn, resident processes).
`gbrain serve` reads its pool every 30 s; when connections are checked out or
statements are waiting for one across two ticks in a row and the pool completed
no statement in between, it logs this line once per tick with `checked_out`,
`max`, `waiters`, `inflight_oldest_ms` and `stalled_ms`, and one
`[gbrain] info code=pg_pool_recovered` line when statements complete again.
One slow statement is one quiet tick and is never reported. With the in-flight
watchdog on, a stall ends within `statement_timeout` plus grace and
`pg_connection_stuck` names the connection; with the watchdog off this line is
the only trace a wedged pool leaves. A line that keeps repeating with no
recovery means the database or pooler is unreachable from the process:
`gbrain doctor --json` from a fresh process, then restart the stalled one.

<a id="serve-deep-health"></a>**`/health?deep=1`** (`gbrain serve --http`). Plain `/health` stays the fast
liveness probe, and it runs its `SELECT 1` on a reserved connection, which the
driver only ever claims from idle connections; a wedged connection sits in the
busy queue where handler statements are routed, so `/health` answered 200
through the whole #6383 incident. `/health?deep=1` runs `SELECT 1` through the
ordinary pooled dispatch (no reservation, 3 s budget) and answers 503 when the
probe does not return in time, when a pooled statement is past its own
in-flight budget (the same per-statement budget the watchdog retires at, so a
transaction that declared a longer `statement_timeout` is measured against it;
the block's `inflight_over_budget_ms`), or when an earlier deep probe is still pending (one
deep probe per engine at a time). Its body carries the pool block:
`{ checked_out, max, waiters, inflight_oldest_ms, completed, poisoned_discards,
stuck_discards, build_failures, desync_discards, recovered, recovery_failed }`. It is cheap enough for a two-minute cron. The
same pool numbers ride the persistence consumer's heartbeat row, so
`gbrain sources writer status --json` shows `pool.inflight_oldest_ms` for the
owner process.

Every 503 body carries a stable `code` with `fix` and `docs` from the error
registry (#6543):

- `persistence_restart_required`: this serve's persistence consumer reports
  `restart_required` (an abandoned preparation or a publication past its
  deadline), so it claims no write until the process restarts. Restart serve.
- `pool_inflight_over_budget`: a pooled statement has run past its own
  in-flight budget without being retired (the watchdog is off, or the serve
  runs a driver without per-statement budgets). Restart serve; behind a transaction-mode pooler read
  `transport` first and set `PGMAX_PIPELINE=0` if `max_pipeline` is not `0`.
  No request id or statement text reaches either body: the endpoint is
  unauthenticated.
- `deep_health_probe_failed` with `reason` `pending`, `timeout` or `error`: the
  pooled `SELECT 1` did not answer. Retry; if it persists, `gbrain doctor --json`.

Both 200 and 503 bodies carry `transport`, read once at startup through the
read pool and logged as a `[gbrain serve] transport` line:
`{ pooler_mode, prepare, max_pipeline, max_pipeline_reason, statement_timeout,
session_timeouts_not_applied, fix?, application_name? }`. `prepare` and
`max_pipeline` are the live pool's options; `max_pipeline_reason` says why
(`transaction_pooler_port`, `url_prepare_false`, `gbrain_prepare_off`,
`url_max_pipeline`, `env_pgmax_pipeline` or `default`): gbrain builds the read
pools with `max_pipeline: 0` for a transaction-mode URL (port 6543 or
`?prepare=false`) or `GBRAIN_PREPARE=0` since v0.60.187.0, and a URL
`?max_pipeline=` or a non-empty `PGMAX_PIPELINE` always wins.
PgBouncer in transaction mode carries pipelined statements correctly, so a
PgBouncer deployment on port 6543 or with `?prepare=false` can opt back in with
`?max_pipeline=100`: on a 3-connection pool with 8 concurrent workers at about
40 ms round trip, pipelining off measured about 37% fewer statements per second
(1185 vs 1890 in 30 s); at localhost latency there was no measurable cost. Do
not opt back in behind Supavisor.
`application_name: "Supavisor"` appears when the backend names Supavisor.
`session_timeouts_not_applied: true` means gbrain configured a
`statement_timeout` but it reads `0` through the pool (a transaction-mode
pooler drops startup parameters), so no server-side timeout bounds an
autocommit statement; `fix` is the same `ALTER ROLE` the
doctor's `persistence_session_timeouts` check prints
([troubleshooting](guides/troubleshooting.md#session-timeouts-not-applied)).
The endpoint is unauthenticated, so it only reports: it never retires a
connection or restarts anything.

<a id="serve-unhealthy-exit"></a>To let a supervisor recover a wedged serve
without a human, set `GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS=<n>` (off by default;
`n` must be a whole number of at least `120`, and a smaller value refuses to
start with `invalid_params`). When `persistence_restart_required` has held
continuously for `n` seconds (read in-process; the hold restarts whenever the
stuck work settles and the flag clears), serve logs
`[gbrain serve] error code=serve_unhealthy_exit cause=persistence_restart_required`,
disconnects under a 5 s deadline (the consumer's stop waits on the stuck work,
so the exit never depends on it draining) and exits `69`.
`pool_inflight_over_budget` never triggers the exit (the variable is named for
its one trigger): restart serve yourself or from your health check. A loop
guard records each self-exit in `serve-self-exit.json` under the gbrain home;
after 3 self-exits within an hour serve stops exiting, logs
`serve_self_exit_suppressed`, and the deep-health 503 carries
`self_exit_suppressed: true` with a fix that asks for a manual restart and a
look at `gbrain sources writer status --json`.
The service `gbrain mcp expose` installs restarts it (systemd `Restart=always`,
launchd `KeepAlive`), so a fresh serve comes up; the floor keeps a restart loop
under the systemd unit's start limit (10 starts per 300 s). For the installed service put the variable
in `~/.gbrain/env`; for a foreground serve set it in the shell or your own
supervisor's environment. A foreground serve with no supervisor just exits.

<a id="backfill-rollback-failed"></a>**`backfill_rollback_failed`** (error).
A `gbrain backfill` batch failed, and its `ROLLBACK` failed too. The run stops
rather than retrying on a connection whose transaction state is unknown; the
driver discards that connection. Nothing from the batch was committed and the
checkpoint did not advance. The message names both errors (redacted, at most
200 characters each). Fix the cause they name, then run
`gbrain backfill <kind> --resume`.

<a id="backfill-commit-indeterminate"></a>**`backfill_commit_indeterminate`** (error).
A `gbrain backfill` batch sent its `COMMIT` and got no verdict from the
server (for example the connection dropped), so the batch may or may not have
committed. The run stops without bisecting or skipping anything, and the
checkpoint stays before the batch. Run `gbrain backfill <kind> --resume`:
rows that did commit no longer match the backfill and are not redone.

<a id="backfill-skipped-rows"></a>**Skipped backfill rows.** A row whose compute
or UPDATE fails on its own (a CHECK or type violation, a compute error) is
isolated by splitting its batch, each part in its own transaction, and recorded
in the config key `backfill.<kind>.skipped`; the checkpoint moves past it and
the other rows land. `gbrain backfill <kind>` prints each recorded row with
its code and the retry command, and every later run retries it first. A row
that fails with the same content error on 3 consecutive runs (same row, same
gbrain version) is held: it is reported but not retried until the row or the
gbrain version changes; `gbrain backfill <kind> --fresh` retries it now. When
most rows of a run fail, the run stops with `item_failures_systemic` and keeps
the skip record and checkpoint it began with.

<a id="persistence-consumer-log"></a>**`[persistence] phase=<phase> reason=<code>`**
(stderr). The resident write consumer could not finish a phase. `reason` is
the SQLSTATE (for example `53300` when a pooler's client limit is reached),
a write-error code, `storage_error`, or `deadline_exceeded` when the phase
overran its five-second budget. `message` is the redacted error text, one line,
at most 200 characters. When an unexpected exception in the owner failed a
write (`storage_error` with a generic public message; the class and frame stay owner-only),
the line also carries `class=`, `errno=` and `frame=` (the top gbrain source
frame, repo-relative, for example `src/core/persistence/page-prepare.ts:120`):
the owner diagnostics the receipt points at. For a database server error it
adds `error_text=`, `statement=` and `position=` (#7112): the server's primary
message with every quoted value replaced by `…` (an object name such as a
column, a relation or the token a syntax error stopped at is kept), the first
line of the failing statement with its literals replaced, never its
parameters, and the error's character position. A PL/pgSQL `RAISE` keeps no
text, because it can carry page values. The stored receipt keeps the same
identifiers (never an application error's message) owner-side in `error_detail`, with the
build that ran the attempt; on the brain host `gbrain write-request <id> --json`
prints that `error_detail`, and names an owner on another build than the CLI
(`owner_build`) and the restart to run. Connection-wait evidence follows on Postgres:
`first_conn_ms` is the time from phase start until the phase obtained a
connection; `checkout=not_observed conn_wait_ms=<n>` means it had not obtained
one after `n` milliseconds (a saturated pool or pooler, not a slow query); and
`loop_lag_ms` is the longest event-loop delay during the phase (a busy or
starved process). The same fields appear in the consumer's status snapshot
under `phase`. Unfinished work stays tracked and is retried; nothing is lost. Run `gbrain sources writer status --json` to see what is waiting.
A `deadline_exceeded` phase is also how a round-trip a transaction-mode pooler
(Supavisor port 6543, PgBouncer) never completed ends: the backend sits in
`ClientRead`, the cancel request the deadline sends may never reach it, so
`GBRAIN_CANCEL_SETTLE_MS` (default 2000) after the cancel the owner discards
that reserved connection, the statement settles client-side, and the next tick
runs. The connection end is not reported as `storage_error`; doctor's
`persistence_session_timeouts` names a transaction-mode URL, and the
session-mode URL of the same pooler (Supabase: port 5432) avoids the class.
`phase=preparation` lines name a write whose preparation ran past its budget:
`reason=deadline_exceeded` (the claim is released with `blocked_reason`
`preparation_deadline` and one attempt is counted; the budget is
`persistence.sync_preparation_ms` for a managed sync member,
`persistence.maintenance_preparation_ms` for every other managed kind and 30 s
for `remember`, `put_page` and `edit_page`), `reason=preparation_stalled` (the
request reached `persistence.max_preparation_attempts` and was finished
`failed` instead of being claimed again) and `reason=ceiling_exceeded` (the
preparation ignored cancellation past `persistence.preparation_ceiling_ms`; the
message names the step and what it waited on, and ends `restart_required` when
this process holds as many such preparations as it tolerates and has stopped
claiming). The runbook is
[catch-up stuck](guides/troubleshooting.md#catch-up-stuck). The
line is rate-limited (one per second, one per phase and code every 30 seconds).
An idle consumer keeps one ordinary-pool connection for its work probe and
never holds a direct or session-pooler connection, so a
`GBRAIN_DIRECT_DATABASE_URL` that points at a session pooler is not pinned by
idle `gbrain serve` processes.

<a id="persistence-claim-phase"></a>**Claim phases.** Each claim renewal also records the claimed write's phase
(`preparing` or `publishing`); `gbrain sources writer status --json` shows it as
`claim` on running blockers, and doctor `persistence_write_stall` warns past
`persistence.max_claim_ms` (default 600000, 60000 to 86400000). A running
claim also carries the preparation `step`, how long it has been in it, what it
waits on (`git`, `fs`, `db`, `pool` or `unknown`) and the owner process (kind,
pid, gbrain version); past its budget, `claim.stall` reads
`preparation_overdue`. Each request counts the cut-offs of its preparation in
`persistence_requests.preparation_attempts`. See
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

## The Rust engine shell

The opt-in Rust engine (`docs/designs/RUST_ENGINE.md`) is under construction. PGLite and Postgres behave exactly
as before, and an install needs no Rust toolchain and no addon. `openRustEngine({ addon, databasePath })`
(`src/core/rust-engine.ts`) is the one seam: the `rust` case of `constructEngine` (`src/core/engine-construct.ts`)
calls it after the addon loader has loaded and verified the native addon, and gets back the engine: every
`BrainEngine` member, with `kind` `'rust'`. A `~/.gbrain/config.json` with `"engine": "rust"` and an absolute
`database_path` (the store directory) selects it; that is a hand edit, because no command writes the value. A missing
or relative `database_path` refuses `config_error` before the addon loads. Finding, checking and loading the
addon, and refusing a missing or mismatched one, belong to the loader (below), not the shell.

- **Capabilities.** The engine reports a capability only when it serves every `BrainEngine` member of that
  capability (`src/core/rust-engine/store-capabilities.ts`). Today that is `schema`, `sources`, `config`, `page_versions`, `tags`, `embeddings`, `keyword_search`, `vector_search`,
  `graph`, `facts`, `files`, `salience`, `raw_data`, `eval_capture`, `ingest_log`, `dream_verdicts`, `contradictions` and
  `ontology`. `links`, `timeline`, `takes` and `code_edges` are not reported: each still has a member that refuses
  (listed under "What a Rust brain serves now").
  Each member it does not serve refuses `engine_capability_missing` with the capability as `reason` (`raw_sql`,
  `pages`, `search`, ...), the member in `detail`, and `written=nothing`, before any work.
  `src/core/rust-engine/members.ts` maps every member to its capability; the type fails when a new `BrainEngine`
  member is not classified. What each capability still lacks is under "What a Rust brain serves now".
- **One owner process per brain.** `connect()` takes the kernel lock `<database_path>.gbrain-owner.lock`; its
  holder opens the store and serves it on `<database_path>/.gbrain-owner.sock` (`ownerRole` `'owner'`). Any other
  process is a `'client'` that forwards each call; transactions refuse there. Limits and errors:
  `docs/designs/RUST_ENGINE.md` ("Process model").
- **SQL-only paths.** Code that only works through SQL (migrations, engine migration and graduation,
  embed backfill, page-body staging) takes the kind as `EngineKind`, narrows it with `sqlEngineKind` or
  `isRustEngineKind` (`src/core/sql-engine-kind.ts`), and refuses a Rust brain with `engine_capability_missing` reason `raw_sql` instead of treating it as Postgres. Cycle locks
  are not wholly SQL-only: a Rust brain serves `acquireCycleLock`, `refreshCycleLock` and `releaseCycleLock`
  (`src/core/rust-engine/store-members/jobs.ts:12-20`), and `readCycleLocks`, `deleteCycleLock` and `deleteCycleLockIfStale`
  still refuse with `engine_capability_missing` (capability `minion_queue`, `src/core/rust-engine/members.ts:328-330`).
- **On the CLI.** Commands that need raw SQL (`import`, `sources add` and others) refuse `engine_capability_missing`.
  When the source lookup is refused on a Rust brain and a source was selected (`GBRAIN_SOURCE`, a `.gbrain-source`
  file, `sources.default`) or the brain holds a source besides `default`, the command stops with that refusal instead
  of reading every source (`refusedSourceTarget`, `src/core/source-resolver.ts`). `gbrain init` with no engine flag
  keeps an existing `rust` config: it reports the brain, leaves `config.json` unchanged and never opens the store;
  `--pglite`, `--supabase`, `--url` and `--prefer-postgres` still choose the engine
  (`src/commands/init-existing-engine.ts`). The owner makes the store directory mode 0700 when it opens the brain.
  Pinned by `test/rust-cli-parity.serial.test.ts` (`docs/TESTING.md`, "Rust parity arm").
- **The addon loader.** `loadRustEngineAddon()` (`src/core/rust-engine/addon-loader.ts`) returns the loaded addon,
  or the refusal `rust_engine_addon_missing` or `rust_engine_addon_mismatch` with its `reason` (`gbrain errors
  <code>`), before the brain is touched. It uses `GBRAIN_RUST_ENGINE_ADDON` (an absolute path to a build from `bun run
  rust:build`; it skips only the release checksum pin) first, then an addon cached at
  `<gbrain home>/engines/rust/<engine_build>/<target>-<sha256>.node` whose SHA-256 equals the cached manifest of this gbrain
  version. It never reaches the network and writes nothing: with no cached addon it refuses with reason
  `not_installed`, and a cached file that fails a check stays as it was. `engine install rust` fills it
  (below). Only the Rust engine's open path may import the loader, lazily, so a PGLite or
  Postgres brain never loads the addon or creates `<gbrain home>/engines/`.
- **Installing the addon.** Releases ship it for linux-x64-glibc (glibc 2.35+) and darwin-arm64 with an attested
  SHA-256 manifest. `gbrain engine install rust` installs it after checking both; upgrades run it for a
  Rust or shadow brain ([refusals](guides/troubleshooting.md#rust-addon-install)).
  **Say to your agent:** *"Install the Rust engine addon."*
- **Shared memory.** The addon refuses a typed array whose buffer the runtime (`napi_is_arraybuffer`) does not call a
  plain `ArrayBuffer`, so a `SharedArrayBuffer` view is refused with `InvalidArg` however JavaScript globals or
  prototypes have been changed (`rust/README.md`).

### What a Rust brain serves now

`connect()` opens the brain directory through the addon's store (`rust/README.md`, "The brain store") and
`disconnect()` closes it. A second engine on an open directory becomes the owner's client; a second direct store
open refuses `rust_store_locked`; a directory the
store cannot read refuses `rust_store_unreadable` with its reason (`gbrain errors <code>`). A served member on an engine
that is not connected refuses `engine_closed`. These members run on the store (`src/core/rust-engine/store-members/`):

- Contradictions, dream, raw files and code edges: `writeContradictionsRun`, `loadContradictionsTrend`,
  `getContradictionCacheEntry`, `putContradictionCacheEntry`, `sweepContradictionCache`, `getDreamVerdict`,
  `putDreamVerdict`, `sweepDreamVerdicts`, `putRawData`, `getRawData`, `upsertFile`, `getFile`, `listFilesForPage`,
  `addCodeEdges`, `deleteCodeEdgesForChunks`, `getCallersOf`, `getCalleesOf` and `getEdgesByChunk`. They make the
  `contradictions`, `dream_verdicts`, `raw_data` and `files` capabilities complete. `code_edges` is not: the three
  code traversal cache members `getCodeTraversalCache`, `putCodeTraversalCache` and `clearCodeTraversalCache` refuse. `getRawData` and the
  code-edge reads refuse `excludePrivate: true` with `engine_capability_missing` instead of ignoring it. Each store
  write is one transaction, so a refusal leaves nothing written. Per-member contracts are in
  `rust/docs/store/` (`contradictions.md`, `dream.md`, `raw_files.md`, `code_edges.md`).
- Config, sources and tags: `getConfig`, `setConfig`, `unsetConfig`, `listConfigKeys`, `getAllConfig`,
  `getConfigValues`, `listAllSources`, `updateSourceConfig`, `getSource`, `listSourceLocalPaths`,
  `getSourceStrictness`, `addTag`, `removeTag`, `getTags`, `pruneFrontmatterTags`, `addPageTagsById`. These are the
  members that make the `config`, `sources`, `tags` and `schema` capabilities complete. The store keeps each tag's
  claim (`added` or `frontmatter`) as PGLite's `tags.tag_source` does, so an import prune removes only the tags the
  import claimed. `getSource` returns the stored `last_commit` (null until `advanceSourceCommit` has recorded one), and reads
  `contextual_retrieval_mode` and `trust_frontmatter_overrides` as null and false: the store keeps no value for those two
  columns (`rust/crates/gbrain-store/src/sources.rs`, `SourceDetailRow`).
- Pages: `getPage`, `readPageSnapshot`, `putPage`, `deletePage`, `softDeletePage`, `restorePage`, `listPages`,
  `resolveSlugs`. A stale `expectedRevision` refuses with `PageRevisionConflictError`, as on PGLite.
- Versions, chunks and timeline: `createVersion`, `getVersions`, `revertToVersion`, `upsertChunks`, `sealChunks`,
  `getChunks`, `getChunkPage`, `getChunkWindows`, `countChunklessPagesWithContent`, `listChunklessPagesWithContent`,
  `deleteChunks`, `addTimelineEntry`, `addTimelineEntriesBatch`, `getTimeline`, `getTimelineForDate`, `getSince`,
  `getOnThisDay`, `getLastSeen` and `upsertEventProjection`. `page_versions` is reported. `timeline` is not, because
  `removeTimelineRows`, `updateTimelineDetails`, `readRowTrustRows`, `listStoredTimelineRowsOrdered` and
  `deleteTimelineRows` still refuse. `chunks` stays unreported, because `deleteChunksExcept`, `setChunkerVersion`, `writeTextProjectionSeal`, `moveChunkIndexes` and
  `getChunkReuseRows` still refuse. Reads: `rust/docs/store/chunk_queries.md` and `timeline_queries.md`.
- Links and graph: `addLink`, `addLinksBatch`, `removeLink`, `getLinks`, `getBacklinks`, `traverseGraph`,
  `traversePaths`, `traversePathsDetailed`, and the link reads in `rust/docs/store/link_queries.md` (`getBacklinkCounts`,
  `getAdjacencyBoosts`, `relationalFanout`, `findOrphanPages`, `supersedingPageSlugs`, `pagesLinkingTo`, ...). Every
  member of `graph` is served, so `graph` is reported. `links` is not: `lockRegisteredSourceIds`, `replaceWantedLinkRows`,
  `readLinkContextMatches`, `readLinkContextOriginPages` and `listAmendmentsNotApplied` still refuse.
- Vectors and embeddings: `searchVector` and `searchTakesVector` (an exact scan over the stored vectors, scored as
  pgvector scores them), the embedding state members (`getEmbeddingsByChunkIds`, `cosinesByChunkIds`, `listStaleChunks`,
  `setPageEmbeddingSignature`, `updateTakeEmbeddings`, ...) and `upsertChunks` and `sealChunks` with the vector a chunk
  carries (`rust/docs/store/vectors.md`, `rust/docs/store/embeddings.md`). The `vector_search` and `embeddings`
  capabilities are reported. The store has one vector column, PGLite's `embedding`.
- Facts, ontology and eval capture: `insertFact`, `insertFacts`, `deleteFactsForPage`, `expireFact`, `listFactsByEntity`,
  `listFactsSince`, `listFactsKeyset`, `listFactsBySession`, `listSupersessions`, `countUnconsolidatedFacts`,
  `findCandidateDuplicates`, `consolidateFact`, `findTrajectory`, `getFactsHealth`, `pageCollapseFacts` and
  `migrateFactsToCanonical` (the `facts` capability); `mergeOntologyFact`, `getOntology`, `discoverOntologyDimensions`
  and `findOntologyConflicts` (`ontology`); `logEvalCandidate`, `listEvalCandidates`, `deleteEvalCandidatesBefore`,
  `logEvalCaptureFailure` and `listEvalCaptureFailures` (`eval_capture`);
  the four open-loop members `upsertOpenLoop`, `closeOpenLoop`, `listOpenLoops` and `readEntityOpenLoops`
  (`facts`; `rust/docs/store/facts.md`). A caller policy these members cannot honour
  refuses `engine_capability_missing`. Contracts: `rust/docs/store/facts.md`, `ontology.md`, `eval_capture.md`.
- Takes, salience, stats and the ingest log, alias and slug members, and the extraction and page-listing reads:
  `rust/docs/store/takes.md`, `salience.md`, `stats.md`, `aliases.md`, `extraction.md` and `page_ops.md`. The `salience` and `ingest_log`
  capabilities are reported; `takes` is not, because `matchTakeRows`, `deleteTakeRows`, `listLiveTakesByIds` and
  `findTakeId` still refuse.
- Facts and ontology claims, page operations, raw data and files, eval capture, dream verdicts, contradiction runs and
  the code call graph: `rust/docs/store/facts.md`, `ontology.md`, `page_ops.md`, `raw_files.md`, `eval_capture.md`,
  `dream.md`, `contradictions.md` and `code_edges.md`. The `facts`, `raw_data`, `files`, `eval_capture`,
  `dream_verdicts` and `contradictions` capabilities are reported; `code_edges` and `pages` are not (`page_ops.md` says why for `pages`).
- Keyword and title search: `searchKeyword`, `searchKeywordChunks`, `countKeywordPages`, `searchKeywordPages`,
  `searchTitles` and `findByTitleFuzzy`. They rank with a port of PostgreSQL's `ts_rank`, `ts_rank_cd` and
  `websearch_to_tsquery` (english), so their answers match PGLite's (`rust/docs/store/keyword.md`). Every member of
  `keyword_search` is served, so the capability is reported.
- Segmented pages (a page over 1 MiB, stored in segments): `allocateBodyOccurrenceIds`, `stageSegmentTexts`,
  `readSegmentTexts`, `stageManifestRows`, `readManifest`, `stageSegmentChunks`, `createSegmentedPageShell`,
  `flipBodyGeneration`, `openBodyStaging`, `setBodyStagingState`, `readSegmentDerivations`, `upsertSegmentDerivations`,
  `retireSegmentDerivations`, `sealSegmentedPage` and `refreshPageBody`. `sweepSegments` still refuses, and so does
  a segmented page written inside `transaction` (the member refuses on a Rust brain; the store has a native
  `beginTransaction` that no TypeScript member exposes), so the `page_body` capability stays unreported.
  A whole-body `putPage` over a segmented page refuses, as on PGLite (`rust/docs/store/page_body.md`), and so does a
  plain (unsealed) `upsertChunks`, `invalid_state` before it writes.

A served member never drops what it cannot keep. An option or input the store has no home for, or cannot answer the
way PGLite does, refuses `engine_capability_missing` and writes nothing. These are refused today:

- a chunk that carries an image vector, and a Rust brain whose config sets `search_embedding_column` or
  `embedding_columns` to another column (the store keeps PGLite's `embedding` column only; every member that reads the
  active column refuses, `rust/docs/store/embeddings.md`);
- a `putPage` with a `source_path` into a source in source-root slug mode whose directory is below its repository root
  (only the files on disk can say whether another page already holds that file, and the store cannot read them);
- `listPages` with `listColumnsOnly`;
- `resolveSlugs` when the store's answer is empty (`src/core/rust-engine/store-members/pages.ts:81`). The store answers
  the live page with exactly that slug, else up to five fuzzy matches (trigram title similarity or a slug containing the
  text); the member passes a non-empty answer through;
- a `getChunks` or `getChunkPage` over more than one distinct `sourceIds` entry;
- a vector search with `where`, a date bound, `minTrust` or `suppressFlagged` (`rust/docs/store/vectors.md`);
- an input of a raw-data, page-operation, salience, facts, ontology, chronicle or code-edge read the store cannot
  reproduce, including a privacy policy wider than the store's (each `rust/docs/store/*.md` page lists them);
- a keyword or title search with a CJK query, a text search configuration other than `english`, a truthy
  `requireSafeChunks`, `minTrust` or `suppressFlagged`, a date bound that is not an ISO date, a malformed `where`, or a
  truthy `excludePrivate` on `searchKeywordChunks`, `countKeywordPages` or `searchKeywordPages` (`searchKeyword` and
  `searchTitles` serve it; `rust/docs/store/keyword.md`, "Refusals").

`addLinksBatch` accepts nullable `link_kind` and `resolution_type` fields. A `link_kind` must be `plain` or
`typed_ner`, and a `resolution_type` must be `qualified` or `unqualified`; any other value is rejected.

A `putPage` that carries a `source_path` keeps it, and refuses `page_identity_changed` (detail
`origin_already_claimed`) when another live page of the same source already records that path, as PGLite does.

What the Rust members do the way PGLite does: `putPage` writes the page alone. It does not chunk and does not seal,
and `upsertChunks` does not seal either; only `sealChunks` replaces the chunks outright and seals them to the page's
revision, so a page is searchable only after `sealChunks`. `getChunks` returns `[]` for a page that is not sealed at its
current revision. `deletePage` hard-deletes from the default source. `softDeletePage` and `restorePage` with no
`sourceId` act on every source. Slugs are matched as written. A cancelled `AbortSignal` stops `upsertChunks`,
`addLinksBatch` and `addTimelineEntriesBatch` before anything is written, but a write already running in the native
store cannot be cancelled, which is a difference from PGLite. Overlapping `connect()` calls share one open, and a
`disconnect()` during a connect wins: the connect rejects `engine_closed` and the store it opened is closed.

A scope that names no source (an empty string `sourceId` or `sourceIds` entry) is never widened: `getChunks` and `getTags` answer it as PGLite does, with nothing, instead of reading every source. A keyword hit always carries `effective_date` and `effective_date_source`, null when the page has no date.

Keyword search hides what PGLite hides: soft-deleted pages, archived sources, pages that carry a `quarantine` or
`pinned_question` frontmatter key, whatever its value, and the slug prefixes `test/`, `attachments/` and `.raw/` plus any
that `GBRAIN_SEARCH_EXCLUDE` names (`include_slug_prefixes` opts back in). Keyword and title search rank with a port of `ts_rank` and
`ts_rank_cd` over a port of PostgreSQL's english text search, and match PGLite's scores and order. No keyword case is
listed in `test/rust-expected-divergence/` (`search.tsv` is empty).

The parity suite checks this: with `GBRAIN_TEST_RUST_ARM=1` each `test/engine-parity/` file adds a Rust arm. A case that
reaches a member or an option Rust refuses must end on that typed refusal (a refusal the case caught on the way to
another outcome does not count); any other case must return what PGLite returns, or differ only as its row in
`test/rust-expected-divergence/` (one file per family) names with a normaliser, and Rust must still return a value (a thrown error never
passes, and a row that stops being true fails the run). The suite
runs on PGLite alone without the flag.

**Transactions and the belief ledger.** Both stay refused on the Rust engine, on purpose.

- `transaction`, `transactionDirect` and `lockPageKeys` refuse `transactions`, and so do `readTransactionSettings`,
  `applyTransactionSettings`, `beginSnapshotRead`, `declarePersistence` and `requireSynchronousCommit`
  (`src/core/rust-engine/members.ts`; `store-members/transactions.ts` exports nothing). The store has a native
  transaction handle that spans several calls (`brain.beginTransaction`, `rust/crates/gbrain-napi/src/families/transactions.rs:24`);
  no TypeScript member exposes it. `lockPageKeys` throws outside a transaction on PGLite. Code that passes settings into a
  transaction (the write attribution, trust and maintenance settings in `src/core/persistence/context.ts`) reads and
  applies them with the typed members `readTransactionSettings` and `applyTransactionSettings` (`context.ts:35,46`); the
  SQL engines run them as `current_setting` and `set_config` (`src/core/engine-sql/transaction-settings.ts`), and a Rust
  brain refuses both.
- `belief_ledger` is a subsystem, not a `BrainEngine` member: `src/core/belief/` appends and reads belief events through
  `executeRaw`. The Rust engine never reports `raw_sql` (design D18), so the ledger refuses until its reads and appends
  have typed members. Nothing in the Rust engine writes belief events today.

## Rust engine shadow mode

Shadow mode checks the Rust engine against your real reads before you switch to it. It is off by default and changes
nothing about how your brain answers: the primary engine (PGLite or Postgres) always answers first, and a sample of
reads and searches is then replayed against the Rust engine in a separate, supervised child process. The child
compares the two answers and records only content-free rows (time, operation, outcome, reason code, row counts, timings) in a local
ledger. Its only writes to the brain database are the swap-eligibility writer evidence below (one row per writing
process, and on Postgres one trigger per table while shadow mode is on); nothing is written to brain content, the
config table or the brain repo, and all other shadow state lives in
`~/.gbrain/shadow/<brain>/` (`$GBRAIN_HOME/.gbrain/shadow/<brain>/` when `GBRAIN_HOME` is set).

**Say to your agent:** *"Turn on Rust engine shadow mode for my brain and show me the report."*

```bash
gbrain engine shadow seed [--json]                 # copy the brain into the Rust store once (shadow mode off)
gbrain engine shadow start --plan                  # preview the plan and its plan_hash, writes nothing to the shadow directory or the brain's tables (also reports whether the brain can swap)
gbrain engine shadow start --yes --expect <hash>   # turn it on (loads the Rust addon first; refuses without it)
gbrain engine shadow reconcile [--full] [--json]   # compare the whole brain with the Rust store and repair differences
gbrain engine shadow status [--json]
gbrain engine shadow report [--json]               # prints the report; writes reports/provisional.{json,md} only once the shadow directory exists
gbrain engine shadow stop [--delete]               # turn it off; --delete removes the shadow directory
```

- **Fail-open.** Mirroring never fails a primary call; a sampled read pays only the bounded copy described below. The queue is bounded (`--queue-bound`, default 256)
  and sheds when full; reads inside a transaction are skipped; `--sample-rate` (default 0.1) picks which reads are
  mirrored. Only sampled reads are copied, the arguments before the call and the result the moment the primary answers, so a caller that changes a result
  afterwards cannot cause a false difference. The copy stops as soon as a call's arguments or result pass about
  1 MiB (every value counts, even a null), so a huge result is counted as too large and never built. A
  call that stays stuck in the Rust engine holds one of four slots; past that new reads are recorded as `timeout` (stalled) without being replayed and the child goes
  quiet so it is restarted. When a process closes, it first waits up to 2 seconds for its pipe to the child to flush (Bun drops what a pipe still holds when a process exits), then reads still queued are handed to the child and the child records them: it drops the CLI's pipe handlers so a closed pipe cannot kill it, drains what it received, writes its ledger and summary, and exits at most 30 seconds after its input ends (the parent's kill timer dies with the parent, so the child carries its own deadline). Finished comparisons are written every 2 seconds. A read still queued when a process is killed, or one the child had not yet written when it is killed, is lost. The child restarts with backoff, and mirroring turns itself off after 5 child exits in 10 minutes, a
  child silent for 60 seconds is killed, and a privacy divergence pauses comparison.
- **What a privacy divergence is.** Before any equality check, every row of the Rust result is tested against the call's own
  arguments, and one hit records `privacy_diverged` and pauses mirroring (a plain `diff` can never hide it). A hit is a row with
  a source outside the call's scope, read the way the primary applies it: `sourceIds` first, else `sourceId`, else the
  positional source of `listFactsByEntity` (first argument), `resolveSlugWithAlias` (second) and `findByTitleFuzzy` (fourth); an
  empty `sourceIds` with no `sourceId` names no scope, so the read is unscoped, as in the primary. The row's `source_id`, and on a link its `from_source_id`, `to_source_id`
  and `origin_source_id`, must all be in a `sourceIds` scope; a one-source link read checks only the end the primary scopes
  (`getLinks` the from page, `getBacklinks` the to page). A hit is also a page row (one carrying `frontmatter`) that a call with
  `excludePrivate` should hide: `visibility: private`, a pinned question, an unmarked atom, question or synthesized concept, or (with `visibility` unset) an
  `access` or `confidentiality` alias the primary reads as private; an alias row counts only when the primary's own answer left it out,
  because a brain can turn the aliases off and the child cannot read that setting.
  Not checked, because the result carries nothing to check: `resolveSlugs`, `resolveSlugWithAlias`, `getTags`, `getTimeline`,
  `getChunks`, `findByTitleFuzzy`, `getStats`, `countKeywordPages`, `searchTakes` and `searchTakesVector` rows have no source column, search rows only
  when they carry `source_id`, and `excludePrivate` only on rows with `frontmatter` (so not facts, links, finds or search rows).
  A leak in those shows as `diff`.
- **Brains and deleting.** Each brain gets its own directory, keyed by its engine and where it lives: the database path for PGLite, or the host, port, database and user name for Postgres
  (two Supabase projects behind one pooler differ by user name; the password is never part of it). `stop --delete`
  removes the directory, and a child that is still running cannot write it back. The commands cover the host brain only:
  with `--brain <id>` or `GBRAIN_BRAIN_ID` naming another brain they refuse and change nothing.
- **Managed storage: reported, not refused.** Shadow mode gathers evidence on managed brains too; only the swap
  refuses them (`engine_swap_refused`, reason `managed_storage`, which `gbrain engine swap` still returns and shadow
  mode never does). `start` (the preview, `--plan` and `--yes`) opens the brain database once, best-effort, and reads one
  row: `persistence_brain.enabled`. A PGLite brain opens without recording its managed roots and without repairing a
  damaged log, so the open writes no managed-root ownership marker or registry entry and moves no datastore file aside; like any PGLite open it takes the datastore's process lock and PGLite rewrites its control and log files until `start` closes the brain. A brain with an open repair episode is left unread (`repair_episode_open`), because a healthy open would close the episode and prune its backups. A managed brain prints `storage: this brain cannot swap while it uses managed
  storage` in the plan and after `--yes`, and `state.json` records `storage: { managed: true, checked_at }` (`false` for
  an unmanaged brain). A brain whose mode cannot be read (the database is down, another process holds a PGLite brain, a
  PGLite path holds no brain which `start` never creates, or the row is missing or malformed) does not block `start`: it
  prints `storage: could not read whether this brain uses managed storage; the swap will check it (<reason>)` and records
  `{ managed: null, checked_at, reason }`, where `reason` is the error's code (`pglite_busy`, `no_brain`,
  `storage_error`) or `open_failed` / `read_failed`, never free-form error text. `start` opens the database only for
  this record, so it is the one place that needs the database reachable, and a failed open never changes the exit code.
  `status --json` and the report carry the same record as `storage: { managed, checked_at, note, reason? }` (the
  field a later command reads to know the brain cannot swap), where `note` is `this brain cannot swap while it uses
  managed storage` for a managed brain, `could not read whether this brain uses managed storage; the swap will check
  it` when `managed` is null, and null for an unmanaged brain; `storage` is null for a state written before the field
  existed. `status` and the report print the note as a line. `status` and the report read the recorded value; they do
  not open the database.
- **Why this is safe for the primary.** `start` reads one row and writes no table row, source file, managed-root ownership marker or registry entry. Opening a PGLite brain still touches its own files: it takes the datastore's process lock (the `.gbrain-lock` folder and the `<datastore>.gbrain-owner.json` and `.gbrain-owner.lock` files beside it) until `start` closes the brain, and PGLite rewrites its control and log files (`global/pg_control`, `pg_wal/`), as any open of that brain does. The mirror replays sampled reads
  into the Rust store under the shadow directory. Nothing in shadow mode writes a row to the primary database, or writes its worktrees, its
  write effects or its writer coordination locks. The residual risk is to the evidence: a write the owner process or an effect worker
  applies outside the wrapped engine is not seen by shadow mode, so the comparison for it may differ; such a write
  shows up as a difference or a miss in the counts, never as silent equality.
- **Parallel sync and import.** A Postgres `gbrain sync` that imports on worker connections (a full sync at the default
  concurrency, an incremental sync of more than 100 files, or `--concurrency` above 1) and a `gbrain import --workers N`
  with N above 1 wrap each worker like the primary engine, when the worker opened the same database URL as the primary:
  its page and link writes are sampled for write comparisons (each worker has its own sampler, which finishes its
  read-backs before the worker disconnects), followed into the Rust store, and noted as this process's writes for swap
  eligibility. A worker on another database URL is left unwrapped.
- **No network in the background.** Only `gbrain engine install rust`, `gbrain post-upgrade` and autopilot's automatic upgrade download the addon. `start --yes`, the child
  and `gbrain doctor` only use an addon that is already installed; without one, `start --yes` refuses and stays off, `gbrain doctor` fails
  the `rust_engine_addon` check, and the child records `addon_unavailable` (`rust_engine_addon_missing`, reason `not_installed`).
- **Doctor.** `rust_engine_addon` checks the installed addon when shadow mode is on and is not applicable otherwise.
- **Writer observations (swap eligibility).** While shadow mode is on, each process that writes to the brain through
  gbrain notes itself in `engine_writer_observations`: its host id, the name its database connections carry, its
  command kind and gbrain version, the write protocol it speaks (`write_protocol`: 2 in this build; an older build's row
  has none), and when it first and last wrote. The note runs after the write committed, in its
  own short transaction, at most every 10 minutes per process; a rolled-back transaction leaves none. A brain without
  a shadow keeps the table empty.
- **Writer hooks (Postgres brains).** `start --yes` adds one statement-level trigger, `gbrain_writer_note`, to every
  brain table, and `stop` removes them. Each trigger records the writing connection (its `application_name`, client
  address and backend pid) in `engine_writer_sessions`, at most every 10 minutes per connection, so a writer that is
  not a gbrain process on the shadow machine (another machine, `psql`, an older gbrain) still leaves a row. A trigger
  never fails the write and never waits on the evidence tables: it takes each table's lock with `NOWAIT`, so a lock someone else
  holds is an error it catches at once, and its own `lock_timeout` of 50 ms (set on the function, so the writer's settings are
  untouched afterwards) bounds any other wait. The sessions table has no unique key, so the trigger's insert has no uniqueness check that could wait on another transaction's uncommitted row (repeated rows do not raise the session count, and a refresh updates every matching row that no other transaction holds locked). It does not catch a cancelled query, so a user's own cancel still cancels, it skips a row
  another transaction holds (that skip is recorded as a gap, since the write went unrecorded), and any error becomes a row in `engine_writer_coverage_gaps` (that table has no
  sequence, so an INSERT alone records a gap). It stamps the time it ran, not the start of the writer's transaction.
  If both evidence tables are unusable at once, the trigger can only warn; a table that is missing or locked then
  makes the eligibility read fail (`eligibility_evidence`, NOT READY), and a role with no usable route is counted by
  the role check, so a stretch with no evidence cannot read as clean while the damage lasts. Two limits remain: a
  statement timeout that fires inside the trigger is not caught (the 50 ms bound keeps it far below any timeout), and
  a writer whose write lands while both evidence tables are locked by someone else at the same moment, and the locks
  are gone before the swap reads, leaves no row. `gbrain engine shadow stop` exits 1 and says to run it again when it could not remove the hooks (the database was unreachable); the hooks keep noting writers until a later stop removes them. `stop` ends the bookkeeping of processes that are still open: they
  note and repair only while `state.json` says shadow mode is on, and a repair acts only while the hooks file says
  `installed`. Adding or removing the triggers takes a short lock on each table (start refuses after 5 seconds
  rather than queue writers). `<shadow dir>/writer-hooks.json` is written before the first trigger, the
  install is one transaction (a killed start leaves nothing), and the next `start` or `stop` removes triggers a crash
  left. PGLite brains are not hooked: one process on one machine opens them. Measured cost on a local Postgres 16,
  one client, 1,500 writes each, two rounds: a one-statement write went from about 1.08 to 1.34 ms at p50 (p99 1.46
  to 1.95 ms, about 21% fewer writes per second), and `put_page` from about 2.33 to 2.58 ms at p50 (p99 3.80 to
  4.00 ms, about 10% fewer per second). The cost applies only while shadow mode is on.
- **Eligibility.** The swap reads the evidence with one read-only query: `eligibility.writer_hosts_7d` counts the
  machines that claimed writes in the last 7 days (from the first start of the current seed at the earliest, with 10 minutes of slack; starting again keeps that
  start, `start` replaces the hooks in one transaction so writers are never unhooked in between, and `stop` records a gap row in
  the transaction that removes the hooks, because nothing records writers after that; a state file from before this
  start was recorded keeps its own start, and a stopped one records the gap at the next start),
  and `eligibility.unknown_writer_paths` counts what no claim accounts for: a writing connection no gbrain process on
  the shadow machine claimed, a gap row, a brain table whose hook is missing or does not fire for every write
  (disabled, replica-only, conditional, the wrong events or another function; the next note repairs it and leaves a
  gap row), a role that can write brain tables (a table privilege, or a privilege on any single column) but has no
  complete way to record evidence (INSERT on `engine_writer_coverage_gaps`, and row-level security that lets it in; the
  session table alone is not enough, because a refresh the trigger skips can only be recorded as a gap), plus the
  file-side evidence: reconcile follower misses, repairs made while coverage was invalid, and a lost note. The roles
  judged are the login roles and every role a non-superuser login can `SET ROLE` to (the SET option of a membership
  on PostgreSQL 16 and newer, direct or through a chain; plain membership on older servers), because the trigger runs
  with the rights of whichever role is current when it fires. A process claim resolves a connection's rows only
  while the claim is inside the window too, so an expired claim cannot hide a current writer. The process-side note
  runs under a 50 ms lock timeout and a 2 s statement timeout, so a busy evidence table ends it as a recorded
  failure instead of holding one of the brain's connections. A writer of an
  older build counts too: a row seen since the current evidence epoch began (not only in the last 7 days) with no
  `write_protocol`, or one below 2, is named in `eligibility.legacy_write_writers`, and an epoch manifest that is there and
  cannot be read counts as one more unknown path (no manifest at all means no epoch yet). A brain where the migration that
  adds the column has not run cannot read the evidence, so the swap refuses.
  A fault or pass record that is
  torn, has no time, lacks a count or carries a count of the wrong type is incomplete evidence and counts too. Criterion 11 reads
  NOT READY on any evidence it cannot prove, so a gap nobody thought of fails closed. In particular, shadow mode
  being off or not provably enabled adds one unknown writer path for as long as it stays that way. A `stop`, or a `start`
  that continues an existing epoch, first writes a marker to `state.json` (`writer_coverage_stopped_at`,
  `writer_coverage_restarted_at`) before any hook changes, so a failed gap insert cannot hide it; either or both markers
  add one more unknown path while they fall inside the eligibility window (7 days plus the 10-minute refresh slack), and
  the swap is refused with `writer_coverage_unknown` until then. The open engine's capabilities decide whether the hooks
  must exist. A state file whose primary engine is missing, not a known kind, or not exactly the open engine's kind adds
  one unknown path. An unreadable state file adds one when the swap builds its status document; if `state.json` is
  absent, the swap reader reports no shadow instead. Known limit: criterion 11 reads role privileges as they are now, so a privilege repair inside the window can hide an earlier unrecorded write (follow-up: a durable coverage-break record across role and ACL changes). A write that only takes a lock,
  a log or a cache row counts as a write for the note, though the follower does not copy it. The plan's idea of
  counting how often an enabled process held no attached engine is not built: it cannot be measured from the shadow
  machine, and the database hooks replace it. Any
  one of them refuses the swap (`writer_coverage_unknown`). A connection pooler in transaction mode hides the client's
  connection name, so its writes read as unclaimed. `gbrain engine shadow status` never opens the database, so it
  shows only `team_brain` and `preview_target`; the swap passes in the brain it already has open.
- **Evals.** `gbrain eval longmemeval` and `gbrain eval brainbench` take `--engine pglite|rust`. With `rust`, a missing
  or mismatched addon stops the run with its code and reason, and so does a Rust store that cannot yet run the table
  reset between fixtures (`rust_benchmark_unsupported`), so until the benchmark can reset a Rust store without raw SQL (the Rust engine never reports `raw_sql`) the flag
  stops before any work. A longmemeval run records the engine in its resume hash, and the memory-trust brainbench
  suites refuse `--engine rust` because they always build PGLite brains.
- **Seed.** `seed` copies the brain into the Rust store once, from one read-only snapshot, and writes
  `seed.json`: what it copied, the values the store could not keep, the unfinished jobs and segmented pages it left
  behind, and the unseeded gap rows (tables the Rust store cannot serve yet; a swap is refused while any remain).
  It refuses while shadow mode is on. To seed again, `stop --delete` and seed into the new directory.
  Rust store layout: [rust/docs/store/seed.md](../rust/docs/store/seed.md).
- **Managed storage: seeded, not refused.** Shadow mode gathers evidence on managed brains too; only the swap
  refuses them (`engine_swap_refused`, reason `managed_storage`, which `gbrain engine swap` still returns and shadow mode
  never does). `seed` and `seed --json` run on a managed brain and copy it like any other. Right before its snapshot, in
  a statement of its own so a failed read cannot abort the snapshot, `seed` reads one row, `persistence_brain.enabled`,
  and records `storage: { managed, checked_at, reason? }` in `seed.json`. A managed brain prints `storage: this brain
  cannot swap while it uses managed storage`; `managed` is `false` for an unmanaged brain (no line). A mode that cannot be
  read once the brain is open (the row is missing or malformed) does not stop the seed: it prints
  `storage: could not read whether this brain uses managed storage; the swap will check it (<reason>)` and records
  `managed: null` with the error's code (`storage_error`) or `read_failed`, never free-form error text. A
  brain that cannot be opened at all cannot be read, so that is an error, not a mode: `seed` exits 1 with `could not open
  the brain (<code>)` before it loads the addon or creates anything. This includes a PGLite brain that another process holds
  (`gbrain serve` or any other open): the seed exits 1 with `could not open the brain (pglite_busy)` and asks you to stop
  that process and run it again. A PGLite path that holds no brain is never created. `status --json` carries the record as `seed.storage: { managed, checked_at, note, reason? }` (null before a
  seed, or for a seed written before the field existed), where `note` is `this brain cannot swap while it uses managed
  storage` for a managed brain, `could not read whether this brain uses managed storage; the swap will check it` when
  `managed` is null, and null for an unmanaged brain. `status` and the report print the note; the report's `seed.storage`
  has the same shape. `seed` writes no table row, source file, managed-root ownership marker or registry entry, and it
  never writes the primary's worktrees, write effects or writer coordination locks, so every `persistence_*` row and the
  content root are byte-identical across it. Opening a PGLite brain still touches its own files: the open takes the
  datastore's process lock (the `.gbrain-lock` folder and the `<datastore>.gbrain-owner.json` and `.gbrain-owner.lock`
  files beside it) until `seed` closes the brain, and PGLite rewrites its control and log files (`global/pg_control`,
  `pg_wal/`), as any open of that brain does. `seed` opens a PGLite brain without recording its managed roots and without
  repairing a damaged log, so it moves no datastore file aside. A brain with an open repair episode is not opened
  (`seed` exits 1 with `could not open the brain (repair_episode_open)`), because a healthy open would close the episode
  and prune its repair backups. A repair episode recorded while `seed` waits for the datastore lock is left open too, and
  its backups stay.
- **Follow.** A seeded brain is followed while shadow mode is on. Each committed write through the wrapped engine is
  read back from the brain, in its own short read-only `REPEATABLE READ` transaction (on Postgres, a dedicated
  one-connection pool, so the serving pool is never used), and applied to the Rust store, so stored ids and fact
  fingerprints stay identical. A rolled-back transaction changes nothing. Inside a transaction, the rows a write will
  delete or re-key, and the page ids it names, are read first in a savepoint that only that read uses. A nested
  transaction still running is waited for first (its own calls go on; the transaction's later calls are held, so none
  is sent ahead of the write), then the transaction's other calls already running, each wait at most 2 seconds, and
  later calls are held until the write is sent, so a failed read can never undo another statement of the transaction. A call that starts a callback during that wait makes the read skip at
  once, and so does a call that does not finish in time: that write is described relation-level instead. The transaction's
  end waits until no read holds the lane, and at most 2 seconds for calls it started and did not await. A statement sent
  on the transaction's driver handle (`tx.sql` as a tagged template or `unsafe`, `tx.db.query`, `tx.db.exec`, or on
  PGLite the `tx.db.sql` template) goes through the lane and the follower as `executeRaw` does, however it is started
  (awaited, `execute()`, `forEach()` or a cursor), as the text the driver sends. A structural value the shadow cannot
  render makes that write an invalidation, and `describe()` counts as a read. Such a write is followed; when it is
  sampled it counts as `capability_missing` in the `raw_sql` family and is not compared. The handle's other members
  are not seen, including ones that send a statement: postgres.js `begin` (its callback runs on a child handle that is
  not wrapped), `savepoint`, `file` and `notify`, and PGLite `transaction` and `listen`. A nested transaction that
  waits for a later call of its enclosing transaction while a read waits for it stalls until the 2-second bound; the
  read then skips, the write is sent at once, described relation-level, and the later calls follow it, so the
  transaction commits what it commits with shadow off. The coverage watermark says whether every
  committed write is in the store. It goes invalid on a shed, a gap in the write sequence, a failed read, a relation
  the follower cannot describe row by row (which then needs a pass for that relation), or rows the store had to
  displace. **Every session that owns the store starts invalid**, even after a clean stop, and becomes valid again
  only when a full reconcile pass that started after the session start has proven the store, or when it carries on a
  seal. A serving process that closes with everything handed over and applied (`gbrain serve` included; a successful
  `engine shadow reconcile` too) has its child write a seal into `follower.json` (`src/shadow/seal.ts`). The next
  owner session takes the sealed obligations over only when `follower.json` was not written since, `state.json` was
  not restarted, the evidence epoch is the same and no line was added to `follower-invalidations.jsonl`; it is still
  invalid until its serving process confirms that the primary shows no write since the seal. On Postgres the seal holds
  a versioned token read from the database's own counters: the statistics epoch and, for each relation the seed copied
  (and `page_projection_jobs`), its oid, relfilenode and insert, update and delete counts. The confirmation refuses any
  difference, a new coverage gap, a hook that is not working, a login role that can write a brain table with no way to
  record evidence, `track_counts` off, a server older than PostgreSQL 15, a prepared transaction, another connection
  with a write open, and any other connection of a role that can write a copied relation (itself, or through any role
  it can switch to with SET ROLE: a NOINHERIT login that writes after `SET ROLE` counts) that is not idle, went idle
  under a minute ago, or cannot be seen by the reading role (without superuser or `pg_read_all_stats` another role's
  `pg_stat_activity` row has NULL state, transaction id and backend type), because counters show only what the server
  has flushed. A connection of a read-only role, such as a monitoring agent, is never waited on. No seal is written under the same conditions, and not while a
  connection the writer hooks recorded is still connected, whatever the age of its row: a writer still connected during
  the seal check is refused until it commits or disconnects. After the child took a confirmation the check reads once
  more, and a failure withdraws it (`revokeSeal`: invalid again, full obligation). A confirmation that was sent but not
  acknowledged is withdrawn too (`seal_confirm_unacknowledged`): a timeout does not cancel what is already in the pipe.
  Every withdrawal first appends a `seal_revoked:<reason>` line to `follower-invalidations.jsonl`, which the child reads
  on its own, then sends `revokeSeal` again until the child acknowledges it. When neither gets through the doubt is
  returned: the first check runs a full pass and the close does not seal. PGLite never seals or confirms
  (`pglite_no_db_continuity`). Any doubt, a failed read or a timeout leaves the watermark invalid until a full pass. A
  write published after the follower closed, or one the child would not take, leaves an invalidation line, which
  voids the seal; write capture stays on through the close, so a write a later before-disconnect callback makes is
  recorded too. A line that cannot be written is retried, told to a live child, and blocks the seal while unrecorded
  (`lost_write_unrecorded`). Any event after a seal removes it from `follower.json` before the next event, and taking
  a seal over removes it in the same first write that shows the watermark invalid; when either write fails, a line in
  `follower-invalidations.jsonl` makes the seal stale. A start that refuses a seal, or fails to take it, appends its
  blocker line to the existing file and empties the file only after its seal-free `follower.json` is written, so the
  file never returns to the sealed size. Each decision is named in `follower.json` `seal_outcome` and in
  `engine shadow status` (`seal: <outcome> (<reason>)`). The named persistence-journal members (`JOURNAL_BOOKKEEPING_MEMBERS` in `src/shadow/follow.ts`)
  publish the tables their statements write instead of invalidating the watermark; every other member the write map
  does not cover still invalidates it. A relation marked dirty
  is settled by a pass for that relation that started after the mark. Only the process that owns the Rust store
  applies writes. A second process cannot apply: its child leaves a line in `follower-invalidations.jsonl` (at most
  one per second while it sees writes) and the owner reads those lines before it advances the watermark, treating the
  second after each line as unproven. A write by a second process is therefore unproven for a short moment before its
  line lands, and a read-only command leaves no line.
- **Reconcile.** `reconcile` compares every seeded relation with the Rust store in 500-row key intervals and replaces
  any interval that differs, then checks allocators and the fingerprint probe. Each interval is its own short read of
  the primary (with a pause between intervals) and nothing is held open while the pass talks to the Rust store, so a
  pass is not one snapshot: each interval is protected by the generation taken just before its read. `reconcile` and
  `reconcile --full` both run a full pass. It needs the Rust store to be free (stop the serving process first). A full
  pass also runs on its own 5 seconds after a serving process starts (once its seal is confirmed or refused) if the
  watermark is still invalid, no full pass ran yet, the last one is 24 hours old or one was left half done; every 24
  hours while the follower runs; and again when the watermark is invalid and the last pass is over an hour old. A full
  pass saves its progress (`reconcile/progress.json`) after each interval. A process that closes during a pass records
  no pass (closing is not a failed pass, so the count of trailing clean full passes is kept) and the next session with
  the same continuity, seed and evidence epoch finishes that pass instead of starting over. The exception is a stopped
  part that repaired rows or found follower misses: it is recorded at once as a full pass with error `stopped`, so the
  repair is on record even if the next pass starts fresh, and the next full pass is then due. Otherwise only a finished
  full pass is recorded, and only a clean one counts. A seal or a resumed half never counts as a pass of its own. Swap readiness (criterion 1)
  also needs the newest clean full pass to have finished under 24 hours ago (`reconcile.last_clean_full_pass_at`), so a
  brain that ran its three clean passes and then stopped reconciling is not ready. A pass that
  displaced rows does not restore the watermark; the relation gets another pass and the full restore waits for the
  next full pass. A displaced page also marks `tags` dirty, because its tags go with it. An interval that already
  matches is still rewritten, so its generation fence stops a follower read that began before the pass from
  overwriting what the pass verified; every full pass therefore rewrites rows that were already correct.
  **A seed written before follow existed has no digest entries**, so nothing is followed and `reconcile` refuses it:
  `status` says the brain needs a reseed (`follower.state` is `needs_reseed`, with the steps in `follower.action`).
  Reseed with `gbrain engine shadow stop --delete`, then `gbrain engine shadow seed`, then `gbrain engine shadow start --plan`,
  then `gbrain engine shadow start --yes --expect <plan_hash>` (a bare `start` only prints the plan).
- **Privacy, stable rerun and vector recall evidence.** Each sampled read carries the caller's access record (none, when there was
  none), and the shadow runs Rust under it. On a mismatch of a read made under `excludePrivate` (plain, under `remote`, or a find's `untrusted`
  policy), every Rust row the primary's own answer lacked is judged on the primary with its read
  policy for that caller (ids only; a row the caller may not read is `privacy_diverged` and pauses comparison, and counts against
  criteria 6 and 3). A mismatch nothing explains is `inconclusive` and gets one stable rerun behind a barrier on the follow stream
  (30 s, queue of 64); a rerun that still differs is a `diff`, one that matches closes unsuccessful, and one that could not run
  stays unexplained. Vector recall@10 is scored against the primary's own search with index scans off, at most once a minute, and
  appears after 30 scored samples in the epoch. **What counts as unexplained:** ten reads
  carry no source or private marker (`resolveSlugs`, `resolveSlugWithAlias`, `getTags`, `getTimeline`, `getChunks`,
  `findByTitleFuzzy`, `getStats`, `countKeywordPages`, `searchTakes`, `searchTakesVector`), so every unexplained `diff` on them counts into
  `reads.diverged_unexplained_7d`; on the two take searches only a different row set counts, not the same rows in another order. Facts,
  links, finds and search rows read under `excludePrivate` count a `diff` too. The one exception: a ranked `searchVector` diff
  under `excludePrivate` whose extra Rust rows ALL passed the per-row check (same captured record, the primary's policy text) is a
  ranking difference, because vector and default-ranker membership differences are legitimate (the ranked-search rule: a vector search may return different rows of equal rank). A row the check cannot
  evaluate (no page identity, a page the primary lacks, a failed, skipped or moved check) is unchecked, and the diff counts. Accepted
  ranking differences are never dropped: the status and the report list them per member (`evidence.ranking_differences`) next to the
  rule. What the child sends back carries no content: the serving process keeps a bounded registry of recent samples (arguments, the
  caller's record and the primary's own answer) and the child asks about a sample by an opaque sample id. The child sends only
  the identities of the Rust rows (page, chunk and digests; a slug only for a row with no page id), the serving process does the comparing, and an answer is a verdict
  (a rerun's answer is the epoch, a stamp, digests and an attempt id, plus the chunk ids and scores of a vector read's first ten rows), never a row, a title, a slug or chunk text. A failure is an allowlisted code, and
  an answer is bound to the asking child's session, so a restarted child never receives its predecessor's. An unresolved
  comparison is written to the ledger (`rerun: pending`) before its rerun starts and settled by a completion row with the same
  sample id; one never completed (a crash, a restart) counts as unexplained. A ranked diff is cleared only at row identity
  and only when nothing the policy reads changed since the read. A Rust row is held when it is byte-equal to a primary row in every
  field but the ranking ones; a row with a primary row's page and chunk but another payload (a substituted title or flag), or one
  that claims a chunk without a numeric chunk id, is never cleared and the diff counts. A new row is judged on the primary with the
  read policy, the safe-chunk fence the read asked for and the chunk visibility the primary used, and it clears only when every field but the ranking ones is the primary's own stored one for that page and chunk (the same read, with its limit widened to five times the caller's, at least 50 and at most 500, under the same filters, so a row the caller's own query filters exclude is never one the primary holds, and a row ranked beyond the widened limit is not found); a stored row that cannot be read leaves the row unexplained. "Nothing changed" is proven by a freshness token taken from the primary BEFORE the primary read started (never a newer one) and
  checked again at the end of the check. The token is the transaction snapshot's upper bound (`pg_snapshot_xmax(pg_current_snapshot())`, one more than the
  newest transaction that has finished anywhere in the cluster, kept as the whole 64-bit `xid8` and never cut to 32 bits) and the list of transactions in progress at that moment (the snapshot's
  own list and the one each session is running; a subtransaction becomes visible only with its top-level transaction, so that is the one listed), all
  from one query. It holds only if the upper bound is the same, none of the listed transactions has committed (one that is no longer
  known counts as committed), no prepared (two-phase) transaction exists, and this process's write generation is the
  same (the privacy check also needs the access tables' generation to hold, and no page or access row to carry a time later than the read). A transaction
  that commits has to finish, and finishing moves the upper bound or ends a listed transaction, so any committed write to any table, to the
  catalog (a policy altered in place) or a change undone again (A, B, A) moves the token, in this database or any other of the same
  cluster, including a commit made with `synchronous_commit=off` or held back by `commit_delay` or a synchronous standby. What does not move it is
  what changes nothing a read can see: a read that prunes dead rows, a checkpoint, a standby snapshot, a plain vacuum, a logical message. A role that is neither a superuser nor in
  `pg_read_all_stats` cannot see other sessions' transactions, so its token is blind and clears nothing, and a prepared transaction at the capture blinds it too. The proof is for a primary only: a server in recovery (a hot standby) replays writers that no list shows, so its token is blind and the end of a check refuses.
  When it moved, both engines and the reference are run again from a new position, up to 3 times (a recall score gets 3 runs in all, the first included, so it waits at most twice). Each run after a move
  starts only after a wait that grows (about 0.5 s, then 2 s, then 8 s, each varied by up to a quarter either way, about 13 s at most for one sample), so a short burst of writes
  (a batch job, a bulk import) can pass. The wait is a timer in the shadow child: it blocks neither the serving process nor the child's comparison of new reads (other reruns queue behind it), and it ends at once when the child is told to stop.
  It does not touch the 30 s limit of each run, and a rerun that is waiting holds its place in the queue of 64. A sample still moving
  after that stays unresolved (`skipped:moved`) and counts into `reads.diverged_unexplained_7d` (criterion 3). So busy brains clear
  fewer samples; an idle one clears them all, because a read of its own no longer moves the token. Waiting helps when writes come in bursts or at irregular times, because the later reruns land in quieter moments; it cannot help when the cluster writes all the time, and on a busy shared cluster some samples still stay unresolved and count under criterion 3.
  Each rerun is its own attempt, with its own answer and position; the follow-up questions name the attempt, and an unknown or dropped one is never proven. The privacy question of a read made under `excludePrivate` is open by default, and only an allowlist settles it: a row of such a read settles it when its rerun matched or differed, or when its outcome is one that completed a comparison (`match`, `order_diff`, `collation_order`, `diff`, `privacy_diverged`, or `stale`, the lagged mismatch; `order_diff` only after a completed compare with a clean privacy check, because any other privacy verdict makes the row `inconclusive` or `privacy_diverged` first) and no rerun is pending or skipped. Every other row counts in `privacy_checks_unsettled_7d`, whatever reason it carries or lacks: a row still pending (a crash or restart left it so), a skip, a timeout, an error, `capability_missing`, an inconclusive row with no completed rerun, and any outcome added later until it is classified. `privacy_diverged` is absent while any is open. A brain with no `excludePrivate` reads has no such row, so nothing reads as unsettled there. The registry's 64 MiB cap holds for a rerun's answer too: charging an entry evicts the oldest other entries until the total is within the cap, and an answer that would pass the cap on its own is not kept (the rerun ends as `too_large`, unresolved and counted). The rerun's wait for the follow lock has the same deadline as its Rust call, and so does the wait of a recall score's rerun (that sample is then not scored): an apply that never ends ends the rerun as a timeout (unresolved and counted), makes the child unhealthy by itself (it stops heartbeating until the stuck chain recovers, so the supervisor's watchdog restarts it, even while ordinary reads still answer and later reruns time out earlier, at their barrier), and never lets the abandoned read run later. Each question of the child runs in the serving process with a signal and a 45 s deadline of its own, never the cancelled signal of the request that started the child. A recall score that finishes after `engine shadow stop --delete`, or for a replaced epoch, is dropped (the directory is never recreated), and a recall directory that cannot be read makes recall unavailable. A list of more than 2,000 row identities, or one holding anything invalid,
  is never complete. The vector reference is the engine's own exact statement with no candidate
  window and is used only when the same proof holds from the sample's capture to the end of the reference run; otherwise the sample is
  not scored. Tied rows at the cutoff count only for the top-ten places the strictly better rows leave, and a reference whose last row
  (of 50) still ties the cutoff is not scored. A stable rerun compares digests: the whole answer, and for a ranked read its rows without scores in a fixed order, so the same
  rows in another order or with other scores are an `order_diff` (closed as matched on the reads that ignore order). The comparator
  version is 4 (it was 1): a running shadow opens a new evidence epoch, so records written under the earlier rules never count. Known limits, not fixed here: a position that does not move proves nothing was written but says nothing about a change that is not WAL-logged (an unlogged table), and a server in recovery (a hot standby or read replica) is never proven; and a read the caller was authorized to make that
  returns a private page still reads `private_row_returned` and pauses comparison (it fails closed).
- **Status fields.** `status --json` adds: `follower.state` (`not_seeded`, `needs_reseed`, `stopped`, `invalid`, `behind`,
  `following`), `follower.action` (the reseed steps, or `null`), `lag_ms`, `lag_ms_p99_24h` and `lag_ms_p99_epoch` (a power-of-two bucket upper bound, not an exact
  value), `queue_depth`, `applied_rows`, `coverage_watermark`; `reconcile.state` (`never_run`, `ok`, `repaired`,
  `error`), `last_pass` (with `repaired_rows`, `repaired_by_relation` and `follower_misses`: repaired rows found while the
  watermark claimed coverage), `consecutive_clean_full_passes`, `last_clean_full_pass_at` (when the newest full pass
  finished, if it was clean; `null` otherwise), `next_full_pass_due`; `fingerprints` (`checked_rows`,
  `mismatches`, and a `probe`, described below); `allocators`;
  `seed`; `primary_refreshes` (`nonterminal_rows`: primary `gbrain sources refresh` rows that are neither completed nor
  aborted, counted by the last full pass, with its `checked_at`; `null` before one; a swap must drain them first, and
  this is a reading, not the swap's own check); and `write_comparisons` (the pilot page and link writes only; `capability_missing` until a comparison has a verdict (`comparable` or `unexplained_difference`), and while any replay has none or a sample owed to a session is not yet settled, `outstanding_sessions`, and for the rest of the epoch once a write window is lost in a crash, `write_windows_lost`). The
  `write_comparisons` and `fingerprints` counts are totals for the current evidence epoch. An epoch is not a seed: `epoch_id`
  names the candidate whose evidence counts (the seed, the Rust addon's SHA-256, the comparator and adapter versions, the
  capability set and the hash of the swap's readiness policy, `src/core/engine-swap/policy.ts`), and a change to any of them
  starts every count over.
- **Evidence fields.** `status --json` also carries the swap's read and search evidence for the current epoch (`report` prints
  the same counts):
  `reads` (successful comparisons per operation class with their minimum, and the 7-day counts of `capability_missing`,
  unresolved `rust_error` and unexplained divergences), `search` (trigram and keyword/title exact disagreements, plus `vector_recall_at_10` and `primary_recall_at_10` once 30 samples are scored), `privacy_diverged`
  (the count of rows a caller may not read; absent until something is compared, and while a privacy check of the last 7 days is unsettled), `child`
  (panics and faults) and `evidence` (`epoch_id`, `epoch_started_at`, `readiness_days`, `earliest_ready_at`, `recall_samples`,
  `ranking_differences`, `privacy_checks_unsettled_7d` and the counting rules). A count with no evidence is left out, never zero, and the swap reads it as `NOT READY`. The follower and evidence
  fields are read from one epoch; if the epoch keeps changing while the document is built, `epoch_id` is `null`, the
  evidence fields are left out and `evidence_epoch_unstable` is `true`. `gbrain engine swap --plan` reads this same document.
- **Fingerprint probe.** Withdrawals and purge tombstones key on the fact fingerprint, so a primary whose `lower()` or
  `[[:space:]]` answers differ from PGLite's (and Rust's) for some code point would fingerprint a claim holding it
  differently, and a withdrawn fact would not match on Rust. At follower start and on each full pass the probe reads, in
  one read-only set-based query, `lower(chr(cp))` and `chr(cp) ~ '[[:space:]]'` for every Unicode scalar value (surrogates
  and U+0000 excluded) plus the word-final sigma rule, and compares them with PGLite's tables in
  `rust/crates/gbrain-store/tests/fixtures/fact_fingerprints.json`. It also runs every hand row and every sixth seeded row of
  that corpus through `gbrain_fact_fingerprint` and `gbrain_fact_fingerprint_v1` (texts as bind parameters, never logged).
  If any code point differs it counts the stored `facts` rows whose claim holds one (a count, never the text). The query costs
  about 0.5 s on Postgres 16 and 17 with a glibc database, 0.7 s with an ICU database and 0.7 s on PGLite, measured on a dev
  container; it reads only. `probe` carries
  `state` (`pass`, `fail`, `not_run`), `checked_at`, `server_version`, `mismatches` (the fixed 20-claim corpus against Rust), the
  database's `collation`, `ctype`, `locale_provider` (`c` libc, `i` ICU, `b` builtin) and `locale` (`datlocale` on Postgres 17,
  `daticulocale` on 16, `null` where absent), `differing_code_points` (the first 50 as `U+XXXX`) with
  `differing_code_points_total`, `corpus_mismatches` with `corpus_mismatch_rows` (the first five row names, never text) and
  `facts_with_differing_code_points`. When code points differ the probe also counts the primary's `fact_purges` rows (`fact_purges_unverifiable`; a count, never a hash; a dirty pass for `facts` or `fact_purges` runs the probe again, and if that probe errors the pass clears the recorded verdict to `not_run` and does not restore coverage): a tombstone keeps only the claim's hash, so its claim cannot be checked for a differing code point. `state` is `fail` when code points differ and at least one stored fact holds one or any purge tombstone exists, or when
  a corpus row or the fixed corpus differs and no differing code point explains it; otherwise `pass`, and a pass still lists the
  differing code points so a swap report can name them. A probe that errors is `not_run`. A glibc `en_US.utf8` host differs
  (U+0085, U+1680, circled letters and more); a C-ctype host differs on every cased non-ASCII letter, so it fails once a fact
  holds one.
- **Provisional report.** The verdict is always `NOT READY`: write comparisons cover the pilot page and link writes only,
  and the readiness decision comes later in the plan
  (`docs/designs/RUST_ENGINE.md`, Phase S). Until the Rust engine serves reads, comparisons record
  `capability_missing`.

[Shadow capture](guides/shadow-capture.md) records engine calls for a later replay.

## Adding a new engine

1. Create `src/core/<name>-engine.ts` implementing `BrainEngine`
2. Add a case to `constructEngine` in `src/core/engine-construct.ts`, which `createEngine` and `openEngine`
   both build through. Its dynamic imports load an engine's dependencies (the PGLite WASM blob) only when selected.
3. If the engine speaks the Postgres dialect, add a dialect adapter that
   implements `SqlExecutor` (`src/core/engine-sql/executor.ts`) beside
   `dialect-pglite.ts` and `dialect-postgres.ts`, expose it through a private
   `engineSql` getter over the current connection, and delegate every method
   of a migrated domain to `src/core/engine-sql/<domain>.ts` the way both
   engines do. Declare its capabilities honestly. The binding matrix
   (`test/helpers/executor-binding-matrix.ts`) and the engine-sql contract
   tests tell you whether the adapter binds, counts, fails and cancels like the
   others. A non-SQL engine implements typed methods instead of a `SqlExecutor`:
   it declares no `raw_sql` capability, and each member it cannot serve yet
   refuses `engine_capability_missing` (see "The Rust engine shell" above).
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
| Graph traversal | Breadth-first recursive CTE (one row per layer) | Breadth-first recursive CTE (one row per layer) | Same SQL |
| Transactions | Full ACID | Full ACID | Both support this |
| JSONB queries | GIN index | GIN index | Identical |
| Concurrent access | Connection pooling | Single process | PGLite limitation |
| Hosting | Supabase, self-hosted, Docker | Local file | |
| Migration methods | runMigration, getChunksWithEmbeddings | Same | Identical |

## Future engine ideas

TursoEngine (libSQL with embedded replicas and edge sync), DuckDBEngine (analytics and bulk exports beside
Postgres, not OLTP) and custom engines over any store: the interface assumes no SQL. There is no SQLite engine;
PGLite speaks Postgres SQL, so no FTS5/sqlite-vss dialect is needed.
