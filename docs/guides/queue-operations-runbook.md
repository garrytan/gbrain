# Queue operations runbook

"My queue looks wedged — what do I run?" The commands below are in the order
you probably want them. Shipped with v0.19.1 after a production incident
where the queue held for 90+ minutes before the operator noticed.

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

As of v0.42.22.0 this self-heals — you usually won't have to do anything:

- **The worker exits on its own dead pool.** Under a supervisor, the worker's
  DB-liveness probe runs and self-exits (`db_dead`) after ~3 minutes; the
  supervisor respawns it with a fresh pool.
- **The supervisor restarts a worker that stops making progress.** If a queue
  has claimable work, **0 live-lock active jobs**, and no completions for 15
  minutes while the child is alive, the supervisor restarts it (covers stuck
  handlers too, not just dead pools). Tune with `--wedge-restart-minutes` /
  `--wedge-restart-checks` on `gbrain jobs supervisor` (0 disables).

The signal is loud now — check either:

```bash
gbrain jobs stats --queue default          # prints a WEDGED QUEUE line
gbrain doctor --json | jq '.checks[] | select(.name == "wedged_queue")'
```

`wedged_queue` is a per-queue health **error** (0 active_healthy + waiting > 0 +
stale completions). Manual fix if you ever need it:

```bash
gbrain jobs supervisor stop && gbrain jobs supervisor start   # fresh pool
gbrain jobs retry <id>                                        # dead-lettered jobs
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
# Force-kill a single stuck job:
gbrain jobs cancel <id>

# Clear a specific job entirely (last resort):
gbrain jobs delete <id>

# Health smoke on the mechanism itself:
gbrain jobs smoke --wedge-rescue
```

## What each subcheck means

- **stalled-forever** — A worker claimed a job, started executing, and has
  held the row for over an hour. The wall-clock sweep evicts jobs past
  2× `timeout_ms`; if one's still active, either no `timeout_ms` was set
  or the sweep is newly deployed and this job predates it. Cancel it.
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

## Follow-ups tracked for v0.20+

- B7 — `minion_workers` heartbeat table for ground-truth liveness (the
  `--no-worker` probe and the dropped `queue_health` worker-heartbeat
  subcheck both need this).
- B3 — `gbrain doctor --fix` learns to rescue queue wedges.
