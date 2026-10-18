# Managed-sync `preparing` wedge through a transaction-mode pooler: Phase 0 reproduction record (#6317, #6278)

Phase 0 of the GBRA-61 plan for #6317 started from the reporter's two
comments of 2026-10-08 15:15Z and 15:25Z on #6278: sixteen
`managed_sync_import` members of one bulk group in `state='running'` /
`claim_phase.phase='preparing'` for 25+ minutes on 0.60.110.0 while the
lease renewed, `pg_stat_activity` showed no statement older than about 3 s,
the same rows prepared in 2.6–3.4 s from a scratch process, and every wedge
had two persistence consumers on the host (`gbrain serve --http` plus the
one inside `gbrain sync`). The brief was to build that two-process shape on
Ubicloud, name the await, test the candidate causes and record what this
branch's preparation budget does to it. Halfway through, the reporter's
17:09Z comment reframed the cause: the wedge reproduces with one process,
`--no-lanes` and no serve; the differentiator is the pooler mode
(Supavisor :6543 transaction mode wedges, the :5432 session URL drains),
and the live signature is a backend `active` / `wait_event=ClientRead` for
minutes on the consumer's `expired_claims` CTE with the consumer logging
`phase=expired_claims reason=deadline_exceeded` and staying parked. This
page records both halves: the mechanism first, then the two-consumer arms
as what they turned out to be, a multiplier of pooled round trips, not the
mechanism.

The harness is the #6278 one extended, not a new script:
`scripts/bench/managed-sync-stall-repro.ts` gained `--scenario two-consumer`
(a seeding lane drain killed mid-run, a `gbrain serve --http` consumer, a
`gbrain sync` consumer `--gap-seconds` later, CLI SIGTERM/restart on a
cadence, a wedge rule with dumps on detection, `--direct-pool` for the
dual-pool topology, `--inspect`) and `--chaos-kind partition` (iptables
drops the client→pooler half of every gbrain connection, never closes it,
and lifts it after `--chaos-for`). `scripts/bench/stall-debug-instrument.py`
(debug only, applied on the VM, never committed) now also records every raw
statement, transaction checkout and reserve between its send in JS and its
settle (a statement that is in JS but not in `pg_stat_activity` is one that
never reached the server or is waiting for a connection), the postgres.js
pool queues per pool, the consumer's head-order / follower-claim /
wave-dispatch marks, and a forced never-settling preparation
(`--hang-after N`), which this page did not need in the end. Captures live
under `.context/bench/*/` on the two VMs (`UBI_OWNER=gbra61`, destroyed
after the runs) and were copied to `~/.capy/work/gbra61/phase0/` on the
GBRA-61 machine; every number below comes from those captures.

## Verdict

- **The mechanism reproduces on demand, on 0.60.110 and on this branch, with
  one process and no lanes.** Drop the client→pooler half of the sync's
  connections (PgBouncer transaction mode, 57 ms RTT, `iptables … -j DROP`,
  the socket stays open) and within one sample the process shows exactly
  the reporter's live capture: a backend `active` / `wait_event=ClientRead`
  on a statement whose extended-protocol exchange never completes
  (0.60.110: `UPDATE timeline_entries …` of the publication transaction,
  `query_age` 136 s, `xact_age` 146 s), the rest of the backends `idle` /
  `ClientRead` with their last statement 135–147 s old, the consumer's own
  `WITH expired AS (…) UPDATE …` round trip parked in JS for 135 s with
  `status().phase = { name: 'expired_claims', deadline_exceeded: true }`
  still current 134 s after it started (this branch) and
  `[persistence] phase=expired_claims reason=deadline_exceeded` /
  `phase=refresh_roots reason=deadline_exceeded` on stderr, the group's
  lease renewal (`UPDATE persistence_requests r SET claim_expires_at=…`)
  parked 127–130 s so the claims lapsed, the drain's `awaitWrite` poll
  (`SELECT * FROM persistence_requests WHERE id=ANY($1)`) parked 109–177 s,
  zero committed pages, the process at 3.6–4.9 % CPU. `statement_timeout`
  cannot end a backend that is waiting for the client, and the 5 s phase
  deadline fires `abort()` but nothing settles: the awaits sit on sockets,
  not on the pool (every dump had the pool's `open` or `connecting` queues
  non-empty while the statements were parked).
- **The await that hangs is postgres.js's query promise in
  `PostgresEngine.runUnsafe`** (`src/core/postgres-engine.ts:2733-2734`,
  `pending = conn.unsafe(…); return await pending`), reached from the
  consumer's `phase('expired_claims', …)` (`consumer.ts:468`, through
  `phase()`'s `return await phaseScope.run(…)` at `consumer.ts:618`), from
  `renewGroupClaims` (`journal.ts:352`), from the drain's progress poll
  (`service.ts:249`, `getWriteRequestProgress`) and from every statement of
  `publishGroup`'s transaction (`group-publish.ts:238`). Why `abort()`
  cannot end it: `onAbort` calls `pending.cancel()`
  (`postgres-engine.ts:2744`); the vendored driver's `cancelActive`
  (`vendor/postgres/src/index.js:463`) opens a cancel connection, sends
  CancelRequest and then re-sends it every 50 ms → 1 s for as long as the
  query stays active, resolving only once the query settles; a backend in
  `ClientRead` is not executing, so the cancel is a no-op and the loop runs
  forever (the steady trickle of new cancel connections is the 5–20 % CPU
  the reporter saw); and the `owner.discard()` that would destroy the socket
  sits in `runUnsafe`'s `finally`, which runs only after the parked `await
  pending` settles. GBRA-59's PR 1.5 (bounded client-side settle in
  `runUnsafe`: cancel, then destroy the reserved connection after ~2 s; the
  same for `executeRawDirect` renewals) is the fix for this seam and is not
  duplicated here.
- **The preparation budget does not cover this class, as expected.** On
  this branch (532d1145, VERSION 0.60.112.0) the partition parked a
  16-member group at step `publish:transaction` for 166 s and the consumer's
  tick in `expired_claims`; `status()` reported `abandoned_preparations: 0`,
  `outlived_ceiling: []`, `preparation_attempts: 0`, `restart_required:
  false`, no member was released `preparation_deadline` and nothing was
  finished `preparation_stalled`, because `startPreparation` races only
  `run.prepare`, and none of the parked awaits is inside a preparer. The
  progress line did name the phase (`stalled 269s on publishing`). Only the
  network recovering (the drop lifted after 240 s, TCP retransmitted the
  lost segments) ended the wedge: the group committed within 41 s of the
  lift (298 → 330), after which the pass exited `database_error … connect
  ECONNREFUSED` on its next connection (the harness proxy under the burst of
  retransmitted SYNs and queued cancel connections, which the drain did not
  retry) on both builds; in the earlier manual run on 0.60.110 the drain
  resumed on its own 45 s after the lift (89 → 91, next group running).
- **Two consumers are a multiplier, not the mechanism.** 2 h 49 min of the
  reporter's two-process shape on 0.60.110 (three arms: plain; adoption
  load plus CLI restarts every 10 min; dual pool plus restarts every 15 min)
  published 4,951 pages with no `preparing` claim older than 25 s and no
  server-side statement older than 11.5 s; serve claimed 18 FIFO heads
  beside the CLI's 456 lane and FIFO claims and published every one. The one
  cross-process effect observed is bounded: a serve-held group's exclusive
  worktree lock makes the CLI's lane transactions wait in `awaitLaneTurn`
  (`idle in transaction`, up to 60 s) and roll back. A second consumer
  simply doubles the pooled round trips a dropped exchange can park, and
  with a group memo (`preparationReads`, `groupReads`) or a group
  transaction, one parked round trip parks every member of the group, which
  is how sixteen members show the same `preparing` age.
- **Preregistered reading for `persistence.single_consumer`: ship it OFF.**
  The single-process arm wedges (the reporter's 17:09Z capture; runs E2, F2
  and F below), so refusing or delegating the second consumer does not
  address the mechanism; it stays a default-off operational switch until the
  bounded settle has shipped and the two-consumer shape has been measured
  against it.

## The mechanism: timeline and captures

Topology for every mechanism run: 16-vCPU `standard-16`, pgvector/pg16 in
Docker, PgBouncer 1.26 transaction mode (`statement_timeout` dropped at the
pooler: `SHOW statement_timeout` = `0` via the pooler, `5min` direct),
toxiproxy with 57 ms round trip in front of the pooler, `GBRAIN_PREPARE=false`,
`GBRAIN_POOL_SIZE=10`, `GBRAIN_SYNC_LANES=1`, a 3,000-page backlog on a
300-page history source, one non-TTY `timeout 3600 gbrain sync --source
bench --no-pull --no-embed`, 10 s samples, `--stall-minutes 2`, SIGUSR2 dumps
on the stall.

### Run E2 (0.60.110, 1935c74a, manual partition; `E2-110/`)

| time (UTC) | event | what the captures show |
|---|---|---|
| 17:49:51 | pass starts | single path, 7.2–8.2 pages/min (the reporter's 7–19/min bracket) |
| 17:51:51–17:51:54 | toxiproxy `timeout` toxic, upstream, toxicity 1, 3 s | PgBouncer sees a truncated exchange and closes: `phase=expired_claims reason=storage_error write CONNECTION_CLOSED`, `phase=execution … CONNECT_TIMEOUT`; the pass recovers. A pooler that parses packets fails loud; the reporter's did not. |
| 17:55:48 | `iptables -I OUTPUT -p tcp --sport 55466 --dport 55433 -j DROP` (one connection) | 17:56:35: one `SELECT EXISTS (… persistence_requests …)` (`hasClaimableWrite`, reserved connection) parked 44 s in JS; the tick's other probes kept completing (278 in the window on two other connections), so one dead connection parks one caller, not the process |
| 18:02:34 | `iptables -I OUTPUT -p tcp --dport 55433 -j DROP` (every connection) | 18:04:51 stall rule (140 s without a commit); `stall-1.json`: backend 96 `active` / `ClientRead`, `DELETE FROM page_aliases …`, `query_age` 138 s, `xact_age` 142 s; nine backends `idle` / `ClientRead` 136–177 s; JS: `DELETE FROM page_aliases` parked 164 s in the publication transaction, the drain's `SELECT * FROM persistence_requests WHERE id=ANY($1)` parked 137 s, renewal parked, `claim_lapsed: true`, `since_update_ms` 144,490; consumer phase `refresh_roots` `deadline_exceeded`, then `storage_error aborted` / `read ECONNRESET` every tick; pool `connecting: 9`, `full: 1`, `open: 0`; process 4.1 % CPU; `pg_locks`: nothing waiting |
| 18:05:45 | drop lifted | 18:06:04 `writer status --json` (the first one that could run): the running member `assessment: stalled, reason: cause_unknown, next_action: inspect_owner`, claim `publication_transaction` (lapsed), the reporter's wording; 18:06:29: committed 89 → 91, a new group of 16 running: the parked statements completed through TCP retransmission and the drain resumed on its own |

### Run F2 (0.60.110, 1935c74a, `--chaos-kind partition --chaos-at 3 --chaos-for 240`; `F2-110/`)

Pass start 18:14:38; drop 18:17:38–18:21:39; stall rule 18:19:53 (140 s);
`stall-1.json` at 18:19:55: backend 98 `active` / `ClientRead` on `UPDATE
timeline_entries t SET detail=r.next FROM jsonb_to_recordset(…)`,
`query_age` 136,379 ms, `xact_age` 146,499 ms; backend 99 `idle` /
`ClientRead` with `WITH expired AS (…)` 136,684 ms old; six more backends
idle on `config` reads and `commit` 135–147 s old. SIGUSR2 dump at
18:19:53: three members (`cffd8b36`, `5ee41838`, `8a61df03`) at step
`publish:transaction` for 145,020 ms; `sql_inflight`: `UPDATE
timeline_entries` (tx) 135,270 ms, `SELECT brain_id,enabled,… FROM
persistence_brain` (reserved) 134,585 ms, the renewal `UPDATE
persistence_requests r SET claim_expires_at=…` (reserved) 127,164 ms, the
drain poll `SELECT * FROM persistence_requests WHERE id=ANY($1)` 114,534 ms;
pool `max 10: open 0, busy 0, full 2, reserved 1`; consumer phase
`refresh_roots` started 18:17:39, `deadline_exceeded: true`, attempt 689,
still current 134 s later; stderr: 12 × `phase=refresh_roots
reason=deadline_exceeded`, 11 × `reason=storage_error message="aborted"`;
`claim_phase.phase = publishing` on all three rows with `claim_lapsed:
true`, `since_update_ms` 138,641; the sampler's own `gbrain sources writer
status --probe --json` hung through the same pooler and was killed at
120 s (exit 143), so during the wedge the one command meant to explain it
cannot run; 3.6 % CPU. After the lift the three members
committed (30 → 33) and the pass exited `database_error … connect
ECONNREFUSED` 48 s later (code 1, 470 s wall).

### Run F (this branch 532d1145, same chaos; `F-head/`)

Pass start 18:13:45 (groups of 16 publish in one transaction even with lanes
off on this build: 266 pages in the first 2 min 45 s); drop
18:16:46–18:20:46; stall rule 18:19:00. `stall-1.json` at 18:19:02: backend
89 `idle in transaction` / `ClientRead` on `DELETE FROM page_aliases …`
(`query_age` 136,464 ms, `xact_age` 139,548 ms); five idle backends with
statements 136–141 s old. Dump at 18:19:00: 16 members at
`publish:transaction` for 138,068 ms (steps `consumer:head_order@0 …
group:prepared@1397 … publish:acquire_worktree@2425 →
publish:transaction`); `sql_inflight`: `UPDATE pages SET chunker_version
…` and `INSERT INTO content_chunks …` (tx) 134,923 ms, `WITH expired AS
(…)` (reserved) 134,923 ms, `UPDATE persistence_requests r SET
claim_expires_at` (reserved) 130,151 ms, `SELECT c.* FROM
persistence_topology_changes` 134,925 ms, the drain poll 109,345 ms; pool
`max 10: open 0, busy 2, full 2, reserved 3`; consumer `phase: {
name: 'expired_claims', started_at: 18:16:46.036Z, deadline_exceeded: true,
attempt: 1272 }`, `abandoned_preparations: 0`, `outlived_ceiling: []`,
`preparation_attempts: 0`, `restart_required: false`; stderr: `phase=
expired_claims reason=deadline_exceeded` once, then (one connection came
back `read ECONNRESET`, logged as `phase=execution reason=storage_error`,
which is what un-parked the tick here about 2.5 min in and did not happen
to the reporter in 25 min)
9 × `phase=switches reason=deadline_exceeded checkout=not_observed
conn_wait_ms=5000` and 9 × `storage_error aborted`; progress line `[sync]
298/3000 processed · stalled 269s on publishing`; the 16 rows
`running`, stamp `preparing` (the publishing stamp never reached the
server), `claim_lapsed: true`, `since_update_ms` 142,283. After the lift
the group committed (298 → 330 by 18:21:27, 41 s) and the pass exited
`GBRAIN_DB_ACCESS conn_refused` / `database_error connect ECONNREFUSED
…:55433` at 18:21:35 (code 1, 470 s wall); no `preparation_deadline`, no
`preparation_stalled`, no `preparation_abandoned`.

### What the inspector gives

With `--inspect` each process listens on 127.0.0.1:650N; `Runtime.evaluate`
reads the pool queues and the instrument's maps live, `Debugger.enable` /
`setAsyncStackTraceDepth` are accepted, but the protocol has no way to
enumerate parked promises, and `Debugger.pause` only shows the current
synchronous stack. The step marks plus the in-flight statement table are
what name the await; the inspector adds nothing for this class.

## Candidate table

| candidate | verdict | evidence |
|---|---|---|
| (a) pool self-deadlock in the claiming process (every connection held by a holder that waits for another) | ruled out | Every dump during a wedge had `open` or `connecting` connections while statements were parked (E2: `connecting 9`; F: `open 0, busy 2, full 2, reserved 3` with nine SYN_SENT sockets); the parked waits are `await pending` on sockets, not reserve/checkout waits. The reporter's group renewals went through on the ordinary pool (`renewGroupClaims` uses `executeRaw`), which a pool deadlock would have blocked. |
| (b) cross-process wait on the other process's state: lane sets, `windowPredecessorAllows` / `claimedHeadOrder`, `page_write_guards FOR UPDATE`, the native worktree lock | ruled out as the mechanism | A/B/C: 2 h 49 min of serve + CLI (serve-first, 75 s gap; with adoption writes; with CLI restarts; with the dual pool), 18 serve-claimed FIFO groups published beside the CLI's lanes, no `preparing` claim older than 25 s, no `pg_locks` waiter, the `claimedHeadOrder` marks always `go`. The worktree lock is `tryAcquireNativeLock` (`ownership.ts` `lockWorktree`, `waitMs 0`): a busy lock returns `busy` and the group releases its claims, never waits. Lane commit-order waits (`awaitLaneTurn`) are bounded at 60 s. No wedge occurred, so `lslocks` / `fdinfo` were never captured during one. |
| (c) a shared memo or promise that never settles (`transactionMemo`, `sharedSyncValidation`, `groupReads`, `preparationReads`) | not the trigger; it is the fan-out | Nothing memoized hung on its own. Under the mechanism a memoized read or a shared group transaction parked on a dead socket parks every member at once, which is how the reporter's sixteen members show the same age (F: 16 members, one transaction, one parked `INSERT INTO content_chunks`). |
| (d) a round trip through a transaction-mode pooler whose exchange never completes, plus awaits that cannot be cancelled once it does | **reproduced** | E2, F2, F above; the reporter's 17:09Z capture. The await is `runUnsafe`'s `await pending`; `cancelActive` loops; `discard()` is unreachable. |
| two consumers on one host | multiplier, not mechanism | A/B/C published 4,951 pages with none; a second process only adds round trips that can park. |

## Two-consumer arms (0.60.110, 1935c74a)

15,000-page backlog on a 1,500-page history source, PgBouncer transaction
mode, 57 ms, pool 10, `GBRAIN_SYNC_LANES=6` (effective 6), seed drain run
7–8 min then SIGTERM (the reporter's watchdog kill), 40 s for its claims to
lapse, `gbrain serve --http` boots alone and claims the dead run's FIFO head
within one tick, `gbrain sync --source bench --no-pull --no-embed` 75 s
later; 15 s samples with `writer status --probe --json` every other sample;
wedge rule: a `preparing` stamp older than 5 min with nothing older than
10 s in `pg_stat_activity`.

| run | arm | two-consumer phase | pages | pages/min | max `preparing` stamp age | max active statement | max window with no commit | wedges |
|---|---|---|---|---|---|---|---|---|
| A (`two-A-110/`) | plain | 50 min | 432 → 3,215 | 55 | 25.5 s | 4.8 s | 100 s (the seed-kill → serve gap) | 0 |
| B (`two-B-110/`) | adoption writes (60 legacy rows, 6 + 20 marker pages, `dream --phase extract_facts` every 120 s) + CLI SIGTERM/restart every 600 s (6 restarts) | 62 min | 73 → 1,153 | 17–23 | 16.3 s | 3.9 s | 67 s | 0 |
| C (`two-C-110/`) | + `GBRAIN_DIRECT_DATABASE_URL` (dual pool: claims, followers and DDL on a 3-connection direct pool, as a Supabase deployment runs) + `--inspect`, restarts every 900 s (3) | 57 min | 93 → 1,181 | 19–24 | 16.8 s | 11.5 s | 115 s | 0 |

What the two-process shape does show: serve claimed 18 FIFO group heads
beside the CLI's 456 lane and FIFO claims in run A and published every one;
while a serve-held group publishes under the exclusive worktree lock, the
CLI's six lane transactions wait for their commit turn (`awaitLaneTurn`
polling `SELECT state FROM persistence_requests …` `idle in transaction`,
16 of 181 samples with four or more such transactions, worst 47 s) and roll
back at 60 s, a slow cycle in the publishing phase; the dual pool changed
nothing measurable. None of this parks a preparation.

## What the budget does to the wedge (this branch)

Nothing, by construction, and run F shows it: the budget wraps
`run.prepare` (`startPreparation` in `executeClaimedGroup`), and the awaits
that park under a dead exchange are the publication transaction's
statements, the lease renewal, the consumer tick's `expired_claims` /
`refresh_roots` / `switches` reads and the drain's progress poll. Wall
clock in F: drop at 18:16:46, last commit 18:16:40, stall rule at 140 s,
`deadline_exceeded` logged for the tick at +5 s and the tick still parked at
+134 s, no member cut at 120 s (`persistence.sync_preparation_ms`), no root
block to measure against `persistence.preparation_ceiling_ms` (600 s)
because no preparation was abandoned, no `preparation_stalled` after two
attempts because no attempt was charged; the catch-up continued only when
the network did (lift at +240 s, commit at +281 s), and the pass then died
on `ECONNREFUSED` instead of retrying. The B6 stall line is the one thing
that named the phase (`stalled 269s on publishing`); `writer status` could
not run at all during the wedge (its own probe parks through the same
pooler, killed at 120 s) and, once the network was back, called the member
`stalled` / `cause_unknown`.

## Recommended fix

Settle every consumer-side round trip on the client, not the server: in
`src/core/postgres-engine.ts` `runUnsafe` (2733–2748) race `await pending`
against the signal and, once `pending.cancel()` has not settled it within a
short grace, destroy the reserved socket (`owner.discard()` outside the
`finally`, or a `Promise.race` that rejects and then discards), so the
`phase()` deadline in `consumer.ts:598–618`, the renewal signal in
`journal.ts:352` and the drain poll's signal in `service.ts:249` end their
await with `CONNECTION_CLOSED` instead of parking; GBRA-59's PR 1.5 is this
change and should land first. Then route the consumer's own round trips
(claims, renewals, the tick's reads, the publication transaction) over the
session-mode / direct URL when the dual pool is active
(`postgres-engine.ts:608`, `connection-manager.ts` `isDualPoolActive`), and
make `gbrain sources writer status` print the owner's current statement,
its age and `wait_event` from `pg_stat_activity` for the owner's backends,
so a `ClientRead` wedge is visible in one command; leave
`persistence.single_consumer` off.

## Rerun

```bash
# the mechanism, either build (RELEASE_COMMIT for 0.60.110; omit --cli-repo for this branch)
UBI_OWNER=gbra61 scripts/ubicloud/ubi-runner.sh run -s standard-16 --setup scripts/bench/stall-repro-vm-setup.sh \
  --env RELEASE_COMMIT=1935c74a9 -- 'python3 scripts/bench/stall-debug-instrument.py ../gbrain-release && \
  bun scripts/bench/managed-sync-stall-repro.ts --cli-repo ../gbrain-release --scenario passes --lanes 1 --files 3000 --history 300 \
  --legacy-facts 0 --marker-pages 0 --doomed-pages 0 --backlog-marker-pages 0 --adoption-interval 0 --rtt 57 --pool-size 10 \
  --passes 1 --sample-seconds 10 --stall-minutes 2 --stall-kill-minutes 1000 --stall-signal SIGUSR2 \
  --chaos-at 3 --chaos-kind partition --chaos-for 240 --out .context/bench/partition'

# the two-consumer shape
bun scripts/bench/managed-sync-stall-repro.ts --cli-repo ../gbrain-release --scenario two-consumer [--direct-pool] [--inspect] \
  --files 15000 --history 1500 --rtt 57 --pool-size 10 --lanes 6 --seed-seconds 480 --seed-settle-seconds 40 \
  --order serve-first --gap-seconds 75 --cli-restart-seconds 600 --max-minutes 60 --passes 6 --sample-seconds 15 \
  --stall-minutes 5 --stall-kill-minutes 1000 --wedge-minutes 5 --wedge-hold-minutes 20 --stall-signal SIGUSR2 --out .context/bench/two
```

`git checkout -- src vendor && rm src/core/persistence/stall-debug.ts` undoes
the instrument in a checkout.
