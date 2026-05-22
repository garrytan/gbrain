# Minions Worker Deployment Guide

Keep `gbrain jobs work` running across crashes, reboots, and Postgres
connection blips. Written for agents to execute line-by-line.

## The problem

The persistent worker can die silently from:

- Database connection drops (Supabase/Postgres maintenance or network blips).
- Lock-renewal failures → the stall detector eventually dead-letters jobs.
- Bun process crashes with no automatic restart.
- Internal event-loop death (PID alive, worker loop stopped).

When the worker dies, submitted jobs sit in `waiting` forever. The
canonical answer is `gbrain jobs supervisor` — a first-class CLI that
spawns `gbrain jobs work` as a child and auto-restarts it on crash.

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
```

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Clean shutdown (SIGTERM/SIGINT received, worker drained) |
| 1 | Max crashes exceeded (worker kept dying) |
| 2 | Another supervisor holds the PID lock |
| 3 | PID file unwritable (permission / path error) |

An agent seeing exit=2 can safely treat it as "one is already running";
exit=1 should page a human.

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
# → {"event":"started","supervisor_pid":1234,"worker_pid":1235,"pid_file":"/Users/you/.gbrain/supervisor.pid"}

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

### From `minion-watchdog.sh` (pre-v0.20)

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
3. **If you run shell jobs:** from v0.14 onward, pass
   `--allow-shell-jobs` to the supervisor (or keep
   `GBRAIN_ALLOW_SHELL_JOBS=1` in `/etc/gbrain.env`). Submitters don't
   need the flag; only the worker does.
4. **Verify.** `gbrain doctor` should report zero `pending` or `partial`
   migrations plus a healthy `supervisor` check. `gbrain jobs stats`
   should show no unexplained growth in `dead` between pre- and
   post-upgrade.

## Known issues

### Supabase connection drops

The worker uses a single Postgres connection. If Supabase drops it
(maintenance, connection limits, network blip), lock renewal fails
silently. The stall detector then dead-letters the job after
`max_stalled` misses.

**Current defaults that make this worse:**

- `lockDuration: 30000` (30 s) — too short for long jobs during
  connection blips.
- `max_stalled: 5` (schema column default — see `src/schema.sql` and
  `src/core/pglite-schema.ts`). Five missed heartbeats before dead-letter.
- `stalledInterval: 30000` (30 s) — checks too aggressively.

**Tune per-job today.** `gbrain jobs submit` accepts `--max-stalled N`,
`--backoff-type fixed|exponential`, `--backoff-delay <ms>`,
`--backoff-jitter 0..1`, and `--timeout-ms N` as first-class flags
(since v0.13.1). These write onto the job row at submit time — which is
what `handleStalled()` reads — so per-job tuning is the real knob today.

### DO NOT pass `maxStalledCount` to `MinionWorker`

It's a no-op. The stall detector reads the row's `max_stalled` column
(set at submit time), not the worker opt in `src/core/minions/worker.ts:74`.
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
