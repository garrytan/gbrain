#!/bin/bash
# minion-watchdog.sh — restart gbrain jobs work if the process is dead or
# has logged a shutdown marker since its last start.
#
# Fixes the v0.16.1 restart-loop bug: old shutdown lines from previous
# restarts stayed in the unrotated log and every tick re-matched them
# forever. This version writes a restart epoch to line 2 of the PID file
# and only considers log lines newer than that epoch.
#
# Run every 5 minutes from crontab. See docs/guides/minions-deployment.md.
set -u

PID_FILE="${GBRAIN_WORKER_PID_FILE:-/tmp/gbrain-worker.pid}"
LOG_FILE="${GBRAIN_WORKER_LOG_FILE:-/tmp/gbrain-worker.log}"
GBRAIN="${GBRAIN_BIN:-/usr/local/bin/gbrain}"
CONCURRENCY="${GBRAIN_WORKER_CONCURRENCY:-2}"

start_worker() {
  # stderr merged so banner lines ("[minion worker] shell handler enabled",
  # "worker shutting down") all land in $LOG_FILE.
  nohup "$GBRAIN" jobs work --concurrency "$CONCURRENCY" \
    > "$LOG_FILE" 2>&1 &
  local pid=$!
  # Line 1: PID. Line 2: restart epoch (seconds since 1970).
  # Readers that want just PID use `head -n1 "$PID_FILE"`.
  printf '%s\n%s\n' "$pid" "$(date +%s)" > "$PID_FILE"
}

shutdown_since_restart() {
  # Only match shutdown lines logged AFTER the most recent restart epoch.
  # Worker log lines start with ISO-8601 UTC timestamps ("2026-04-21T19:05:12Z ...").
  local restart_epoch
  restart_epoch=$(sed -n '2p' "$PID_FILE" 2>/dev/null || echo 0)
  [ -z "$restart_epoch" ] && restart_epoch=0

  # POSIX-portable regex (no {n} intervals — mawk on Debian/Ubuntu rejects them).
  awk -v since="$restart_epoch" '
    match($0, /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.+Z-]+/) {
      ts_str = substr($0, RSTART, RLENGTH)
      cmd = "date -d \"" ts_str "\" +%s 2>/dev/null"
      cmd | getline ts
      close(cmd)
      if (ts + 0 > since + 0) print
    }
  ' "$LOG_FILE" 2>/dev/null | grep -q "worker stopped\|worker shutting down"
}

if [ -f "$PID_FILE" ]; then
  PID=$(head -n1 "$PID_FILE")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # Process alive — check whether the worker logged an internal shutdown
    # AFTER the last start. If yes, worker is dead-inside; restart.
    if shutdown_since_restart; then
      kill "$PID" 2>/dev/null
      # 10s grace: covers shell handler's 5s child SIGTERM→SIGKILL window
      # and leaves room for in-flight jobs to flush. Bump to 30 if your
      # jobs run > 10s.
      sleep 10
      kill -9 "$PID" 2>/dev/null
      start_worker
    fi
  else
    # PID file exists but process is gone (crash / kill -9 / reboot).
    start_worker
  fi
else
  start_worker
fi
