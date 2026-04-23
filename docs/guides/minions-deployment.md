# Minions Worker Deployment Guide

Deploy `gbrain jobs work` so it stays running across crashes, reboots, and
Postgres connection blips. Written for agents to execute line-by-line.

## The problem

The persistent worker can die silently from:

- Database connection drops (Supabase/Postgres maintenance or network blips).
- Lock-renewal failures → the stall detector eventually dead-letters jobs.
- Bun process crashes with no automatic restart.
- Internal event-loop death (PID alive, worker loop stopped).

When the worker dies, submitted jobs sit in `waiting` forever. Nothing in
gbrain core auto-restarts the worker — that's what this guide wires up.

## Variables used in this guide

Substitute these once before copy-pasting any snippet.

| Variable | Meaning | Typical value |
|---|---|---|
| `$GBRAIN_BIN` | Absolute path to the `gbrain` binary | `$(command -v gbrain)` — often `/usr/local/bin/gbrain` or `~/.bun/bin/gbrain` |
| `$GBRAIN_WORKER_USER` | OS user that owns the worker process | the same user that ran `gbrain init`; never `root` |
| `$GBRAIN_WORKER_PID_FILE` | Worker PID + restart-epoch file | `/tmp/gbrain-worker.pid` (or `/var/run/gbrain/worker.pid` for systemd) |
| `$GBRAIN_WORKER_LOG_FILE` | Worker log sink (stdout + stderr merged) | `/tmp/gbrain-worker.log` (or `/var/log/gbrain/worker.log`) |
| `$GBRAIN_WORKSPACE` | `cwd` for shell jobs submitted by this deployment | absolute path, e.g. `/srv/my-brain` |
| `$GBRAIN_ENV_FILE` | Secrets file sourced by crontab / systemd | `/etc/gbrain.env` (mode 600) |

## Preconditions

Run these before Step 1 of any option. Fail fast if something is wrong.

```bash
# 1. gbrain is on PATH and resolves to an absolute location.
command -v gbrain || { echo "gbrain not on PATH. Install, then retry."; exit 1; }

# 2. DATABASE_URL points at reachable Postgres (or PGLite path exists).
gbrain doctor --fast --json | jq '.checks[] | select(.name=="db_connectivity")'

# 3. Schema is up to date. If version=0 or status=="fail", fix it first:
#    gbrain apply-migrations --yes
gbrain doctor --fast --json | jq '.checks[] | select(.name=="schema_version")'

# 4. You have write access to at least one crontab mechanism.
crontab -l >/dev/null 2>&1 && echo "user crontab OK"
[ -w /etc/crontab ] && echo "/etc/crontab OK"

# 5. If you plan to submit `shell` jobs, the WORKER process needs
#    GBRAIN_ALLOW_SHELL_JOBS=1 (submitters do not). The handler is gated
#    in registerBuiltinHandlers(); without the flag the worker startup
#    line reads "shell handler disabled (...)".
```

## Which option?

- Your workload runs LLM subagents (`gbrain agent run`) or jobs that take
  > 30 s → **Option 1** (watchdog cron + persistent worker).
- Your workload is short deterministic scripts on a fixed schedule (every
  3 h, daily, weekly) → **Option 2** (inline `--follow`).
- You don't have shell access to a long-running box (Fly/Render/Railway,
  or any systemd host) → **Option 3** (service manager — replaces cron).

## Option 1: watchdog cron + persistent worker

A 5-minute cron checks whether the worker process is alive **and** whether
it has logged an internal shutdown since its last start. Restarts if either
condition fails.

### 1a. Install the env file (secrets stay out of crontab)

Never paste `DATABASE_URL` or API keys into crontab. `/etc/crontab` is
mode 644 (world-readable); user crontabs under `/var/spool/cron/` are
readable by `root`. Use the shipped env-file template:

```bash
sudo install -m 600 -o $GBRAIN_WORKER_USER -g $GBRAIN_WORKER_USER \
  docs/guides/minions-deployment-snippets/gbrain.env.example /etc/gbrain.env
sudoedit /etc/gbrain.env
```

Fill in the connection string and `GBRAIN_ALLOW_SHELL_JOBS=1` (if
applicable). See
[`gbrain.env.example`](./minions-deployment-snippets/gbrain.env.example)
for the full list.

### 1b. Install the watchdog script

The [`minion-watchdog.sh`](./minions-deployment-snippets/minion-watchdog.sh)
ships in-repo and writes a two-line PID file (PID on line 1, restart epoch
on line 2). The restart-epoch marker is how the watchdog distinguishes
stale shutdown lines in the log from current ones — without it, every tick
after the first restart would match an old `worker shutting down` line and
loop forever.

Requires GNU coreutils (Linux default). On macOS/BSD install via
`brew install coreutils` and alias `date` to `gdate` in the cron env if you
want to test the watchdog locally; production Linux boxes work as-is.

```bash
sudo install -m 755 -o $GBRAIN_WORKER_USER -g $GBRAIN_WORKER_USER \
  docs/guides/minions-deployment-snippets/minion-watchdog.sh \
  /usr/local/bin/minion-watchdog.sh
```

### 1c. Wire into cron

Pick the form that matches the crontab you're editing.

**If you ran `crontab -e`** (user crontab — 5-field, no user column):

```
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
BASH_ENV=/etc/gbrain.env
*/5 * * * * /usr/local/bin/minion-watchdog.sh
```

**If you edited `/etc/crontab` directly** (system crontab — 6-field, with
user column):

```
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
BASH_ENV=/etc/gbrain.env
*/5 * * * * gbrain /usr/local/bin/minion-watchdog.sh
```

In both forms, `BASH_ENV=/etc/gbrain.env` tells non-interactive bash to
source the env file before running the watchdog — that's how the
connection string and `GBRAIN_ALLOW_SHELL_JOBS` reach the worker without
landing in the world-readable crontab itself.

### 1d. Log rotation

The watchdog appends to the worker log across restarts. If you expect the
file to grow unbounded, rotate it externally with `logrotate`:

```
# /etc/logrotate.d/gbrain-worker
/tmp/gbrain-worker.log {
  daily
  rotate 7
  missingok
  notifempty
  copytruncate
}
```

`copytruncate` is important — the watchdog's restart-epoch check survives
it (the epoch is compared against in-log timestamps, not file inode).

## Option 2: inline `--follow` (no persistent worker)

Each cron run brings its own temporary worker. `--follow` starts one on
the queue and blocks until the just-submitted job reaches a terminal state
(`completed` / `failed` / `dead` / `cancelled`). 2-3 s startup overhead
per job; negligible vs job duration for scheduled work.

Example: nightly brain enrichment as a shell job.

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
  --queue nightly-enrich \
  --params "{\"cmd\":\"$GBRAIN_BIN embed --stale\",\"cwd\":\"$GBRAIN_WORKSPACE\"}" \
  --follow \
  --timeout-ms 600000
```

Replace `gbrain embed --stale` with whichever gbrain subcommand you're
scheduling (`sync`, `extract`, `orphans`, `doctor`, `check-backlinks`,
`lint`, `autopilot`). If you're shelling out to a non-gbrain binary,
keep its absolute path in the `cmd`.

**Shared-queue gotcha.** If other jobs are already waiting on the same
queue with higher priority or earlier `created_at`, the temporary worker
processes those first before reaching yours. `--follow` still exits only
when YOUR job finishes. For strict single-job semantics on shared queues,
use a dedicated queue name like `nightly-enrich` above.

## Option 3: service manager (systemd / Fly / Render / Railway)

Replaces the watchdog entirely. No cron, no PID file, no restart-loop.
The service manager owns liveness.

### systemd (Linux hosts with shell access)

```bash
# Create the worker user if it doesn't exist.
sudo useradd --system --home "$GBRAIN_WORKSPACE" --shell /usr/sbin/nologin gbrain \
  2>/dev/null || true
sudo mkdir -p "$GBRAIN_WORKSPACE" && sudo chown gbrain:gbrain "$GBRAIN_WORKSPACE"

# Install the unit file, substituting /srv/gbrain → your workspace path.
sudo install -m 644 docs/guides/minions-deployment-snippets/systemd.service \
  /etc/systemd/system/gbrain-worker.service
sudo sed -i "s|/srv/gbrain|$GBRAIN_WORKSPACE|g" \
  /etc/systemd/system/gbrain-worker.service

# See 1a above for /etc/gbrain.env install.
sudo systemctl daemon-reload
sudo systemctl enable --now gbrain-worker
sudo systemctl status gbrain-worker
journalctl -u gbrain-worker -n 50
```

`Restart=always` + `RestartSec=10s` give you crash-loop recovery. The unit
runs as an unprivileged `gbrain` user with `PrivateTmp`, `ProtectSystem=strict`,
and `ReadWritePaths=$GBRAIN_WORKSPACE`. `LimitNOFILE=65535` in the shipped
unit covers Bun + Postgres pool + concurrent LLM subagent calls without
hitting the default 1024 cap.

### Fly.io

Merge the `[processes]` block from
[`fly.toml.partial`](./minions-deployment-snippets/fly.toml.partial) into
your existing `fly.toml`. Set secrets with `fly secrets set` —
Fly auto-restarts the process on crash.

### Render / Railway / Heroku

Drop [`Procfile`](./minions-deployment-snippets/Procfile) at the repo root.
Set the connection string and `GBRAIN_ALLOW_SHELL_JOBS=1` via the
platform's env UI or CLI.

## Upgrading an existing deployment

If you deployed on v0.13.x or earlier, walk this checklist:

1. **Stop the worker before upgrading.**
   `kill $(head -n1 /tmp/gbrain-worker.pid)` and wait for the process to
   exit. Skipping this risks an in-flight job landing partial schema.
2. **Run `gbrain upgrade`**. Then `gbrain apply-migrations --yes` if
   `gbrain doctor` reports any migration as `partial` or `pending`.
3. **If you run shell jobs:** from v0.14 onward, the worker requires
   `GBRAIN_ALLOW_SHELL_JOBS=1` to register the `shell` handler. Add it to
   `/etc/gbrain.env`. Submitters don't need the flag; only the worker does.
4. **If you tuned your watchdog for `max_stalled=1`:** v0.14.3 migration
   v15 raised the schema default to 5 and backfilled existing non-terminal
   rows. A watchdog tuned around 1-strike dead-lettering will now
   over-restart because it takes 5 misses to dead-letter. Switch to the
   shipped watchdog (which keys on log markers, not job state).
5. **If your v0.16.1 watchdog is still running:** it has a restart-loop
   bug (old shutdown lines in the unrotated log re-match every 5 min
   forever). Install the current `minion-watchdog.sh` from this guide's
   snippets — it writes a restart epoch into the PID file and only
   considers log lines newer than that epoch.
6. **Verify.** `gbrain doctor` should report zero `pending` or `partial`
   migrations. `gbrain jobs stats` should show no unexplained growth in
   `dead` between pre- and post-upgrade.

## Known issues

### Supabase connection drops

The worker uses a single Postgres connection. If Supabase drops it
(maintenance, connection limits, network blip), lock renewal fails
silently. The stall detector then dead-letters the job after
`max_stalled` misses.

**Current defaults that make this worse:**

- `lockDuration: 30000` (30 s) — too short for long jobs during connection blips.
- `max_stalled: 5` (schema column default on master — see `src/schema.sql`
  and `src/core/pglite-schema.ts`). Five missed heartbeats before dead-letter.
- `stalledInterval: 30000` (30 s) — checks too aggressively.

**Tune per-job today.** `gbrain jobs submit` accepts `--max-stalled N`,
`--backoff-type fixed|exponential`, `--backoff-delay <ms>`,
`--backoff-jitter 0..1`, and `--timeout-ms N` as first-class flags
(since v0.13.1). These write onto the job row at submit time — which is
what `handleStalled()` reads — so per-job tuning is the real knob today.
Worker-level `--lock-duration` / `--stall-interval` are on the roadmap;
until they land, rely on per-job `--max-stalled` plus the watchdog (or
systemd) for worker health.

### DO NOT pass `maxStalledCount` to `MinionWorker`

It's a no-op. The stall detector reads the row's `max_stalled` column
(set at submit time), not the worker opt in `src/core/minions/worker.ts:74`.
Use `gbrain jobs submit --max-stalled N` per-job instead.

### Zombie shell children

When the Bun worker crashes hard, child processes from shell jobs can
become zombies. The watchdog's 10 s `SIGTERM → SIGKILL` window covers the
shell handler's 5 s child-kill grace (`KILL_GRACE_MS`). For long-running
shell jobs, bump the watchdog's `sleep 10` to `sleep 30` so the worker
has time to flush in-flight jobs before the kill.

## Smoke test

```bash
# Worker alive?
kill -0 $(head -n1 /tmp/gbrain-worker.pid) 2>/dev/null && echo ALIVE || echo DEAD

# Aggregate queue health.
gbrain jobs stats

# Jobs currently stalled (still `active` with expired lock_until, pre-requeue).
gbrain jobs list --status active --limit 10

# Dead-lettered jobs.
gbrain jobs list --status dead --limit 10

# Shell handler registered? (stderr banner merged into log via 2>&1.)
grep "shell handler enabled" /tmp/gbrain-worker.log
```

## Uninstall

- **Option 1 (watchdog cron):** `crontab -e`, delete the watchdog line.
  `kill $(head -n1 /tmp/gbrain-worker.pid) && rm /tmp/gbrain-worker.pid`.
  Optionally `sudo rm /etc/gbrain.env /usr/local/bin/minion-watchdog.sh`.
- **Option 2 (inline `--follow`):** remove the cron entry. Nothing else to
  clean up — temporary workers exit with their jobs.
- **Option 3 (systemd):** `sudo systemctl disable --now gbrain-worker`,
  then `sudo rm /etc/systemd/system/gbrain-worker.service /etc/gbrain.env`,
  then `sudo systemctl daemon-reload`.
- **Option 3 (Fly/Render/Railway):** delete the `worker` process from
  `fly.toml` / `Procfile` and redeploy. Secrets set via `fly secrets`
  persist until `fly secrets unset`.
