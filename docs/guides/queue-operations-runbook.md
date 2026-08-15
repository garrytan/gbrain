# Queue operations runbook

"My queue looks wedged — what do I run?" The commands below are in the order
you probably want them. Born from a production incident where the queue held
for 90+ minutes before the operator noticed.

## First signal: jobs aren't running

```bash
gbrain doctor --json | jq '.checks[] | select(.name == "queue_health")'
```

`queue_health` flags two patterns:

- **stalled-forever**: active job whose `started_at` is older than 1h.
- **waiting-depth**: any per-name queue deeper than 10 (override via
  `GBRAIN_QUEUE_WAITING_THRESHOLD`). Signals a missing `maxWaiting`.

## The worker is alive but wedged (dead pool)

The nastiest stall: the worker process is *running* (passes `ps` / `kill -0` /
container health), but its DB connection died (common behind a transaction
pooler) and never came back, so it claims no jobs and finishes nothing. Jobs
pile up with **0 active**. Liveness checks all pass; nothing crashes.

This self-heals — you usually won't have to do anything:

- **The worker exits on its own dead pool.** Under a supervisor, the worker's
  DB-liveness probe runs and self-exits (`db_dead`) after ~3 minutes; the
  supervisor respawns it with a fresh pool.
- **The supervisor restarts a worker that stops making progress.** If a queue
  has claimable work, **0 live-lock active jobs**, and no completions for 15
  minutes across 3 consecutive health checks while the child is alive, the
  supervisor restarts it (covers stuck handlers too, not just dead pools).
  These thresholds are built in — there are no CLI flags to tune them. A
  restart-loop breaker caps wedge restarts at 3 per 30-minute window, then
  switches to a one-shot `wedge_restart_loop` alert in the audit log.

The signal is loud now — check either:

```bash
gbrain jobs stats --queue default          # prints a WEDGED QUEUE line
gbrain doctor --json | jq '.checks[] | select(.name == "wedged_queue")'
```

`wedged_queue` is a per-queue health **error** (0 active_healthy + waiting > 0 +
stale completions). Manual fix if you ever need it:

```bash
# Restart the supervisor with a fresh pool. `start` alone runs in the
# FOREGROUND (blocks); use --detach to get your shell back.
gbrain jobs supervisor stop && gbrain jobs supervisor start --detach --json

# Re-queue any jobs that were dead-lettered during the wedge.
gbrain jobs retry <id>
```

## Triage commands

```bash
# Who's active right now?
gbrain jobs list --status active

# Who's waiting, biggest pile first?
gbrain jobs list --status waiting --limit 50

# What's wrong with a specific job?
gbrain jobs get <id>
```

## Rescue actions (in order of escalation)

```bash
# Cancel a single stuck job (inline mode: cooperative — the handler must
# observe its abort signal, and after 30s it is force-evicted from tracking
# but the promise keeps running; with --job-isolation process the child is
# actually SIGTERM→SIGKILLed once cancellation is detected):
gbrain jobs cancel <id>

# Clear a specific job entirely (last resort):
gbrain jobs delete <id>

# Health smoke on the mechanism itself:
gbrain jobs smoke --wedge-rescue
```

## What each subcheck means

- **stalled-forever** — A worker claimed a job, started executing, and has
  held the row for over an hour. The wall-clock sweep evicts jobs past
  2× `timeout_ms`. Long-lane handlers (subagent, autopilot-cycle,
  embed-backfill, …) always have a budget now: it stamps at submit, is
  COALESCEd from `HANDLER_DEFAULT_TIMEOUT_MS` at claim for legacy NULL rows,
  and migration v128 backfilled rows that predate both. `gbrain jobs get <id>`
  prints the effective budget and which kill path applies. If a short-lane
  job is still active with no budget, the null-default sweep
  (2 × lock-duration × max_stalled) evicts it within minutes. Cancel it if
  you can't wait.
- **duplicate cycles** — Historic brains could accumulate byte-identical
  waiting `autopilot-cycle` rows when a job stalled in `active`. v128
  cancelled that backlog (newest ticker-keyed row per source survives), and
  the `maxPending` dispatch guard prevents new accumulation. Suppressed
  dispatches are visible in `jobs stats` (Backpressure line) and the
  backpressure audit JSONL.
- **waiting-depth** — Submitters are piling up jobs faster than workers
  drain them. Set `--max-waiting N` on the submission or on the programmatic
  `queue.add()` call. If you want a taller pile, raise the threshold via
  `GBRAIN_QUEUE_WAITING_THRESHOLD=50 gbrain doctor`.

## Self-check: is a worker even running?

```bash
# If you're running autopilot with --no-worker, check that your external
# worker (systemd / Docker / OpenClaw service-manager) is alive:
gbrain jobs list --status active | head -5
```

If the list is empty AND your submissions keep piling up, no worker is
claiming. Start one:

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work --concurrency 4
```

## Reading the DB-probe verdicts (pool starved vs server unreachable)

When the worker's health probe fails repeatedly, the terminal
`[health] DB probe failed N consecutive times (verdict: ...)` line — and the
`unhealthy` payload the supervisor sees — carries a verdict that names the
failing LAYER (the intermediate `(N/3)` lines log only the failure detail).
Read it before touching anything — the historical failure mode here was
hours spent evaluating a database instance upgrade while the server sat at
10% of max_connections.

| Verdict | What it means | What to do |
|---|---|---|
| `pool_starved` | The read-pool probe failed but the DIRECT-lane probe succeeded — the database server is reachable; the fault is in the transaction-pooler path (client pool exhaustion or a pooler-layer fault; the probe deliberately does not distinguish the two). | Look at client-side load: long-running handler queries holding slots, `GBRAIN_POOL_SIZE` too small for the workload, or a pooler-layer incident. Do NOT resize the database. The worker exit is correct recovery — it frees every client-held slot. |
| `server_unreachable` | Both the pooler lane and the direct lane failed. | Check connectivity/capacity first: network, DNS, the database itself. Both-lanes-failed is the evidence — credential/config errors or a saturated direct lane can also land here, so glance at the probe detail text before concluding the server is down. |
| `unknown` | The read probe failed and no direct lane exists to disambiguate (single-pool mode: non-Supabase, kill switch active, or no derivable direct URL). | Check the startup log for the single-pool warning; consider `GBRAIN_DIRECT_DATABASE_URL` so future incidents self-diagnose. |

The `gbrain-tracked in flight` counts in the message are a tracked SUBSET
(raw/direct/reserved/transaction seams only) — most template-path queries are
untracked, so `0 in flight` next to a `pool_starved` verdict means the
saturation lives in that untracked traffic or at the pooler layer itself,
not that the pool is idle. The verdict, not the counts, is the
authoritative signal.

## Related

- [Minions worker deployment](minions-deployment.md) — supervisor lifecycle,
  exit codes, and per-platform deployment (systemd / Fly / Render).
- [Minions shell jobs](minions-shell-jobs.md) — the `shell` job type's
  security model and error table.
