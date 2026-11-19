# Engine graduation spike: PGLite to Postgres copy route

Day-1 spike for verified engine graduation (plan §5.1 and the day-1 items of §13). It measures two logical copy routes from a PGLite brain into a Postgres target, the target triggers that rewrite or refuse a verbatim copy, which trigger-bypass mechanism each target role permits, which `foresights doctor --no-migrate --json` checks write, how released binaries treat a tombstoned data dir, and time to value.

**Recommendation: Route B, the inventory-driven in-process copier, streaming `COPY ... FROM STDIN` in primary-key keyset batches.** Each table copies in its own target transaction under `SET LOCAL session_replication_role = replica` when the role permits it, otherwise under `ALTER TABLE ... DISABLE TRIGGER USER`. It passes verify on every fixture and target tested, adds no dependency, needs no superuser, works through transaction-mode PgBouncer, and is 3x faster with a fifth of the peak memory of Route A at 10k pages. Route A also passes verify, but only after five workarounds. It needs `psql` and a new dependency, and through a transaction-mode pooler it leaves `search_path = ''` on every pooled server connection.

## Setup

- Source brains:
  - **1k:** `buildHistoryFixture(engine, { pages: 1000, seed: 42, sources: 3, worktrees: 2 })` on PGLite 0.4.3 (PostgreSQL 17.5, schema v200). Built in 105 s. 12,002 carried rows in 96 tables, 49 shared sequences.
  - **10k:** the same at 10,000 pages, built in 1,033 s. 119,457 carried rows.
  - **Embedding variants:** copies of the 1k and 10k brains in which every chunk, fact and take carries a deterministic 1024-dimension vector (1,168 and 11,668 chunks). The generator writes no embeddings, so without these copies the vector paths and the HNSW build go unmeasured.
  - **Legacy:** a hand-made brain, unmanaged (`persistence_brain.enabled=false`), whose rows exercise every target trigger path:
    - an unattributed legacy `page_versions` row;
    - tags;
    - a timeline row written after its page;
    - a completed minion job with `claim_generation=3` and a pre-protocol job with NULL `submission_authority`;
    - a parent/child job;
    - a withdrawn fact and a superseded fact (self-FK);
    - halfvec and vector embeddings;
    - bytea and numeric values;
    - a shared skill pack;
    - a raised protocol floor;
    - text primary keys that order differently under `C` and `en_US.utf8` (`Alpha alpha a-b a_b ärger`).
- Targets (all 1:1 with `initSchema`, collation `en_US.utf8`):
  - `pgvector/pgvector:pg16` (16.15) as superuser.
  - The same server as a non-superuser table owner.
  - `edoburu/pgbouncer` 1.26 in transaction mode with prepared statements off.
  - `supabase/postgres:15.8.1.085` as its non-superuser `postgres` role.
- Verify (identical for both routes):
  - `count(*)` per table on both sides.
  - A sha256 per table over every non-generated column rendered as text, in primary-key order under `COLLATE "C"`, with `TimeZone=UTC`, `DateStyle=ISO`, `extra_float_digits=3`.
  - Exact sequence positions (`last_value`, `is_called`).
  - Every user trigger on the target enabled.
- Reproduce: `scripts/persistence/graduation-spike.ts` (`fixture`, `legacy`, `embed`, `target-init`, `route-a`, `route-b`, `verify`, `triggers`, `ttv`). Every command prints one JSON document.

## Route comparison

| | Route A: `pgDump` data-only | Route B: in-process copier |
|---|---|---|
| Verify (1k, legacy, 10k-emb) | green after five workarounds | green |
| 1k, copy (3 runs) | dump 0.52-0.58 s + apply 0.66-0.80 s + filtered tables 0.2 s | COPY 0.84-1.02 s; VALUES 1.95-2.13 s |
| 10k with embeddings, copy, indexes deferred | dump 6.2 s (252 MB text) + apply 57.6 s with indexes live | COPY 6.7 s, then index build 11.7 s; VALUES 18.6 s |
| 10k with embeddings, whole process | 64 s wall, 4.26 GB peak RSS | 19.5 s wall, 0.88 GB peak RSS |
| Code | about 40 lines of wrapper, plus Route B's catalog and copier for the filtered tables, plus `psql` | about 150 lines: catalog, FK order, keyset reader, COPY/VALUES writer, sequences |
| New dependencies | `@electric-sql/pglite-tools` 0.3.3 (exact pin for pglite 0.4.3, 1.8 MB) and the `psql` binary | none |
| Superuser | no (same bypass as Route B; `pg_restore --disable-triggers` would need it) | no |
| Transaction-mode PgBouncer | unsafe: leaves session state on pooled connections | safe: all state is `SET LOCAL` |
| Resume, per-batch digests | none; one opaque script | per-batch keyset checkpoints and digests come with the reader |

Route A needed these workarounds before it verified:

1. pglite-tools forces `--inserts`, which writes positional `INSERT INTO t VALUES (...)`. Column order differs between the engines (`sources.chunker_version` is the 7th column on Postgres and the 15th on PGLite), so positional inserts load values into the wrong columns (`invalid input syntax for type timestamp with time zone`). `--column-inserts` fixes it.
2. The PG17 `pg_dump` emits `SET transaction_timeout = 0`, which pg16 rejects (`unrecognized configuration parameter`). The line has to be stripped.
3. `pg_dump` cannot filter rows. `config` collides on the target's engine-local keys (`duplicate key ... (key)=(version)`), so filtered tables go through the in-process copier anyway.
4. `pg_dump` cannot transform columns. Transforms (`persistence_brain.enabled=false`, lease resets) become UPDATEs after the load.
5. `--table` filters drop sequences that no table owns: `page_generation_clock_seq` stayed at 3 instead of 13,947 until every sequence was listed explicitly.

The dump also opens with `SELECT pg_catalog.set_config('search_path', '', false)`. Through transaction-mode PgBouncer that session-level setting stayed on every pooled server connection (`SHOW search_path` returned empty on six consecutive connections). The next unqualified query from another client failed with `relation "config" does not exist` until PgBouncer restarted.

## Copy fidelity findings

- **Output-name shadowing loses rows silently.** A reader that selects `col::text AS col` and orders by `col` sorts by the text alias, while the keyset predicate `col > $1::bigint` compares the real column. On the 1k brain it skipped 799 of 4,702 `persistence_effects` rows, and the per-table digest still matched, because source and target shared the same reader. ORDER BY and keyset columns are qualified with a table alias (`FROM t AS s ORDER BY s.id`), and verify compares an independent `count(*)` besides the digest.
- **Column order differs between engines.** Every insert names its columns. The column contract by name, type, typmod, default and generation expression matches on all 1,185 columns the engines share at v200.
- **The vendored postgres.js 3.4.9 loses COPY errors.** When the server refuses a row during `COPY ... FROM STDIN` (check constraint, FK, refusing trigger), the ErrorResponse arrives after the client has sent CopyDone. `errored()` only destroys a live stream, so the pending `final` callback never runs: the writable never emits `finish` or `error`, and the transaction hangs forever (reproduced with a one-row check-constraint table). A one-line fix in `vendor/postgres/src/connection.js` `errored()`, `final && (final(err), final = null)`, surfaces the error ("new row ... violates check constraint"). It also has to go into the CommonJS copy and `vendor/patches/postgres@3.4.9.patch`. Until it lands, the copier needs a watchdog around each COPY or the VALUES writer.
- **Typed placeholders double-encode jsonb.** `$n::jsonb` with a JS string parameter makes postgres.js serialize the string as a JSON string (`"[...]"`), which the `op_checkpoints_completed_keys_array` check caught. `$n::text::jsonb` (every column cast through text) round-trips exactly.
- **Text rendering round-trips every v200 column type.** That covers `vector(1024)`, `halfvec(1024)`, `tsvector`, `jsonb`, `text[]`, `uuid[]`, `integer[]`, `bytea`, `numeric(p,s)`, `real`, `double precision`, `date` and `timestamptz`, each rendered with `::text` under the digest session settings.
- **Keyset order needs `COLLATE "C"` on both sides.** The default order on `en_US.utf8` is `a-b a_b alpha Alpha ärger default zeta`; under `C` it is `Alpha a-b a_b alpha default zeta ärger`. With `COLLATE "C"` on collatable key columns (not on uuid or integer keys, which reject a collation) both engines page identically.
- **Every table carried at v200 has a primary key**, so keyset batching covers the whole inventory.
- **Sequences:** setting each target sequence to the source's `last_value` and `is_called` reproduces all 49 shared sequences exactly, including `persistence_requests_sequence_seq`, `page_generation_clock_seq` and a not-yet-called `facts_id_seq` at 77.

## Target triggers

Postgres at v200 has 31 user triggers on 18 tables. PGLite has 48: the same set, plus 18 PGLite-only `planner_stats_{ins,upd,del}` triggers on six tables, minus `minion_jobs.minion_job_notify`. The verify-time trigger-state check therefore uses a per-engine expected set.

Copying each table with its triggers firing, `persistence_brain.enabled=false`, every other table already copied verbatim, and the result diffed against the source (`triggers` command):

| Table inserted | Effect on the target |
|---|---|
| `pages` | rewrites `generation` on every row (`bump_page_generation_trg` sets max+1, 1,001 of 1,001). It recomputes `search_vector` from `timeline_entries` (`trg_pages_search_vector`), which differs on 150 of 1,001 pages because the source vector predates timeline rows added later. It touches `page_projection_jobs.updated_at` (`pages_projection_queue`). |
| `tags` | rewrites `pages.knowledge_revision` and the revision attribution columns of the tagged pages, and `page_projection_jobs.revision` (`tags_knowledge_revision`) |
| `page_versions` | fills `write_request_id`, `write_principal_kind` and `write_principal_id` into legacy unattributed rows (`page_versions_write_attribution`) |
| `minion_jobs` | refuses any row with `claim_generation <> 0` or NULL `submission_authority` (`minion_queue_protocol`: "Minion queue protocol 1 required") |
| `shared_skill_packs`, `_heads`, `_revisions` | refuses every row while `enabled=false` (`gbrain_skill_publication`: "writer_upgrade_required") |
| `persistence_brain` | an INSERT passes; an UPDATE that raises `writer_protocol_floor` or turns on `skill_bundles_enabled` is refused (`gbrain_protocol_activation`), so an in-place rebind needs the bypass |
| `content_chunks`, `facts`, `takes`, `timeline_entries`, `page_aliases`, `slug_aliases`, `sources`, `persistence_requests`, `persistence_effects`, `shared_skill_delivery_batches` | verbatim |

`managed_writer_guard` is inert at `enabled=false`. A verbatim copy therefore requires the bypass; the copy itself cannot leave these triggers firing.

## Trigger bypass by target role

| Target role | `SET LOCAL session_replication_role = replica` | `DISABLE TRIGGER USER` (table owner) | `DISABLE TRIGGER ALL` |
|---|---|---|---|
| pg16 superuser | allowed; verify green | allowed | allowed |
| pg16 non-superuser owner | `permission denied to set parameter` | allowed; verify green at 1k and legacy | refused: system RI triggers |
| pg16 non-superuser after `GRANT SET ON PARAMETER session_replication_role` (pg15+) | allowed; verify green | allowed | refused |
| `supabase/postgres` 15.8 `postgres` (NOSUPERUSER, BYPASSRLS; supautils) | allowed; verify green at 1k and legacy | allowed; verify green | refused |
| pg16 through transaction-mode PgBouncer | allowed (transaction-scoped); verify green | allowed; verify green | n/a |

Behaviour of the `DISABLE TRIGGER USER` fallback:

- FK (RI) triggers stay active. RI checks run at the end of each statement, so a self-reference inside one COPY passes. The same rows split across separate INSERT statements fail: `facts.superseded_by` pointing at a later id gives `violates foreign key constraint "facts_superseded_by_fkey"` with one row per statement. The fallback therefore needs FK order plus one COPY per table, or two passes for self-FKs.
- `DELETE` of a parent cascades to children that are already copied.
- The disabled state is persistent. A run that failed mid-copy left all 31 user triggers at `tgenabled='D'`, so the mechanism and the tables it touched have to be recorded before disabling, and re-enabled on recovery.

Under `replica` neither ordering nor self-FKs matter, and nothing outlives the transaction.

## Non-superuser target prerequisites

`initSchema` as a non-superuser owner of a vanilla pg16 database stops three times. Each is a target probe:

1. `vector` is untrusted on the pgvector image: `permission denied to create extension "vector"`. It has to be installed beforehand. `pg_trgm` and `pgcrypto` are trusted.
2. The v24 RLS backfill requires `BYPASSRLS` on the role.
3. The v35 auto-RLS event trigger needs a superuser. When a superuser pre-creates it, `auto_enable_rls()` must be owned by the foresights role, or `initSchema` fails with `must be owner of function public.auto_enable_rls`.

On `supabase/postgres` the `postgres` role passes all three with no preparation (`initSchema` took 1.1 s).

Through PgBouncer, foresights's client sends `statement_timeout` and `idle_in_transaction_session_timeout` as startup parameters. A stock PgBouncer refuses the connection (`unsupported startup parameter: statement_timeout`) unless `ignore_startup_parameters` lists them, as the CI compose file does. With that, `initSchema` itself succeeds through transaction-mode PgBouncer.

## Doctor checks that write

`foresights doctor --no-migrate --json` ran against copied Postgres targets under a statement-level `BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE` fence on every table (`ENABLE ALWAYS`, raising), and with `log_statement=all`. It also ran against the PGLite sources with a per-table and per-sequence digest taken before and after.

| Check or path | Write | Where | Behaviour under the fence |
|---|---|---|---|
| `timeline_history` | `engine.setConfig('doctor.timeline_history.scan:<sources>', ...)`, an `INSERT INTO config ... ON CONFLICT DO UPDATE`, when a previous scan state exists or the scan truncates (page cap or time budget) | `src/commands/doctor/checks/timeline-history.ts:46` (`saveState`), called at `:72` and `:87` | refused; the error is swallowed and the check still reports its result. It writes a carried table (`config`) on the source at plan time. |
| PGLite planner-sensitive reads | first-read ANALYZE that folds `planner_stats_deltas` into `planner_stats_state` (1k source: 15,157 to 611 delta rows on the first doctor run, unchanged on the second) | `src/core/planner-stats.ts:273` `beforePlannerRead`, reached from `src/core/pglite-engine.ts:1279,1329,1624,1863,1886,1900,1944,2613` | PGLite only; errors are caught. It touches discard tables only, but it is a source mutation during `--plan`. |
| Local files (not the database) | `audit/skill-brain-first-snapshot.json`, `audit/db-disconnect-<week>.jsonl`, `last-update-check`, `backup-status.json` under `GBRAIN_HOME` | `src/commands/doctor/skill-checks.ts:375,382,384`, backup coverage, update check | unaffected by the database fence |

No other statement in either log modified data: 855 statements on the 1k target and 151 checks, no DDL, no advisory locks, no `set_config`. Two failing checks matter for the cutover gate:

- `sync_freshness` fails on both the source and the target of every generator brain, because the fixture never runs `foresights sync`. The gate "no failing check on the target" cannot pass on these fixtures unless they sync, or unless the gate compares against the source doctor.
- `wedged_queue` fails on the Postgres target and never on PGLite (`src/commands/doctor/checks/queue-jobs.ts:341` returns ok for every non-Postgres engine). It fires when a queue has waiting jobs, no healthy active job, no live worker, and a last completion older than 15 minutes. That is exactly the quiesced state of a graduating brain that carries waiting jobs, as the legacy brain does. Unless the verify-step doctor exempts it with its reason, it blocks every cutover of such a brain.

## Older binaries against a tombstoned path

`v0.60.46.0`, `v0.60.47.0` and the current branch ran `search`, `put`, `doctor --no-migrate --json` and `serve`, with `config.database_path` pointing at (a) a regular 0600 file where the data dir was (the tombstone) and (b) a missing path (data dir moved aside, no tombstone):

| Case | Every binary, every command |
|---|---|
| Tombstone file | Fails with `internal_error: EEXIST: file already exists, mkdir '<path>'`, exit 1. The file is untouched and no data dir is created. Each attempt leaves a sibling `<path>.gbrain-owner.lock` (the native kernel lock file is taken before the `mkdir`). `doctor` falls back to filesystem-only checks. `serve` exits 1 at startup. |
| Missing path | `search` and `put` exit 0 after creating a fresh empty brain at the old path (`PG_VERSION`, `base`, `global`, ... plus `<path>.gbrain-owner.json` and `.lock`); `doctor` creates it and exits 1. |

The tombstone design holds against released binaries, and the missing-path case is the stated residual (a crash between rename and tombstone followed by an older binary), which reconciliation has to detect as `graduation_split_brain`. New binaries need their own tombstone check before `acquireLock`: today they report the same opaque `internal_error` with a doctor fix, not `engine_graduated`.

## Time to value

Phases measured on one machine against local Docker pg16, COPY route with `replica` (`ttv` command). Times are milliseconds. The deferred set is the 12 HNSW, GIN and trigram indexes that back no constraint.

| Brain | Indexes | Source doctor | `initSchema` | Copy | Index build | Verify digests | Target doctor | Total |
|---|---|---|---|---|---|---|---|---|
| 1k + embeddings (3 runs) | live | 2,179-2,409 | 1,725-2,529 | 4,078-4,180 | – | 1,067-1,295 | 2,269-2,327 | 11,578-12,750 |
| 1k + embeddings (3 runs) | deferred | 2,194-2,258 | 1,888-2,370 | 1,134-1,329 | 522-561 | 1,194-1,380 | 2,280-2,558 | 9,381-10,510 |
| 10k + embeddings | live | 4,414 | 4,902 | 55,110 | – | 6,704 | 4,943 | 76,124 |
| 10k + embeddings | deferred | 4,733 | 2,388 | 6,715 | 12,864 | 8,517 | 5,218 | 40,502 |
| 10k, no embeddings | deferred | 4,658 | 2,011 | 4,003 | 160 | 4,641 | 5,076 | 20,655 |

Deferring the vector and GIN indexes cuts the 10k copy from 55 s to 6.7 s plus a 12.9 s build. At 1k the measured phases total about 10 s. Not included here: drain (one queued request and the delayed effect; bounded by `--drain-timeout`), the plan command's round trip, process start-up for two CLI invocations (about 1 s each), cutover (rename, tombstone, config write) and network latency to a hosted target. Even allowing a full 60 s drain timeout, the 1k flow stays well under the 5-minute gate. The 10k flow is about 41 s of measured work.

## What this changes for the build lanes

- **G2b copier:**
  - Route B with COPY; byte-sized batches and the VALUES writer only as a fallback.
  - Explicit column lists by name; every cast through `::text::<type>`.
  - Keyset batches with table-qualified ORDER BY and `COLLATE "C"` on collatable key columns.
  - Seed rows deleted inside each table's transaction.
  - `config` filtered by the engine-local key list.
  - Sequences set from `last_value`/`is_called`.
  - Indexes deferred.
  - The postgres.js COPY error fix (or a watchdog) is a prerequisite for COPY.
  - Under `DISABLE TRIGGER USER`: one COPY statement per table or two-pass self-FKs, and the mechanism recorded before disabling.
- **G2b `probeTarget`:**
  - The `replica` probe (`BEGIN; SET LOCAL session_replication_role = replica; ROLLBACK`).
  - Table ownership for the fallback.
  - `vector` installed or creatable.
  - `BYPASSRLS`.
  - The v35 event trigger present, or creatable by this role.
  - PgBouncer startup-parameter acceptance.
- **G1:**
  - The digest's independent `count(*)`.
  - Per-engine expected trigger sets (31 Postgres, 48 PGLite).
  - The column contract by name (ordinal order differs and must not be compared).
- **G2a / G3:**
  - New binaries detect the tombstone before `acquireLock` (released binaries fail with `EEXIST`, which is safe but opaque).
  - The source and target doctors write `config` through `timeline_history`, which needs a read-only skip or an exemption.
  - `wedged_queue` needs a graduation exemption.
  - `sync_freshness` fails on unsynced fixture brains.
- **G4:** the generator fixtures carry no embeddings and no legacy trigger inputs. The embedding variant (`embed`) and the hand-made legacy brain (`legacy`) cover both.
