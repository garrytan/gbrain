# Managed-sync catch-up bench (#5984)

On master, catching up a git source on managed Postgres is bound by
database round trips. Each committed page costs about 190 to 260
sequential round trips. At 57 ms RTT that is 3.4 pages/min with the
reporter's CLI loop and 4.2 pages/min when one process re-enters
`performSync`. The issue-sized 10k backlog projects to about 49 h,
close to the reporter's 52 h. The plan's budget for 150 pages/min is
about 7 round trips per page, and the publication transaction alone
takes 77 to 83. By the CEO-A1 decision rule, the measured numbers
call for multi-page (bulk) publication after the round-trip diet;
pipelined admission alone cannot reach the target.

With the drain loop, the diet and bulk publication (v0.60.48.0), one
`gbrain sync` catches up at 13 to 16 pages/min at 57 ms (the 10k
backlog in about 11 h instead of 49 h) and 775 pages/min near the
database, with foreground writes unharmed. See
[Results on the #5984 branch](#results-on-the-5984-branch-v060480).
The second round-trip diet brings a page's publication inside a group
to about 17 round trips (from 48) and the 57 ms rate to 24.5 pages/min;
see [Round-trip diet 2](#round-trip-diet-2-150-pagesmin-plan-phases-0-and-1).

This page is the research and decision record for the #5984 plan
(CEO-A1, A2, A3, A4, A6, A17, A19, A25, A26, A27, A29; ENG-A5, A9,
A11, A14, A15, A18; DX-A12, A13). The bench is opt-in and never runs
in CI.

## Rerun

Needs Docker on Linux (toxiproxy runs with host networking and every
listener binds 127.0.0.1) and Bun 1.4+. Make no provider calls: the
effects row uses a loopback stub for `/v1/embeddings`.

```bash
# 500-file rows at 57 ms and ~0 ms (the baseline table below)
bun scripts/bench/managed-sync-catchup.ts --files 500 --deletes 34 --rtt 57,0 \
  --rows cli,reentry,unmanaged,serve,effects,foreground,all,newcomer --max-minutes 15 --label <branch>

# issue-sized row: 10k files, 300-word pages, 300 pages of existing receipt history
bun scripts/bench/managed-sync-catchup.ts --files 10000 --deletes 34 --receipt-history 300 --pad-words 300 \
  --rtt 57,0 --rows cli --max-minutes 15 --label <branch>-10k

# re-print the critical-path, publication and counter-hold tables of a kept trace (--keep)
bun scripts/bench/managed-sync-catchup.ts --analyze <home>/sql-trace.jsonl

# pipelining spike: direct Postgres (prepare true/false) and transaction-mode PgBouncer
bun scripts/bench/managed-sync-pipeline-spike.ts --rtt 57
```

Rows run in sequence by default. Rows at 57 ms are latency-bound and
use almost no CPU, so they can run in parallel as separate
invocations, each with its own `--proxy-port` and `--keep` (one
toxiproxy proxy per port). Rows at ~0 ms are CPU-bound; run them
alone. The baseline used one invocation per 57 ms row in parallel,
then the ~0 ms rows in one sequential invocation.

Flags: `--files`, `--deletes` (already soft-deleted pages whose files
the backlog commit removes), `--history` (classic-mode pages present
before the backlog), `--receipt-history` (pages synced in managed mode
before the backlog, so the journal holds receipts), `--pad-words`
(page size), `--rtt` (comma-separated round-trip targets in ms, split
evenly across the two directions), `--rows`, `--max-minutes` (per-row
time box), `--stall-iterations` (consecutive CLI runs with no new
commit before a row stops, default 8), `--seed`, `--label`, `--out`,
`--database-url <admin url>` (use an existing server instead of the
Docker one; it needs `pg_stat_statements` preloaded for the server
totals), `--pg-port`, `--proxy-port`, `--api-port`, `--keep`.

The command works against any branch: it drives the real CLI
(`gbrain sync`, `gbrain sources writer claim/activate`,
`gbrain serve --http`), `performSync` and `submitPageMutation`, and it
reads `persistence_requests` and `op_checkpoints`.

## Method

- **Server and latency.** `pgvector/pgvector:pg16` with
  `shared_preload_libraries=pg_stat_statements`, behind
  `ghcr.io/shopify/toxiproxy:2.12.0` latency toxics (half the RTT
  upstream, half downstream). Each row records the measured proxy RTT,
  the median of 20 `SELECT 1` (59.4 to 60.2 ms for the 57 ms rows,
  0.3 to 0.5 ms for the ~0 ms rows).
- **Fresh brain per row.** Each row clones a database from a template
  that this checkout's `initSchema` built, with a temporary
  `GBRAIN_HOME`. In classic mode the bench adds source `bench` from a
  git repository and syncs it, then soft-deletes the `--deletes` pages.
  It claims and activates through the real `sources writer` CLI (same
  host, so the CLI host is the owner host, ENG-A9) and optionally syncs
  `--receipt-history` pages in managed mode. Then it commits the
  backlog: `--files` new pages, plus deletions of the soft-deleted
  files. The manifest therefore holds 34 already-soft-deleted deletes
  (published first) and N imports, as in the issue. Setup talks to
  Postgres directly; only the measured run goes through the proxy.
- **Drivers.** `cli` re-runs
  `gbrain sync --source bench --no-pull --no-embed --json` until it
  reports `synced`, exactly like the reporter's workaround, and keeps
  looping after a failed run. `reentry` keeps one process calling
  `performSync` with a 250 ms pause, like the PGLite delegate.
  `unmanaged` runs one classic sync of the same corpus. `serve` is
  `cli` with a resident `gbrain serve --http`. `effects` is `cli`
  without `--no-embed`, with a resident serve, against a loopback
  embeddings stub (200 ms per call, 4 concurrent, 429 beyond).
  `foreground` is `cli` with a second process submitting `put_page`
  once a second, after a 60 s idle foreground baseline. `all` runs
  `gbrain sync --all` over two sources. `newcomer` measures a cold
  `--progress-json` sync of a 5-page backlog to a search hit.
- **Trace (ENG-A15, CEO-A19).** Every gbrain process runs with
  `GBRAIN_SQL_TRACE=<file>` and a per-process
  `GBRAIN_SQL_TRACE_LABEL`. The hook (`src/core/sql-trace.ts`) wraps
  the postgres.js socket of all four pools, so `executeRaw`,
  `tx.unsafe`, the engine-sql adapter and the direct pool are covered.
  It writes one record per database round trip:
  - Sync/Query: one record per Sync or simple Query sent, closed by its
    ReadyForQuery reply.
  - Describe: one record for the describe Flush that an unprepared
    statement with parameters pays before it executes.
  - Connect: one record per new connection, covering TCP plus the
    startup handshake.

  Records carry statement text, never parameter values. When the
  variable is unset, the hook returns the pool options unchanged.
- **Reconciliation.** The bench resets `pg_stat_statements` for the
  row's database. It excludes its own monitoring statements (tagged
  `/* gbrain-bench */`) and transaction control, which
  `pg_stat_statements` does not count reliably. Traced executions then
  match the server totals within 0.0 to 2.1% on every row.
- **Locks (CEO-A4).** Every 100 ms, a separate admin connection samples
  `pg_stat_activity` joined to `pg_blocking_pids()` for the row's
  database. `application_name` (`gbrain:<label>:<pid>:<pool>`) names
  the process holding the lock.
- **Throughput.** Pages/min counts committed `managed_sync_import` and
  `managed_sync_delete` requests over the driver's wall time. Per-page
  wall time is the gap between consecutive commits.
  Admission→commit is `completed_at - created_at`. Both columns default
  to `now()`, which is the transaction start, so this figure leaves out
  the publication transaction itself (about 5 s at 57 ms). Time-boxed
  rows also report an extrapolation for the full backlog, labelled as
  one. `steady_state` adds the rate between the 10% and 90% committed
  marks, from commit times in the trace (each committed group
  publication counts one commit per member, any process; each committed
  single publication of a sync process counts one, except in rows with a
  foreground writer, where the sync process's consumer also publishes
  `put_page` writes the trace cannot tell apart), and the time from
  the first record of the first sync process to the first commit.
  `steady_state.db` is the same from `persistence_requests.completed_at`,
  with the first commit measured from the row's start.
- **Transaction classification.** The critical path and publication
  tables split each process's records into transactions per
  connection, whichever process or connection runs them. A group
  publication is a transaction with the set-based completion
  (`WITH m AS (SELECT * FROM unnest(...)) ... UPDATE persistence_requests r
  SET state='committed'`), or with a member attribution
  (`set_config('gbrain.write_request',...)`) and an `INSERT INTO pages` /
  `UPDATE pages` (a lane group rolled back before its completion). A
  single publication has the ownership guard, the counter lock and the
  single completion. Admission, recovery record, claim, waiver (a
  checkpoint write under a page guard), and cursor transactions follow.
  The full rules are in `RULES` in `managed-sync-catchup-phases.ts` and
  in each row's JSON.
- **Feeder (`trace.feeder`).** The sync process runs the sync loop and
  its consumer in one process, so its records are split by marker.
  Markers are statements only the sync loop sends: cursor, waiver and
  admission transactions, `op_checkpoints` reads, request lookups by
  `request_id`, the admit-ahead foreground check, and write-wait reads.
  A gap between markers that ends at a write-wait read is idle
  (`awaitWrite`); every other gap is producing. Loose reads in producing
  gaps are freeze and waiver-screen reads. Reads inside a consumer
  preparation span (the k-th claim chain's end to the k-th publication's
  begin) are reported apart as `overlapping_preparation`, because the
  screen and the consumer's preparation run the same helpers. A freeze
  sends one origin read, one page snapshot and one writer check, so the
  freeze/screen split is an estimate on that basis. Waves here are
  counted across connections. Each bucket reports statements, waves and
  describes per entry, per group and per page.
- **Lanes (`trace.lanes`).** Per group publication: apply time (begin
  to the commit-turn poll), turn wait (the trailing run of
  `SELECT state FROM persistence_requests WHERE ... request_id=$3`
  polls), completion, statements per page before the turn, and describes
  per group. Also the time-weighted number of open group publications
  while at least one is open, with its distribution.
- **Describes (`trace.describes`).** Describe round trips per
  connection over the run, by process, and per single publication.
- **Foreground spans (`foreground_*.spans`).** Each `put_page` is matched to
  the writer's transactions: writes in start order take admissions in
  order; a write's publication is the latest unassigned single
  publication before its reply, and its claim and recovery record are
  the latest before that. Spans: pre-admission, admission,
  admission+claim, preparation (claim to publication begin, including
  the recovery record), recovery record, publication, and visible
  (publication end to the reply). p50/p95 per span.
- **Open-loop foreground (`foreground-open`).** `cli` while a second
  process submits one `put_page` every `--fg-interval` seconds
  (default 5) for the whole run, whether or not earlier writes finished.
  `foreground_open` reports the arrival rate, most writes in flight,
  p50/p95, failures by code (`write_pending` included), spans, and the
  catch-up rate during the row. The closed-loop `foreground` row is
  unchanged.
- **Settings (`settings`).** `--pool-size N` sets `GBRAIN_POOL_SIZE`
  for every gbrain process; unset, the product default of 10 applies.
  Each row records the effective pool size and its source,
  `GBRAIN_SYNC_LANES` and `GBRAIN_SYNC_BULK` when set, the pooler, the
  most lanes observed busy, and `default_settings` (true only when
  nothing was overridden).
- **Pooler (`--pooler pgbouncer`, report-only).** A transaction-mode
  PgBouncer (`edoburu/pgbouncer`, pinned by digest, PgBouncer 1.26.0,
  `default_pool_size=50`, recreated each run) runs on loopback between toxiproxy and
  Postgres, so the RTT stays between gbrain and the pooler. gbrain runs
  with `GBRAIN_PREPARE=false`. Stock PgBouncer refuses the
  `statement_timeout` and `idle_in_transaction_session_timeout` startup
  parameters gbrain sends, so the pooler ignores them (listed in the
  row's `settings.pooler_detail.ignore_startup_parameters`): those session timeouts do
  not reach the server. Setup still talks to Postgres directly.
  `--pooler-port` picks the listener (default 55434).

## JSON schema (`gbrain.bench.managed-sync-catchup/v1`)

Top level: `schema`, `label`, `commit`, `started_at`, `finished_at`,
`params` (every flag), `host`, `rerun`, `rows[]`. Each throughput row
has:

| Field | Meaning |
|---|---|
| `row`, `rtt_target_ms`, `rtt_measured_ms`, `managed`, `backlog_entries`, `home`, `database` | Identity. |
| `done`, `timed_out`, `error`, `wall_s` | Outcome. A row that hits `--max-minutes` has `timed_out: true`. |
| `entries_committed`, `entries_noop`, `entries_waived` | Committed sync entries; `noop` = `outcome.noop`; `waived` is null until the waiver lands (Lane C should fill it from the run's counts). |
| `pages_per_min`, `extrapolated_full_backlog_h` | Throughput; the extrapolation is set only when the row did not finish. |
| `per_page_wall_ms` `{p50,p90,import_p50,delete_p50}` | Gaps between consecutive commits. |
| `admission_to_commit_ms` `{p50,p90,p99}` | From `persistence_requests` timestamps (see Method). |
| `requests_by_state` | `<kind>:<state>` counts admitted during the run. |
| `cli` | `invocations`, `wall_ms_p50/p90`, `pages_per_invocation`, `writer_pending_exits`, `first_stderr_ms_p50`, `e1_first_progress_ms`, `failed_runs` (failure code → count), `statuses`. |
| `trace.round_trips`, `round_trips_per_page`, `describe_round_trips`, `connections_opened`, `connect_ms_p50`, `db_ms_per_page` | All traced round trips, every process. |
| `trace.by_process` | Round trips, per page, ms and process count per process family (`cli-sync`, `reentry`, `serve`, `foreground`). |
| `trace.round_trips_by_class`, `trace.sync_process_by_class` | Per-page round trips by class, and the sync process's statement share by class (`consumer-background`, `wait-poll`, `txn-control`, `guards+counters`, `cursor`, `journal`, `page-data`, `connection-setup`, `other-control`; see `classify()` in the lib). |
| `trace.top_statements[]` | Normalized statement, count, total ms, per page, by process (describe round trips listed separately). |
| `trace.re_entry` | Per process: statements before the first admission, and ms from the first statement to the first admission. |
| `trace.errors` | `<process>:<SQLSTATE>` counts. |
| `trace.reconciliation_pct`, `pg_stat_statements_calls_ex_txn`, `traced_executions_ex_txn`, `pg_stat_statements` | ENG-A15 reconciliation and the server's top statements. |
| `guard_wait` | `page_write_guards ... FOR UPDATE` statement count, total, per page, p50, max. |
| `claims` | Claims, publications and unpublished releases (`writer_busy`) by process (CEO-A3 claim races). |
| `lock_waits` | Lock-wait samples (100 ms each), grouped by waiting statement, holder process and holder statement. |
| `db_size_bytes`, `db_growth_bytes_per_page`, `persistence_counters`, `capacity_headroom` | CEO-A25 growth and journal headroom vs the default limits, including the full backlog's projected reservation. |
| `cli_is_owner_host` | ENG-A9. |
| `foreground_idle`, `foreground_during_catchup` | `foreground` row: writes, p50/p95 ms, failures, lock_timeouts, failure codes (ENG-A5). |
| `effects_backlog_at_cli_exit`, `readiness`, `retrieval_ready`, `retrieval_ready_after_sync_s`, `embedding_stub` | `effects` row (CEO-A17, ENG-A18). Ready = no unembedded chunks for the source, no queued or running effects, no pending minion jobs, and no page with stale link extraction. |
| `trace.critical_path` | Sync-process phases (`publication (group)`, `publication (single)`, `freeze`, `admission`, `cursor`, `claim`, `prepare`, `wait`, `commit_gap`, `background`): occurrences, wall ms total and p50, statements, waves, describes, per page; `wave_check`; `rules`. |
| `trace.publication` | Group transactions: members, `fit` (waves and statements = fixed + per member), `steady_member_chain`, `first_member_chain`, `completion_per_member`, `per_page_publication_round_trips` / `_statements`, `counter_hold` (statements, waves, ms; from the counter row lock to commit), `by_members[]`, `transactions[]`, `rules`. |
| `effects`, `effects_backlog` | Effects per group and by kind (with `needs_worktree_lock`), and the queued/running backlog sampled every 2 s during the run. |
| `foreground_*.round_trips` | Per `put_page`: write transactions, their statements and waves, and the whole write window (p50, p95). |
| `e1_cold_start_to_first_progress_ms`, `e1_cold_start_to_first_stderr_ms`, `e1_wall_ms`, `newcomer_sync_runs`, `newcomer_to_search_hit_s`, `search_hit` | `newcomer` row (DX-A12). |

## Baseline (master `f4739fff`, v0.60.39.0, 2026-10-04)

Host: 4-vCPU Linux cloud machine, local Docker. 500-file rows have a
534-entry manifest (34 no-op deletes first, then 500 imports). Rows at
57 ms are time-boxed at 15 min and extrapolated; rows at ~0 ms ran to
completion. Raw JSON is not committed; rerun with the commands above.

| Row | RTT | Pages/min | Per-page p50 (import / delete) | Admission→commit p50 / p90 | Round trips per page | Notes |
|---|---|---|---|---|---|---|
| `cli` (reporter loop) | 57 | **3.4** | 15.5 s | 4.4 / 5.4 s | 487 | 52 runs, 1 page per run, every run exits `writer_pending`; full backlog ≈ 2.6 h |
| `reentry` (one process) | 57 | **4.2** | 11.7 s | 4.3 / 4.8 s | 682 | 73 passes, all `writer_pending`; full backlog ≈ 2.1 h |
| `unmanaged` | 57 | **50.9** | — | — | 77 | finished: 500 pages in 9.8 min |
| `serve` (resident serve) | 57 | 3.5 | 15.5 s | 4.4 / 5.4 s | 519 | serve claimed 4 of 52 pages |
| `effects` (stub embeddings + serve) | 57 | 3.3 | 16.5 s | 4.4 / 5.2 s | 561 | not retrieval-ready: links stay stale until the checkpoint |
| `foreground` | 57 | 2.3 | 23.7 s (27.0 / 23.6 s) | 14.6 / 15.8 s | 2137 | 15 of 73 runs failed `storage_error` (admission contention) |
| `all` (2 sources) | 57 | **0** | — | — | — | 89 runs over 15 min: 61 claims, 0 publications |
| `cli` 10k (300 words, 300 receipts) | 57 | 3.4 | 15.6 s | 4.4 / 5.4 s | 488 | **full backlog ≈ 49.3 h** |
| `cli` | ~0 | 350 | 131 ms (131 / 290 ms) | 38 / 46 ms | 387 | one run |
| `reentry` | ~0 | 345 | 131 ms | 38 / 47 ms | 387 | |
| `unmanaged` | ~0 | 4,711 | — | — | 77 | 6.4 s for 500 pages |
| `serve` | ~0 | 350 | 131 ms | 38 / 46 ms | 387 | serve claimed 0 of 534 |
| `effects` | ~0 | 349 | 131 ms | 38 / 45 ms | 472 | retrieval-ready when the sync ended |
| `foreground` | ~0 | 328 | 132 ms | 37 / 49 ms | 482 | foreground p95 254 → 244 ms |
| `all` (2 sources) | ~0 | 545 | 90 ms | 86 / 94 ms | 368 | |
| `cli` 10k | ~0 | 440 | 132 ms | 39 / 44 ms | 306 | 8,795 committed in a 20 min run, steady at 384 to 455 per minute; full backlog ≈ 23 min. The trace has no checkpoint or link-extraction phase, so it reads lower than the 500-file row. |

Readings from the table and the traces:

- **Network-bound (CEO-A26).** The same code runs 100x faster near
  the database (350 vs 3.4 pages/min). Until the fix ships, the
  workaround is to run the catch-up from a host near the database, or
  to loop `gbrain sync --source <id> --no-pull` until `synced`.
- **Drain loop (CEO-A2).** Re-entering in one process is 4.2 vs 3.4
  pages/min. That gain is the removed CLI start: 110 round trips and
  6.9 s from first statement to first admission per run, including 8
  connection handshakes of ~187 ms each. The drain loop is UX plus a
  ~25% gain, not the throughput lever.
- **Unmanaged (CEO-A6, CEO-A27).** Unmanaged sync is 15x managed at
  57 ms (50.9 vs 3.4) and 13x at ~0 ms. That crosses CEO-A27's 10x
  trigger, so the decision record below compares a worktree fence
  plus bulk import and reconcile.
- **No-op deletes.** At ~0 ms a no-op delete costs 2.2x an import
  (290 vs 131 ms). At 57 ms they cost about the same (23.6 vs 27.0 s
  in the foreground row). They are 34 of 10,034 entries at issue
  scale, so the waiver matters for correctness of the counts and for
  small backlogs, not for the 10k throughput.
- **Growth and headroom (CEO-A25).** Database growth is about 13 to
  21 KB per committed page (47 KB with embeddings); the 10k slice was too short to measure
  through autovacuum. Each request reserves 16,384 terminal bytes. A
  full 10,034-entry backlog reserves about 164 MB, about 10% of the
  default 1.5 GiB per-principal terminal budget and 4% of the
  per-principal lifetime IDs. Capacity is not a constraint.
- **Effects (CEO-A17, ENG-A18).** With a resident serve, embeddings
  keep pace with sync: 2 unembedded chunks when the last CLI run exited, 0 shortly after. Link
  extraction runs only after the checkpoint (`withLinks`), so a
  catch-up stays not retrieval-ready for links until the whole manifest
  commits. Without a resident consumer, the CLI leaves effects queued
  when it exits (a 20-file smoke run left 7 effects and 24 unembedded
  chunks pending for 10 min). This is the CEO-A3 effects backlog that
  the result must report with its drain command.
- **Newcomer and E1 (DX-A12).** Master prints no progress line before
  exiting. At 57 ms the first stderr line, the watchdog notice, arrives
  after 300 ms; the first run takes 21.6 s. The 5-page newcomer path
  needs 6 sync runs and 146 s to a search hit (3.9 s and 1 run at
  ~0 ms).

## CEO-A1: round-trip budget (baseline)

Budget: 150 pages/min is 400 ms per committed page. At 57 ms RTT
(59.6 ms measured) that allows **about 7 sequential round trips** per
page, end to end.

Measured sequential round trips per committed page, two ways:

1. **Wall time over RTT.** (per-page p50 at 57 ms − per-page p50 at
   ~0 ms) / RTT:
   - CLI loop: (15,529 − 131) / 59.6 = **258**.
   - Re-entry: (11,675 − 131) / 60.1 = **192**.
2. **Phase timing in the re-entry trace** (p50 over 65 pages):
   - admission → claim: 1.09 s = 18 RTT (the consumer's next tick and
     claim).
   - claim → `completeWrite`: 6.33 s = 105 RTT. This contains the
     publication transaction: 5.06 s, 77 to 83 round trips, 34 of them
     describes.
   - `completeWrite` → next admission: 4.13 s = 69 RTT (wait detection,
     cursor save, `writer_pending` return, re-entry prologue, freeze,
     screen, admission).
   - Total ≈ 192 RTT, matching the first method.

The baseline is 192 to 258 round trips per page, 27 to 37x the budget.
The publication transaction alone is 11x the budget. Even with every
describe round trip removed (about 43 left) and the counter and guard
locks set-based (ENG-A13: 12 counter and 9 guard statements become 4),
one page's publication stays well above 7 round trips. Pipelined
admission (2.2) is capped at one page per publication time, so at 57 ms
it cannot pass roughly 25 to 40 pages/min. Unless the post-diet
measurement shows publication at 400 ms or less per page (CEO-A9), the
rule selects 2.3 multi-page publication with set-based apply. The rule
re-runs on the post-Phase-1 and post-2.1 rows below.

## Top statements by round trips per committed page

`cli` at 57 ms, all processes, describe round trips included, per
committed page (487.5 total; 40% are describes):

| RT/page | of which describe | Statement |
|---|---|---|
| 59.8 | 29.9 | `SELECT * FROM persistence_requests WHERE id=$1::uuid` (waitForWrite poll, 50 ms) |
| 20.0 | 10.0 | `SELECT c.* FROM persistence_topology_changes c JOIN persistence_worktrees ...` (consumer topology recovery) |
| 17.3 | 0 | `SELECT set_config('gbrain.persistence_protocol','2',true)` |
| 16.0 | 8.0 | `INSERT INTO persistence_counters(key) VALUES ($1) ON CONFLICT DO NOTHING` |
| 16.0 | 8.0 | `SELECT * FROM persistence_counters WHERE key=$1 FOR UPDATE` |
| 15.0 / 15.0 | 0 | `begin` / `commit` |
| 12.0 | 6.0 | `SELECT r.* FROM persistence_requests r LEFT JOIN persistence_worktrees w ... state='queued'` (claim attempts) |
| 12.0 | 6.0 | `SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid` |
| 10.0 each | 5.0 | source/worktree binding join; `DISTINCT ON (local_path)` root scan; `EXISTS` claimable probe; recovery scan; projection-job scan; `WITH expired AS` claim expiry; worktree-refresh scan; two effects scans |
| 9.4 | 4.7 | `WITH chosen AS (SELECT p.* FROM pages p ...)` page snapshot |
| 8.0 | 4.0 | `SELECT completed_keys FROM op_checkpoints ...` cursor read |
| 8.0 + 8.0 | 0 | connection handshakes + postgres.js array-type probe (new process, 8 connections) |

Inside the publication transaction (re-entry at 57 ms, p50 77 round
trips per page, 34 describes, holding `persistence_counters` FOR
UPDATE for its whole 5 s):

- `persistence_counters`: 6 `INSERT ... ON CONFLICT` and 6 `SELECT ...
  FOR UPDATE`, 24 round trips with describes.
- Page lock trio, 2.9 times each: `INSERT INTO page_write_guards`,
  `SELECT ... page_write_guards ... FOR UPDATE` and `SELECT id FROM
  pages ... FOR UPDATE`, 17 round trips.
- 2.9 `sources FOR SHARE`, 2.5 + 1.9 page snapshots, 2.0 binding joins,
  2.0 `persistence_requests FOR UPDATE`, 2.0 + 3.5 `set_config`.
- One each of: the worktree, source, local-writer and brain
  `FOR SHARE` checks, the cursor check, the `source_path` read, the
  effects-bytes sum and `completeWrite`.

Re-entry prologue per `performSync` pass (ENG-A11): 58 round trips
(about 30 statements plus describes) and 1.9 s before the cursor read.
These are the brain and source mode probes, company-brain profile,
local-writer registration, binding and refresh checks and authority.
Hoisting them across passes saves them on every pass.

### The describe round trip

postgres.js sends every `sql.unsafe(text, params)` unprepared (its
`unsafe` default is `prepare: false`). An unprepared statement with
parameters is sent as Parse/Describe/Flush, waits for the parameter
types, then sends Bind/Execute/Sync. That is two round trips per
statement. `executeRaw`, `tx.unsafe` and the persistence layer all use
this path, so 40% of all round trips at 57 ms are describes
(10,277 of 25,340 in the `cli` row; 85,069 of 206,455 at ~0 ms).
Passing `prepare: true` where the connection allows it (not on a
transaction-mode PgBouncer), or sending explicit parameter types, would
roughly halve the round trips of every managed write. This lever is not
in the plan. It belongs in the 2.1 diet, and it also speeds up
foreground writes.

## CEO-A4: lock waits and the guard holder

The issue's 2.3 s `page_write_guards ... FOR UPDATE` wait did not
reproduce on a single host. Every guard statement took one round trip
(p50 59.7 ms, max 92 ms at 57 ms; max 3.8 ms at ~0 ms), with or
without a resident serve. The guard's cost is its count (about 9
guard-trio statements per page across screen, admission and
publication), not a wait. The reporter's 2.3 s is most likely the same
publication-lock queueing shown below, measured on a busier
deployment. That inference is not proven.

The lock waits that were sampled (100 ms samples):

- **Lease renewal behind its own publication (~0.75 s per page).**
  `cli` had 393 samples, `reentry` 476, `serve` 391 and 10k 400.
  92 to 99% of them are the consumer's claim-lease renewal
  (`UPDATE persistence_requests SET claim_expires_at=...`). It waits
  on the row lock that the same process's publication transaction
  holds on that request (holder states `idle in transaction` and
  `active`, statements `persistence_counters ... FOR UPDATE`, counter
  `INSERT`, `set_config`, timeline writes). The cost is self-contention
  and one blocked connection, not a cross-process holder.
- **Brain-wide `persistence_counters` lock (the real contention).** The
  publication transaction locks the brain counter row first and holds
  it for 77 round trips (5 s at 57 ms). Any other admission or
  publication with the default 1 s `lock_timeout` then fails `55P03`:
  - `foreground`: 30 `55P03` and 15 `57014` in the catch-up process,
    and 15 of 73 catch-up runs ended `storage_error` ("admission is
    temporarily blocked by database contention"). The foreground writer
    took 3 `55P03` that it retried internally.
  - `all`: two worktrees publish in parallel. One publication times out
    on the counter lock and releases its claim. The other publication
    is still running when the CLI's 5 s wait expires and the process
    exits. The next process re-claims after the lease lapses. The
    result is a livelock: 89 runs, 61 claims, **0 publications** in
    15 min.

This is ENG-A5's constraint, measured: no publication path can hold
the counter row across a multi-round-trip transaction at 57 ms. ENG-A13
(lock the counter last, set-based) and the group publish budget (ENG-A5)
are required for `--all` (CEO-A8) and for foreground fairness, not
optional.

## CEO-A3 / CEO-A29: the CLI's in-process consumer

- **Background share.** The consumer's background work (effects
  scans, projection jobs, topology recovery, root refresh, recovery and
  expiry scans, idle probes, receipt maintenance) is 22.1% of the
  sync process's statements at 57 ms (`cli`: 64 of 290 statements per
  page) and 33.5% in `reentry`. It is only 8.7% at ~0 ms, because the
  background loop runs on a timer, so its share grows with wall time
  per page. Waits add 10 to 11% (`wait-poll`) at 57 ms.
- **Not the lock holder.** The background work is not the sampled
  lock holder (see CEO-A4).
- **Gate.** CEO-A29's gate is ">= 20% of per-page statements or the
  guard-lock holder", and the 57 ms rows pass its first arm (22.1% CLI
  loop, 33.5% re-entry). At ~0 ms it fails (8.7%). Because these
  statements run concurrently with the critical path, removing them
  saves server load and pool connections more than sequential time.
  Phase 1 should re-measure their effect on pages/min before building
  publication-only mode.
- **Claim races (CEO-A3).** No row released a claim as `writer_busy`.
  An idle resident `serve` backs off and claimed only 4 of 52 pages at
  57 ms (0 of 534 at ~0 ms). An active second consumer (the
  `foreground` writer process) claimed 68 of 73 catch-up requests at
  57 ms, and the CLI's waiter still resolved by polling. Races cost
  nothing measurable, so no claim preference is needed (the 10% rule).
- **ENG-A9.** `cli_is_owner_host` is `true` in every managed row. The
  bench claims from the same `GBRAIN_HOME`, so the CLI host is the
  worktree owner host.

## Foreground writes during catch-up (ENG-A5, CEO-A23)

| RTT | Idle p50 / p95 | During catch-up p50 / p95 | Foreground failures | Catch-up failures |
|---|---|---|---|---|
| 57 ms | 19.1 / 19.7 s | 23.6 / 29.6 s | 0 (3 `55P03` retried) | 15 of 73 runs `storage_error`; 30 `55P03` and 15 `57014` |
| ~0 ms | 245 / 254 ms | 127 / 244 ms | 0 | 0 |

At 57 ms, a single `put_page` costs about 19 s even with no catch-up
running. Catch-up raises its p95 by about 10 s, against the release
constraint of ≤ 1 s. The catch-up itself loses runs to admission
contention.

## Decision-rule inputs (CEO-A1, CEO-A9, CEO-A27)

Round trips per committed page at 57 ms. Measured values are labelled
measured; everything else is an estimate from the traces above, to be
replaced by measured rows as each phase lands.

| Mechanism | RT per page | Pages/min at 57 ms | Basis |
|---|---|---|---|
| Today, CLI loop | 258 | 3.4 | measured |
| Today, one process (drain loop, Phase 1.1) | 192 | 4.2 | measured (`reentry`) |
| + no describe round trips (prepared or typed `executeRaw`) | ~115 | ~8 | estimate: 40% of round trips are describes |
| + 2.1 diet (set-based counters and guards, hoisted re-entry context, narrow waits) | ~70 to 90 | ~11 to 14 | estimate |
| 2.2 pipelined admission, K=25, one page per publication | ≥ 40 (publication only) | ≤ 25 | estimate: pipelining hides admission, not publication |
| 2.3 bulk publication, B=25, set-based apply | ~5 to 8 (≈ 80/B fixed + 2 to 4 per page) | ~125 to 200 | estimate; needs set-based apply and the ENG-A5 counter order |
| Worktree fence + bulk import + reconcile (CEO-A27 alternative) | ~20 sequential (77 traced, concurrent) | 50.9 | measured as unmanaged sync; leaves the journal, receipts and per-page effects to a reconcile pass |
| plpgsql publication function | — | — | rejected (CEO-A27): duplicates TypeScript publication logic and costs engine parity |

Recommendation for Phase 2, read from the rule: build 2.1, including
the describe fix and the counter-lock order. Then measure, and expect
the rule to select 2.3. Skip 2.2 unless post-2.1 publication is
400 ms or less per page.

## Results on the #5984 branch (v0.60.48.0)

Same bench, same 500-file backlog (534 entries), 57 ms rows time-boxed
at 15 min. "This branch" is one `gbrain sync` run, which now drains the
whole backlog; master is the reporter's CLI loop.

| Row | RTT | Master | This branch | Notes |
|---|---|---|---|---|
| `cli` | 57 ms | 3.4 pages/min | 13.1 pages/min (15.7 with a 30 s group budget) | default group budget 15 s |
| `cli` 10k files, 300-word pages, receipt history | 57 ms | 3.4 pages/min, ≈ 49 h | 15.7 pages/min, ≈ 10.7 h (30 s budget) | ship-gate row; ≈ 4.6x |
| `all`, two sources | 57 ms | 0 pages in 15 min | 16 pages/min | sources drain one at a time |
| `foreground`, a `put_page` every second | 57 ms | p95 19.7 s idle, 29.6 s during; 15 of 73 runs failed | p95 15.0 s idle, 15.7 s during; 0 failures, 0 lock timeouts | catch-up yields: 4.2 pages/min while writes keep arriving |
| `cli` | ~0 ms | 350 pages/min | 775 pages/min | |
| `reentry` | ~0 ms | 345 pages/min | 673 pages/min | |

Round trips per committed page (all processes, traced) fell from 258 to
about 155 to 180, and the per-page publication cost inside a bulk group
is about 40 round trips.

### What was built, and what the rule selected

1. **Phase 1.** The drain loop (one run catches up, with an outcome,
   `next`, progress and ETA), the no-op delete and import waivers, and
   classified waits with in-process completion handoff.
2. **2.1 round-trip diet.** Parameterized `executeRaw` statements are
   prepared (the describe round trip is gone wherever the connection
   allows prepared statements; PgBouncer transaction pooling is
   unchanged). Counter and multi-key page-guard locks are set-based.
   Postgres transactions remember the page guards they hold. Publication
   completes its locked request without relocking. Recovery cleanup is
   skipped when there was no recovery record. The protocol declaration,
   shared skillpack roots and the source-wide part of sync validation
   are read once per transaction.
3. **2.2 pipelined admission: skipped.** Post-diet publication still
   costs about 2 s per page at 57 ms, far above the 400 ms the rule
   requires (CEO-A9).
4. **2.3 bulk publication: built** (CEO-A1, ENG-A3/A4/A5). A draining
   sync freezes a group of up to 16 consecutive page imports and
   deletes, admits them in one transaction, and the writer publishes the
   group in one transaction. Each page keeps its own request row,
   receipt, authorization, attribution (the database stamps each page's
   own request) and effects. A failure rolls the group back; pages then
   publish singly, so the failure names its page and later pages are
   cancelled. Counters are locked after the members are applied, and no
   group forms while a foreground write is queued, so foreground writes
   stay within about 1 s of their idle p95.

### Shortfall against 150 pages/min

The branch reaches 13 to 16 pages/min at 57 ms, not 150. Inside a group,
each page still runs a chain of about 40 dependent statements (snapshot,
validation, apply, chunks, projections, effects, receipt), one after
another, because the database stamps each page's write with its own
request through transaction-local settings. Running members concurrently
inside one transaction would mix those stamps. Two mechanisms could reach
the target, and both need their own design approval:

- **Concurrent publication of independent pages,** each in its own
  transaction on its own connection, with ordering enforced at commit
  instead of by the per-worktree FIFO claim. Eight concurrent publishers
  at about 2 s per page would give roughly 200 pages/min at 57 ms.
- **Set-based apply** for a group (one statement per table for all of a
  group's pages), which removes the per-page chain.

The worktree fence + bulk import + reconcile alternative (CEO-A27) stays
unbuilt: it measures 51 pages/min as unmanaged sync but gives up
per-page receipts and effects during the import.

## Round-trip diet 2 (150 pages/min plan, Phases 0 and 1)

The 150 pages/min plan starts with a measured floor and a second
round-trip diet. The bench reports where the sync process spends its
time (`trace.critical_path`), what one bulk group costs
(`trace.publication`), the effects each group queues (`effects`,
`effects_backlog`) and the round trips of each foreground `put_page`
(`foreground_*.round_trips`). A **round trip** here is a wave: records
on one connection whose time spans overlap count once, so pipelined
statements count as one, and every describe counts as its own wave.
At 57 ms the wave count times the RTT matches the wall time (61 ms per
wave against a 59.5 ms proxy RTT). `--analyze <trace.jsonl>` prints the
same tables for a kept trace.

### Pipelining spike

`scripts/bench/managed-sync-pipeline-spike.ts` (57 ms, toxiproxy)
issues `tx.executeRaw` calls inside one gbrain `engine.transaction`
without awaiting between them, on direct Postgres and through
transaction-mode PgBouncer (`edoburu/pgbouncer`, `MAX_PREPARED_STATEMENTS=0`).
Wall times include `BEGIN` and `COMMIT`.

| Case | prepare=true | prepare=false | PgBouncer txn mode (prepare=false) |
|---|---|---|---|
| 2 dependent statements, awaited one by one (warm) | 2 round trips, 240 ms | 4, 358 ms | 4, 360 ms |
| same 2, issued without await (warm) | **1 round trip, 180 ms**; the read sees the write | 4, 359 ms | 4, 359 ms |
| 5 inserts without await (first one cold) | 5 round trips, ids in issue order | 12, 837 ms | 12, 837 ms |
| failure first, then 2 statements, without await | 1 round trip; `23505`, then `25P02`, `25P02` | `23505`, `25P02`, `25P02` | same |
| 3 unparameterized statements without await | 1 round trip | 1 | 1 |
| new statement text per call, without await | 6 round trips (3 describes) | 6 | 6 |

postgres.js pipelines statements issued back to back on the
transaction's connection and keeps their order, and after a failure the
first error is the real one while later statements fail with `25P02`.
Only statements already prepared on that connection pipeline: a
parameterized statement the connection has not prepared waits for its
describe round trip and holds back the statements behind it. With
`prepare: false` (and therefore under transaction-mode PgBouncer) every
parameterized statement pays a describe and an execute and nothing
pipelines; unparameterized statements still do. So the spike passes for
direct Postgres, which the gates below are measured on, and fails for
transaction-mode poolers, where the diet's statement cuts still apply
but pipelining gives nothing.

### What one page costs now

Each member of a bulk group reads its page twice: the **preimage**
under the page guard (identity, revision check, the version row on
update and delete) and the **postimage** after apply (read-back check,
projection target, text-projection seal, receipt revision, effects).
Configuration rows, the local writer and source membership are read
once per transaction (`transactionMemo`, `src/core/page-state/transactions.ts`).
The chunk insert binds its rows as one JSON document, so its text is
stable per brain and prepared; a complete replacement seals
`chunker_version` in the statement that also locks the page row. The
text projection is sealed once per page. Group completion is set-based
(`completeGroup`, `src/core/persistence/group-publish.ts`): each
member's queued effect bytes are read before the counters are locked,
then the counter lock and one `UPDATE persistence_requests ... FROM
unnest(...) RETURNING` that checks every member's claim and terminal
reservation are pipelined, and a short `RETURNING` rolls the group back
to the single path, where `completeWrite` gives each member its own
code.

Statements of the steady member chain after the diet (a page import,
bench fixture), by dependency:

| Statements | Depends on | Sent |
|---|---|---|
| attribution `set_config` | member boundary | alone (never pipelined across) |
| `savepoint`, page `INSERT`/`UPDATE`, contextual-retrieval `UPDATE`, chunk `DELETE` | nothing returned earlier (independent) | one by one: engine calls with their own savepoint |
| chunker seal `UPDATE ... RETURNING id` | nothing (produces the page id) | alone |
| chunk `INSERT` | page id (data-dependent) | alone |
| alias `savepoint` + `DELETE` | independent | one by one (savepoint) |
| `source_path` repair | independent | alone |
| postimage read | must follow every page write (produces id, revision, timeline) | alone |
| facts expiry, take collision check, take delete, timeline delete/inserts/refresh | postimage page id; independent of each other | **one pipeline** (`insertFacts`/`addTakesBatch` end it) |
| text-projection seal, hold check, import provenance | postimage; independent of each other | **one pipeline** |
| chronicle check (effects) | postimage | alone |
| next member's preimage | must precede its validation and apply | alone |
| sync-origin check (validation) | independent | alone |

### Effects per group

With `--no-embed` (the `cli` rows) a database-only group queues no
effects: the embedding is deferred and no file is written. Without it,
each live page queues one `embedding` effect, which does not take the
worktree lock; `git` effects, which do, come only from file-backed
writes (each foreground `put_page` queues `embedding` + `git`). The
effects backlog during the catch-up stayed at 0 to 2.

### Before and after

Master `6622a119` (v0.60.48.0) against this diet, same host and bench
(500 files, 34 no-op deletes, 57 ms rows time-boxed at 10 min):

| Measure | Master | Diet | Gate |
|---|---|---|---|
| Per-page publication, round trips (describes counted), 57 ms | 48.1 (42 statements) | **16.7** (23 statements) | ≤ 22 with pipelining (≤ 24 without): pass, −65% |
| Per-page publication, ~0 ms | 44.7 (43 statements) | 17.6 (24 statements) | pass |
| Counter hold, lock to commit | 12 round trips p50, 20 max (3 + 3 statements per member; 0.72 s at 57 ms) | **2 p50**, 5 max (3 statements for any group size; 0.12 s) | ≤ 3 with pipelining: pass at p50; the max is a connection that has not prepared the two statements yet (2 describes), within the 5-round-trip bound without pipelining |
| `cli` pages/min, 57 ms (10 min) | 10.6 | **24.5** | measured (2.3x) |
| `cli` pages/min, ~0 ms (3 runs) | 496 (493 to 512) | 504 (471 to 530) | not regressed |
| Idle foreground `put_page` round trips, 57 ms (3 runs, 15 writes) | 151 p50, 166 p95 (102 statements) | **146 p50, 156 p95** (99 statements) | no worse: pass |
| Idle foreground `put_page` wall, 57 ms (median of run p50 / p95) | 12.6 s / 15.4 s | 12.8 s / 15.0 s | within noise (+1% p50, −3% p95) |
| Foreground during catch-up, 57 ms | p95 22.2 s, 1 failure | p95 14.7 s, 0 failures, 0 lock timeouts | |

A warm foreground publication transaction is 61 statements with no
describe (master: 66 with 2). Golden SQL (regenerated only for the chunk
insert and the export surface), attribution and engine-parity suites pass
on both engines.

Per-phase critical path of the sync process, 57 ms `cli` row (p50 per
occurrence; the group size adapts to the 15 s budget, so groups grew
from 3 to 7 to 9 pages):

| Phase | Master wall / waves | Diet wall / waves |
|---|---|---|
| publication transaction | 9.3 s / 155 (3 pages) | 10.8 s / 179 (9 pages) |
| freeze | 0.66 s / 12 | 1.08 s / 30 |
| admission | 1.14 s / 19 | 1.02 s / 17 |
| cursor save | 0.36 s / 6 | 0.36 s / 6 |
| claim | 0.30 s / 5 | 0.30 s / 5 |
| prepare | 1.15 s / 48 | 2.33 s / 126 |
| gap between group commits | 14.4 s | 18.1 s |

Per committed page the diet's sync process spends 21.6 publication
waves (master: 54.3), 16.2 prepare, 5.2 cursor, 4.6 freeze, 2.5
admission and 1.4 claim waves. Between two group commits about 7 s is
freeze, admission, cursor saves, claim and prepare, all strictly after
the previous commit; that is the gap Phase 1.5 (the cursor window)
targets.

## Admit-ahead (150 pages/min plan, Phase 1.5)

While a bulk group publishes, the drain freezes and admits the next group
and records it in the cursor's `window` (`src/core/persistence/sync-window.ts`).
The per-worktree FIFO claim is unchanged: the window group waits queued
behind the publishing group, and the consumer claims it as soon as that
group commits. Window members name the previous group's last request
(`intent.after`); the consumer cancels a window group whose predecessor
did not commit, publication re-checks the predecessor, and the drain
cancels the window after a failed page, so no page publishes after an
earlier page of the same sync failed. Publication reads the cursor
`FOR KEY SHARE` and accepts `pending`, `group` and `window` members, so
the drain's cursor saves no longer wait for the publishing group (the
`FOR SHARE` read they used to wait on would have serialized admit-ahead
behind publication). Nothing is admitted ahead while foreground writes
are recent (one was queued on the worktree in the last minute).

Same host and bench as the diet table above, 57 ms rows time-boxed at
10 min (the 10k row at 15 min):

| Measure | Master `6622a119` | Admit-ahead only | Diet only | Diet + admit-ahead |
|---|---|---|---|---|
| `cli` pages/min, 57 ms | 10.6 | 13.4 | 24.5 | **28.8** |
| Gap between group publications, 57 ms (p50) | about 5.6 s | 2.2 s | about 7 s | 3.7 s (claim + prepare of an 8 to 9 page group) |
| Pages per group (steady state) | 3 to 4 | 4 | 7 to 9 | 8 to 9 |
| `cli` 10k files, 300-word pages, 300 receipts, 57 ms | 3.4 pages/min on v0.60.39 (about 49 h); 15.7 on v0.60.48 (about 10.7 h) | | | **30.9 pages/min, about 5.4 h** |
| `cli` pages/min, ~0 ms | 527 | 514 | 504 (3-run median) | 545 |
| Foreground `put_page` p95 at 57 ms, idle / during catch-up | 15.5 s / 18.2 s, 0 failures | 15.3 s / 17.7 s, 0 failures | 15.0 s / 14.7 s, 0 failures | **14.9 s / 15.1 s, 0 failures, 0 lock timeouts** |
| Catch-up while a `put_page` arrives every second, 57 ms | 3.9 pages/min | 3.8 | | 4.4 |

The foreground idle figure comes from 5 writes per run, so single-run p95
values carry about ±1 s of noise; master on this host shows the same
during-catch-up excess as admit-ahead alone.

Per-phase critical path with both changes (57 ms `cli` row, p50 per
occurrence): publication 10.9 s (180 waves, 21.8 per page), prepare 2.5 s
(144 waves, 17.7 per page), freeze 1.2 s, admission 1.1 s, claim 0.36 s,
cursor save 0.37 s. Freeze and admission of the next group now overlap the
publishing group; claim and prepare still run strictly between two group
commits (15.0 s from commit to commit, p50).

### Against the 150 pages/min target

With both changes one sync catches up at about 29 to 31 pages/min at 57 ms
(about 2.7 times master, about 5.4 h for the 10k backlog). The plan's
forecast for these phases was 36 to 40; the difference is prepare, which
grew with group size (17.7 waves per page) and still sits between commits.
Reaching 150 needs parallel publication (Phase 2, lanes), which waits for
the owner's decision. A cheaper step that stays single-lane is to prepare
the window group's members while the current group publishes (prepare is
read-only and its results are re-validated in the publication
transaction); at the measured costs that would remove about 2.5 s of the
15 s cycle, for roughly 33 to 35 pages/min.

## Parallel lanes (150 pages/min plan, Phase 2)

Up to six bulk groups of one draining managed sync publish at once, each in
its own transaction on its own connection, and commit in manifest order
(`src/core/persistence/sync-lanes.ts`, `worktree-lease.ts`). The drain keeps
twice the lane count of groups admitted ahead. Same host and bench as the
tables above; the 57 ms `cli` rows ran on 1,500 files (time-boxed at 10 min)
so the steady state is visible past the startup, and the 10k row ran for
15 min.

**Steady state** is pages committed between the first and the last group
commit of the run, from the SQL trace. **Wall** is the bench's committed pages
over the whole run, including about 80 s of startup (discovery and the 34
already-deleted files handled one at a time before any group forms).

| Row, 57 ms | Steady state | Wall | Lanes in use (seconds at 1 / 2 / 3 / 4 / 5 / 6) |
|---|---|---|---|
| v0.60.58.0 (one group at a time), 500 files | 28.8 to 30.9 | 28.8 | n/a |
| 4 lanes, 1,500 files | 137.9 | 115.8 | 57 / 60 / 76 / 286 / - / - |
| 6 lanes, 1,500 files | 149.9 | 123.9 | 49 / 70 / 132 / 83 / 48 / 88 |
| 6 lanes (default), 10k files, 300-word pages, 300 receipts | **152.8** | **137.4**, full backlog about 1.2 h | 99 / 123 / 169 / 120 / 80 / 166 |
| 6 lanes, ~0 ms, 500 files | | 740.6 (master on this host: 527) | |

| Foreground `put_page` at 57 ms, a write every second | Idle p50 / p95 | During catch-up p50 / p95 | Failures |
|---|---|---|---|
| v0.60.58.0 | 12.4 / 14.9 s | 11.6 / 15.1 s | 0 |
| 6 lanes | 11.8 / 14.1 s | 11.3 / 15.8 s | 0 |

The idle figure comes from 5 writes per run, so single-run p95 values carry
about ±1 s of noise. Catch-up while a write arrives every second runs at 4.5
pages/min (v0.60.58.0: 4.4): nothing is admitted ahead while foreground writes
are recent.

A group of about 14 pages takes 19.8 s to publish (p50) whether or not other
lanes run, so lanes add throughput without slowing a group. Three things
first had to change for lanes to overlap at all, each found in a trace:
publication validation refused a lane group whose predecessor had not
committed yet, waiting lanes and a lease that stopped taking holders after
its turn deadlocked until the 60 s order timeout, and a lane whose
predecessor's admission had failed was cancelled instead of released. The
lane tests and the failure probes in `test/managed-sync-lanes.test.ts` pin
all three.

What is left between the steady state and the wall figure is the startup:
discovery and already-deleted files run one at a time before the first
group. At 57 ms that is about 80 s for this corpus, which is why the wall
rate of a short backlog stays below 150 even when the lanes run at it.

## Feeder, lanes to 16 and foreground priority (lanes/startup/foreground plan)

Before and after on Ubicloud `standard-16` VMs (Ubuntu 24.04, Postgres in
Docker, toxiproxy at 57 ms), default settings unless a row says otherwise:
master `a865f8f8` against the branch at `0ba3b1f7c` (G4's lane means are from
`d00f4d035`, the same lane code). The 57 ms `cli` rows ran on 1,500 files
time-boxed at 10 min (8 min for the lane sweep); the 10k row ran to
completion. **Steady** is pages/min between the 10% and 90% commits; **first
commit** is from the sync process's first statement. G7 is the open-loop row:
one `put_page` every 5 s for the whole run, whether or not the last one
finished. G6 is the closed-loop row (next write when the last returns, 1 s
floor).

| Gate | Master | Branch | Target | Result |
|---|---|---|---|---|
| G1 steady, 10k corpus | 174.8 | 367.9 | >= 300 | met |
| G2 10k backlog wall | 74.5 min | 33.6 min | <= 40 min | met |
| G3 first commit, 1,500 files (34 waived first) | 78.9 s | 18.4 s | <= 15 s | missed |
| G4 steady at 4 / 6 / 8 / 12 / 16 lanes, pool 20 | falls past 6 | 333.5 / 369.4 / 399.9 / 406.6 / 408.5 (8 to 16: mean of 3 runs) | non-decreasing within the 6-lane spread | met |
| G5 `put_page` idle p50 / p95 | 8.6 / 11.6 s | 2.46 / 2.72 s | <= 3 / 4 s | met |
| G6 `put_page` during catch-up p95, closed loop | 17.1 s | 4.06 s (idle 2.59 s), 0 of 184 failed | <= idle + 1 s (provisional) | missed (idle + 1.5 s) |
| G7 catch-up while a write arrives every 5 s, open loop | 0.4 (115 of 120 writes failed) | 174.4 (45% of idle 391.1), 0 of 120 failed; writes p50 / p95 3.5 / 21.9 s | >= 50% of idle | missed |
| G8 steady at ~0 ms | 2,404 | 3,332 | >= 700 | met |

The three repeated default (6-lane) runs gave 381.3, 378.9 and 374.5 pages/min.
The 8, 12 and 16 lane rows ran three times each: 418.1 / 384.8 / 396.9, 418.8 /
392.5 / 408.4 and 409.3 / 398.5 / 417.6. Runs at one lane count spread by about
30 pages/min, and the means rise with the lane count. A single sweep at
`0ba3b1f7c` gave 334.2 / 388.7 / 395.7 / 415.5 / 371.9 for 4 / 6 / 8 / 12 / 16;
its 16-lane run sits inside the spread of single runs but below 12, and was not
repeated.

An earlier open-loop run at `e2656589d` measured G7 at 204.2 pages/min (53% of
idle 385), writes p50 / p95 3.2 / 14.6 s; the code between it and `0ba3b1f7c`
changed startup only. One run at each head is not enough to tell a regression
from run-to-run spread, so G7 is recorded from the final run.

**G3.** Of the 18 s before the first commit, about 3.9 s is startup reads, 3.9
s the 34 waived deletions (screened four at a time, then one waiver
transaction), 3.2 s the first group's waiver and admission, about 3 s its claim
and preparation and 3.3 s its publication. Each is a serial chain of round
trips; about 2 s of it is first-use statement descriptions, which a
cross-process description cache in the driver would remove.

**G6 and G7.** A foreground write that names no queued or running group's page
now publishes beside running lane groups in the sync process, instead of
waiting for them and holding new groups back. On the open-loop row master
catches up at 0.4 pages/min with 115 of 120 writes failing; the branch runs at
174 to 204 pages/min with none failing. The remaining tail is
writes in the drain's first minute waiting on the brain-wide persistence
counters that every lane group also updates.

**Admit-ahead fix.** Before `d00f4d035`, admit-ahead asked for more requests
at once than the writer's outstanding-request limit (100) allowed whenever
groups were large (16 pages at ~0 ms) or lanes were many (8+); the admission
was refused and lanes ran one at a time. The sweep at `4004f1f2f` shows it:
8 / 12 / 16 lanes at 88.1 / 69.2 / 56.5 pages/min. Now the batch takes only the
room left after the cursor's next group and a reserve of 10.

## Startup reads, lock scope and a held claim (follow-up wave)

Three runs per head on Ubicloud `standard-16` VMs at 57 ms, default settings,
1,500 files with 34 waived deletions first: master `b5f12b12e` (v0.60.117.0)
against this wave at `d6d9d5956`. G6 and G7 are judged on the mean of three
runs per head from here on, because single runs of the open-loop row spread by
more than the gate's margin.

| Gate | Master | This wave | Target | Result |
|---|---|---|---|---|
| G3 first commit | 19.0 / 19.3 / 19.6 s | 15.6 / 15.6 / 15.5 s | <= 15 s | missed by 0.5 s |
| G6 `put_page` p95 during catch-up, over idle | +0.52 / +0.59 / +2.28 s, 1 failed write | +0.52 / +0.52 / +0.77 s, none failed | <= idle + 1 s | met |
| G7 catch-up while a write arrives every 5 s | 65.1 / 60.9 / 63.4% | 55.4 / 64.4 / 60.1% | >= 50% of idle | met |
| Idle steady pages/min | 374 / 379 / 370 | 392 / 370 / 393 | no regression | held |

**G7 correction.** The v0.60.111.0 row above (45%, from one run) was low
against every later run of the same code: three more runs at `9d013e52d`
measured 60.6, 63.2 and 62.3%, and master has stayed between 57 and 71% since.
G7 is met.

**G3.** Three changes take 3.7 s off the first commit. Described parameter
types are saved for the next process (about 40 fewer describe round trips per
run; a statement only the catch-up runs still describes on its first run, which
is why a brain's second catch-up starts faster than the bench's first). A
waiver run's screen reuses the page snapshot and authority check its freeze
just made instead of repeating them for each entry, and each freeze reads the
page beside its origin check. The remaining 15.5 s is serial: about 4 s of
startup reads, 2.5 s of screening the 34 waived entries four at a time, 1.3 s
for their waiver transaction and about 6 s for the first group.

**G6.** Two lock waits are gone. Claiming a lane group's followers locked up
to 63 rows after the group, including the next foreground write's row, for the
claim's round trips; it now locks only the members (lock-wait samples per run
from about 190 to 84). And a foreground write the writer's own process had
claimed, but could not publish while the sync's lanes held the worktree, did
not hold back new lane heads, so groups kept starting ahead of it until it was
handed back. Master's +2.28 s run (one write not committed within its wait)
fits that case, but its bench output does not name the cause; the forced test
in `test/managed-sync-foreground-priority.test.ts` reproduces the held claim.
