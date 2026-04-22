# Minions Worker Deployment Guide

## The Problem

The `gbrain jobs work` persistent worker can die silently from:
- Database connection drops (Supabase/Postgres intermittent failures)
- Lock renewal failures → stall detector dead-letters jobs
- Bun process crashes with no automatic restart
- Internal event loop death (PID alive but worker stopped)

When the worker dies, submitted jobs sit in `waiting` forever. No built-in recovery.

## Recommended Deployment Pattern

### Option 1: Watchdog Cron (recommended for persistent workers)

Run a cron every 5 minutes that checks worker health and restarts if needed:

```bash
#!/bin/bash
# minion-watchdog.sh
PID_FILE="/tmp/gbrain-worker.pid"
LOG_FILE="/tmp/gbrain-worker.log"

start_worker() {
  GBRAIN_ALLOW_SHELL_JOBS=1 nohup gbrain jobs work --concurrency 2 > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
}

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    # Check for internal shutdown (process alive but worker stopped)
    if tail -20 "$LOG_FILE" 2>/dev/null | grep -q "worker stopped\|worker shutting down"; then
      kill "$PID" 2>/dev/null; sleep 2; kill -9 "$PID" 2>/dev/null
      start_worker
    fi
  else
    start_worker
  fi
else
  start_worker
fi
```

Add to crontab: `*/5 * * * * bash /path/to/minion-watchdog.sh`

### Option 2: Inline `--follow` (recommended for cron-only workloads)

Skip the persistent worker entirely. Each cron run brings its own temporary worker:

```bash
# In your cron:
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
  --params '{"cmd":"node my-script.mjs","cwd":"/my/workspace"}' \
  --follow \
  --timeout-ms 120000
```

`--follow` starts a temporary worker, runs the job, and exits. No persistent process to babysit. 2-3 second startup overhead per job.

**Use this when:** Jobs run on a schedule (every 3h, daily, weekly). The startup overhead is negligible compared to the job duration.

**Don't use this when:** You need sub-second job pickup latency (rare).

## Known Issues

### Supabase connection drops

The worker uses a single Postgres connection. If Supabase drops it (maintenance, connection limits, network blip), lock renewal fails silently. The stall detector then dead-letters the job.

**Current defaults that make this worse:**
- `lockDuration: 30000` (30s) — too short for long jobs during connection blips
- `maxStalledCount: 1` — one missed heartbeat = dead letter
- `stalledInterval: 30000` (30s) — checks too aggressively

**Proposed CLI flags (not yet implemented):**
```
gbrain jobs work --lock-duration 120000    # 2 min
                 --max-stalled 3           # 3 strikes
                 --stall-interval 60000    # check every 60s
```

### Zombie processes

When the Bun worker crashes, child processes (shell jobs) may become zombies. The watchdog cron should also clean these up.

## Smoke Test

```bash
# Verify worker is healthy
kill -0 $(cat /tmp/gbrain-worker.pid) && echo "ALIVE" || echo "DEAD"

# Check for stalled jobs
gbrain jobs list --status waiting --limit 10

# Check for dead-lettered jobs
gbrain jobs list --status dead --limit 10

# Verify shell handler is enabled
grep "shell handler enabled" /tmp/gbrain-worker.log
```
