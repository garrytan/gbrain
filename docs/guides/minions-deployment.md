# Minions Worker Deployment Guide

Keep `gbrain jobs work` running across crashes, reboots, and Postgres
connection blips. Written for agents to execute line-by-line.

## The problem

The persistent worker can die silently from:

- Database connection drops (Supabase/Postgres maintenance or network blips).
- Lock-renewal failures → the stall detector eventually dead-letters jobs.
- Bun process crashes with no automatic restart.
- Internal event-loop death (PID alive, worker loop stopped).

When the worker dies, submitted jobs sit in `waiting` — indefinitely for
most types; types with a waiting-TTL (`subagent` defaults to 48h, see the
[queue operations runbook](queue-operations-runbook.md)) are eventually
cancelled with an auditable reason rather than queueing forever. Either
way the work doesn't happen. The canonical answer is
`gbrain jobs supervisor` — a first-class CLI that spawns `gbrain jobs work`
as a child and auto-restarts it on crash.

## Worker supervision

### The canonical pattern

`gbrain jobs supervisor` is an auto-restarting wrapper around
`gbrain jobs work`. It writes a PID file, restarts the worker on crash
with exponential backoff (1s → 60s cap), emits lifecycle events to an
audit file, and drains gracefully on SIGTERM (35s worker-drain window
before SIGKILL). Exit codes are documented so agents can branch on them.

**Typical commands:**

```bash
# Start in the foreground (blocks; Ctrl-C to stop).
gbrain jobs supervisor --concurrency 4

# Start detached — returns {"event":"started","supervisor_pid":…} on stdout.
gbrain jobs supervisor start --detach --json

# Check liveness without reading log files.
gbrain jobs supervisor status --json

# Graceful stop (SIGTERM + drain wait + SIGKILL fallback).
gbrain jobs supervisor stop

# Optional: cap worker memory in MB (--max-rss). Without the flag the RSS
# watchdog is still on, at a RAM-relative auto-sized cap.
gbrain jobs supervisor --concurrency 4 --max-rss 4096
```

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Clean shutdown (SIGTERM/SIGINT received, worker drained) |
| 1 | Max crashes exceeded (worker kept dying) |
| 2 | Another supervisor holds the PID lock |
| 3 | PID file unwritable (permission / path error) |
| 4 | Queue-scoped DB lock lost mid-run (`LOCK_LOST` — exited rather than risk a split-brain) |

An agent seeing exit=2 can safely treat it as "one is already running";
exit=4 as "restart me — the DB lock refresh failed"; exit=1 should page
a human.

### Lowering scheduling priority (`--nice`)

When the worker pool runs at full concurrency on a machine you also use
interactively, it can drive the load average high enough to starve your
shell. Cutting `--concurrency` throws away throughput. Reach for `--nice`
instead — it lowers the job tree's CPU scheduling priority without touching
width, so the work runs full-speed when the box is idle and yields when it
isn't:

```bash
# Full concurrency, low priority. Propagates to the spawned worker and its
# children (shell jobs, subagents) via OS niceness inheritance.
gbrain jobs supervisor --concurrency 4 --nice 10

# Equivalent for a bare worker, or set it durably in the environment.
GBRAIN_NICE=10 gbrain jobs work --concurrency 4
```

`--nice` takes a POSIX value from `-20` (highest priority) to `19`
(nicest/lowest); positive values need no privilege, negative values need
root. `GBRAIN_NICE` is the env equivalent (the flag wins). Confirm the
effective value with `gbrain jobs stats`, `gbrain jobs supervisor status
--json`, or the `supervisor_niceness` check in `gbrain doctor` — the doctor
check warns if what you asked for isn't what's actually running (e.g. a
negative value denied without privilege, or an OS `RLIMIT_NICE` clamp). This
is distinct from the concurrency / inflight cap and composes with it.

### Per-job process isolation (`--job-isolation process`)

By default all concurrency slots execute inside one worker process. A
handler that ignores its abort signal can only be force-evicted — the
promise is abandoned, still running, still holding connections and memory —
and any worker exit destroys every in-flight job at once. With isolation on,
each claimed job runs in its own child process: a stuck handler is
group-SIGKILLed for real (group signaling under Bun falls back to POSIX
`/bin/kill`; if that's unavailable the worker logs that isolation is
degraded), a crash or OOM in a child takes that one job instead of all N,
and the OS reclaims every leaked resource when the child dies:

```bash
# Recommended for long-running LLM-bound handlers (subagent):
gbrain jobs supervisor --concurrency 4 --job-isolation process

# Bare worker, or durably via env:
GBRAIN_JOB_ISOLATION=process gbrain jobs work --concurrency 4
```

How it works: the worker keeps claim, lock renewal, and all result
recording; the child (an internal `run-child` entrypoint of the same gbrain
binary) re-validates the claim, runs the handler with its own small engine
pool, and reports one atomic outcome file. Handler-error semantics are
preserved across the boundary (unrecoverable → dead, rate-lease → no attempt
burned, everything else → normal backoff). On worker shutdown children get
the drain window to finish and report; a child killed before reporting is
released with no attempt burned. If the worker dies hard, the orphaned child
self-terminates via a parent-liveness watchdog and the stall sweeper
requeues the job after lock expiry — the lock token fences the orphan's
queue writes (result recording, progress, state transitions) into no-ops.
The handler's own side effects (page writes through its engine) can still
land until the watchdog stops the child; that window is the watchdog's
poll + grace, not unbounded.

Sizing notes:

- **Connections:** each child opens its own small pools (read 3 by default,
  override via `GBRAIN_JOB_CHILD_POOL_SIZE`; direct 1). Worked example at
  concurrency 15: 15×(3+1) + the worker's 10+3 ≈ **73 client connections**
  total — 55 ride the transaction-pooler lane (multiplexed, no extra server
  backends) and 18 are lazy direct session-lane connections, each holding a
  real server backend while open. Budget the pooler-lane count against your
  pooler's client limit and the session-lane count against
  `max_connections`.
- **Memory:** `--max-rss` covers the WORKER process only in this mode
  (handler memory lives in the children; the worker prints a note when both
  are set). There is no per-child RSS cap yet — a runaway child is contained
  only by host/container limits. Size host memory for concurrency × handler
  footprint.
- **Spawn cost:** ~0.3–1s per job (engine connect included) — noise for
  long-running handlers, meaningful for sub-second ones (`lint`,
  `backlinks`). Keep those inline or on a separate inline worker.
- **Security note:** the child receives the job's lock token via env. It is
  a *fencing* token (split-brain protection), not a secret — same-user env
  already contains the database URL.
- **Child CLI resolution:** the worker fail-fast validates the child CLI at
  startup (compiled `gbrain` binary, bun-dev fallback, or the
  `GBRAIN_JOB_CHILD_CLI` env override — the ops/test escape hatch). Three
  consecutive child spawn/bootstrap failures self-exit the worker as
  unhealthy (a deterministically broken child CLI) for process-manager
  restart instead of burning attempts across the queue.

### Which supervisor when?

The supervisor solves in-process crash recovery. Platform-level
supervision (systemd, Fly, Render) handles host-level failures. You
usually want both.

| Environment | Recommendation |
|---|---|
| **Container (Fly / Railway / Render / Heroku)** | `gbrain jobs supervisor` runs as PID 1. The platform restarts the container on OOM / host loss; supervisor restarts the worker on crash. See [Fly.io](#flyio) / [Render / Railway / Heroku](#render--railway--heroku). |
| **Linux VM with systemd** | Two-layer recommended: systemd supervises `gbrain jobs supervisor`, which in turn supervises `gbrain jobs work`. Buys you automatic restart on reboot (systemd) plus fast crash recovery (supervisor). See [systemd](#systemd). |
| **Dev laptop / macOS** | `gbrain jobs supervisor` in a terminal. Ctrl-C stops it. No system-level setup needed. |

### Variables used in this guide

Substitute these once before copy-pasting any snippet.

| Variable | Meaning | Typical value |
|---|---|---|
| `$GBRAIN_BIN` | Absolute path to the `gbrain` binary | `$(command -v gbrain)` — often `/usr/local/bin/gbrain` or `~/.bun/bin/gbrain` |
| `$GBRAIN_WORKER_USER` | OS user that owns the worker process | the same user that ran `gbrain init`; never `root` |
| `$GBRAIN_WORKSPACE` | `cwd` for shell jobs submitted by this deployment | absolute path, e.g. `/srv/my-brain` |
| `$GBRAIN_ENV_FILE` | Secrets file sourced by systemd / shell | `/etc/gbrain.env` (mode 600) |

### Preconditions

Run these before any deployment step.

```bash
# 1. gbrain is on PATH and resolves to an absolute location.
command -v gbrain || { echo "gbrain not on PATH. Install, then retry."; exit 1; }

# 2. DATABASE_URL points at reachable Postgres.
#    (Supervisor is Postgres-only. PGLite's exclusive file lock blocks the
#    separate worker process. If `config.engine === 'pglite'` the CLI rejects
#    with a clear error.)
gbrain doctor --fast --json | jq '.checks[] | select(.name=="db_connectivity")'

# 3. Schema is up to date. If version=0 or status=="fail":
#    gbrain apply-migrations --yes
gbrain doctor --fast --json | jq '.checks[] | select(.name=="schema_version")'

# 4. If you plan to submit `shell` jobs, pass --allow-shell-jobs to the
#    supervisor (or export GBRAIN_ALLOW_SHELL_JOBS=1 before starting).
#    Without the flag, the shell handler is disabled at worker startup.
```

## Agent usage (OpenClaw / Hermes / Cursor / Codex)

Three-command pattern an agent can drive without shell archaeology:

```bash
# Start (returns PIDs + pid_file on stdout as JSON, then detaches)
gbrain jobs supervisor start --detach --json
# → {"event":"started","supervisor_pid":1234,"pid_file":"/Users/you/.gbrain/supervisor-<brain-id>.pid","detached":true}

# Check health (machine-parseable JSON, no log scraping)
gbrain jobs supervisor status --json
# → {"running":true,"supervisor_pid":1234,"last_start":"2026-04-23T15:30:22Z","crashes_24h":0, ...}

# Stop cleanly (SIGTERM + 35s drain + SIGKILL fallback)
gbrain jobs supervisor stop
```

Every lifecycle event (spawn, crash, backoff, health warning, max-crashes,
shutdown) is also written to `${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-YYYY-Www.jsonl`
for historical inspection. `gbrain doctor` reads that file and surfaces
a `supervisor` check in its health report.

## Deployment: systemd

For long-running Linux VMs with shell access.

```bash
# Create the worker user if it doesn't exist.
sudo useradd --system --home "$GBRAIN_WORKSPACE" --shell /usr/sbin/nologin gbrain \
  2>/dev/null || true
sudo mkdir -p "$GBRAIN_WORKSPACE" && sudo chown gbrain:gbrain "$GBRAIN_WORKSPACE"

# Install the env file (secrets stay out of the unit file).
sudo install -m 600 -o gbrain -g gbrain \
  docs/guides/minions-deployment-snippets/gbrain.env.example /etc/gbrain.env
sudoedit /etc/gbrain.env
# Fill in DATABASE_URL, optional GBRAIN_ALLOW_SHELL_JOBS=1.

# Install the unit file, substituting /srv/gbrain → your workspace path.
sudo install -m 644 docs/guides/minions-deployment-snippets/systemd.service \
  /etc/systemd/system/gbrain-worker.service
sudo sed -i "s|/srv/gbrain|$GBRAIN_WORKSPACE|g" \
  /etc/systemd/system/gbrain-worker.service

sudo systemctl daemon-reload
sudo systemctl enable --now gbrain-worker
sudo systemctl status gbrain-worker
journalctl -u gbrain-worker -n 50
```

The shipped unit file invokes `gbrain jobs supervisor` (not `gbrain jobs work`
directly) so you get two-layer supervision: systemd restarts the supervisor
on host reboot, supervisor restarts the worker on in-process crash.

`Restart=always` + `RestartSec=10s` handle the supervisor-level recovery.
The unit runs as unprivileged `gbrain` with `PrivateTmp`, `ProtectSystem=strict`,
and `ReadWritePaths=$GBRAIN_WORKSPACE,$HOME/.gbrain` (for the PID file and
audit log). `LimitNOFILE=65535` covers Bun + Postgres pool + concurrent
LLM subagent calls without hitting the default 1024 cap.

## Deployment: Fly.io

```bash
# Merge the [processes] block from fly.toml.partial into your fly.toml.
cat docs/guides/minions-deployment-snippets/fly.toml.partial >> fly.toml
# Review + edit as needed.

# Set secrets (Fly handles restart on crash).
fly secrets set DATABASE_URL='postgres://…' GBRAIN_ALLOW_SHELL_JOBS=1
```

The `[processes]` block runs `gbrain jobs supervisor` as PID 1. Fly
restarts the container on host failure; the supervisor restarts the
worker on in-process crash.

## Deployment: Render / Railway / Heroku

Drop [`Procfile`](./minions-deployment-snippets/Procfile) at the repo
root. The shipped Procfile calls `gbrain jobs supervisor`. Set
`DATABASE_URL` + optional `GBRAIN_ALLOW_SHELL_JOBS=1` via the platform's
env UI or CLI.

## Deployment: inline `--follow` (no persistent worker)

For short deterministic scripts on a fixed schedule where you don't need
a persistent worker between runs. Each cron run brings its own temporary
worker. `--follow` starts one on the queue and blocks until the
just-submitted job reaches a terminal state (`completed` / `failed` /
`dead` / `cancelled`). 2-3 s startup overhead per job; negligible vs job
duration for scheduled work.

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
  --queue nightly-enrich \
  --params "{\"cmd\":\"$GBRAIN_BIN embed --stale\",\"cwd\":\"$GBRAIN_WORKSPACE\"}" \
  --follow \
  --timeout-ms 600000
```

Replace `gbrain embed --stale` with whichever gbrain subcommand you're
scheduling (`sync`, `extract`, `orphans`, `doctor`, `check-backlinks`,
`lint`, `autopilot`). For strict single-job semantics on shared queues,
use a dedicated queue name like `nightly-enrich` above.

## Upgrading from an older deployment

### From `minion-watchdog.sh`

Earlier versions of this guide shipped a 68-line bash watchdog
(`minion-watchdog.sh`). It's been replaced by `gbrain jobs supervisor`
which handles everything the script did, plus atomic PID locking,
structured audit events, queue-scoped health checks, and graceful
drain on SIGTERM.

**Migration:**

```bash
# 1. Stop and remove the old watchdog.
sudo kill $(head -n1 /tmp/gbrain-worker.pid) 2>/dev/null
sudo rm -f /usr/local/bin/minion-watchdog.sh /tmp/gbrain-worker.pid \
           /tmp/gbrain-worker.log
crontab -e   # delete the "*/5 * * * * /usr/local/bin/minion-watchdog.sh" line

# 2. Start the supervisor (systemd users: reinstall the unit from
#    docs/guides/minions-deployment-snippets/systemd.service, which
#    now calls `gbrain jobs supervisor`).
gbrain jobs supervisor start --detach --json
# Or: sudo systemctl restart gbrain-worker

# 3. Verify.
gbrain jobs supervisor status --json
gbrain doctor   # 'supervisor' check should report running=true
```

### Schema / migration hygiene

Regardless of which deployment path you're upgrading from:

1. **Stop the worker before upgrading.** `gbrain jobs supervisor stop`
   (or `sudo systemctl stop gbrain-worker`). Skipping this risks an
   in-flight job landing partial schema.
2. **Run `gbrain upgrade`**. Then `gbrain apply-migrations --yes` if
   `gbrain doctor` reports any migration as `partial` or `pending`.
3. **If you run shell jobs:** pass `--allow-shell-jobs` to the
   supervisor (or keep `GBRAIN_ALLOW_SHELL_JOBS=1` in
   `/etc/gbrain.env`). Submitters don't need the flag; only the worker
   does.
4. **Verify.** `gbrain doctor` should report zero `pending` or `partial`
   migrations plus a healthy `supervisor` check. `gbrain jobs stats`
   should show no unexplained growth in `dead` between pre- and
   post-upgrade.

## Known issues

### Supabase connection drops

If Supabase drops the worker's Postgres connection (maintenance,
connection limits, network blip), this now self-heals under the
supervisor: the worker's DB-liveness probe self-exits (`db_dead`) on a
dead pool and the supervisor respawns it with a fresh pool, and the
supervisor also restarts a worker that stops making progress while
claimable work waits. The escalation commands and thresholds live in the
[queue operations runbook](queue-operations-runbook.md) — that's the
canonical home for wedge recovery.

What can still bite is now narrow. Lock renewal is verify-before-evict:
a thrown or timed-out renewal is never treated as loss — at the deadline
the worker asks the database the authoritative question (one fenced
re-check), so a starved-but-healthy job recovers its lease and keeps
working. Eviction happens only on a fenced miss (the row was genuinely
reclaimed — requeued with no attempt burned) or after a hard backstop
(default 2× the lease) during a total outage. Long LLM handlers also get
a 300 s lock lease by default (`HANDLER_DEFAULT_LOCK_DURATION_MS`)
instead of the worker-global 30 s, and the stall sweep grants a 15 s
reclaim grace so a just-recovered worker's renewal beats the sweep.
The remaining exposure: a genuinely dead worker's long-lease job waits
up to lease + grace + one sweep interval before requeue, and the stall
detector still dead-letters after `max_stalled` genuine misses (schema
column default 5).

Mixed-version fleets degrade gracefully: an old worker ignores the
`lock_duration_ms` column and runs the legacy 30 s behavior; new workers
honor old rows via the claim-time default. No drain or ordered restart
is required.

**Tune per-job.** `gbrain jobs submit` accepts `--max-stalled N`,
`--backoff-type fixed|exponential`, `--backoff-delay <ms>`,
`--timeout-ms N`, `--lock-duration-ms N` (lock lease, clamped to
[5 s, 1 h]), and `--backoff-jitter 0..1` as first-class flags.
These write onto the job row at submit time — which is what
`handleStalled()` and the renewal timer read — so per-job tuning is the
real knob. The lock-renewal env knobs (incident escape hatches) are
documented in the [queue operations runbook](queue-operations-runbook.md).

### DO NOT pass `maxStalledCount` to `MinionWorker`

It's a no-op. The stall detector reads the row's `max_stalled` column
(set at submit time), not the worker opt in `src/core/minions/worker.ts`.
Use `gbrain jobs submit --max-stalled N` per-job instead.

### Zombie shell children

When the Bun worker crashes hard, child processes from shell jobs can
become zombies. The supervisor's SIGTERM → 35s drain → SIGKILL window
covers the shell handler's 5 s child-kill grace (`KILL_GRACE_MS`). For
long-running shell jobs, prefer timeouts via `--timeout-ms` on submit
over relying on hard kills.

## Smoke test

```bash
# Supervisor alive?
gbrain jobs supervisor status --json | jq .running

# Aggregate queue health.
gbrain jobs stats

# Jobs currently stalled (still `active` with expired lock_until, pre-requeue).
gbrain jobs list --status active --limit 10

# Dead-lettered jobs.
gbrain jobs list --status dead --limit 10

# Shell handler registered? (check supervisor audit log or worker stderr.)
gbrain jobs supervisor status --json | jq '.worker_config.allow_shell_jobs'
```

## Uninstall

**`gbrain jobs supervisor`** (foreground or `--detach`):

```bash
gbrain jobs supervisor stop
```

**systemd:**

```bash
sudo systemctl disable --now gbrain-worker
sudo rm /etc/systemd/system/gbrain-worker.service /etc/gbrain.env
sudo systemctl daemon-reload
```

**Fly / Render / Railway:** delete the `worker` process from `fly.toml`
/ `Procfile` and redeploy. Secrets set via `fly secrets` persist until
`fly secrets unset`.

**Inline `--follow`:** remove the cron entry. Nothing else to clean up
— temporary workers exit with their jobs.
