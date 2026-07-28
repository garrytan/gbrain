#!/usr/bin/env bash
# scripts/run-unit-parallel.sh — fast unit-test loop, parallel fan-out.
#
# Spawns N parallel `bun test` processes, each running a hash-disjoint shard
# of the unit-test set (files only — no e2e, no .slow, no .serial). After
# all shards complete, runs serial-only files (*.serial.test.ts) with
# --max-concurrency=1. Failure-first logging: extracts failure blocks from
# each shard's log, writes to .context/test-failures.log with --- shard $i:
# prefixes, prints loud stderr banner if any failures, exit non-zero.
#
# Usage:
#   bash scripts/run-unit-parallel.sh [--shards N] [--max-concurrency N] [--dry-run]
#
# Env overrides:
#   SHARDS=N                     same as --shards
#   GBRAIN_TEST_SHARD_TIMEOUT    per-shard wallclock cap, seconds (default 600)
#   GBRAIN_TEST_MAX_CONCURRENCY  passed through to bun test (default chosen
#                               so shards × intra-shard concurrency <= 2)
#
# Output files (workspace-local; falls back to /tmp if .context/ unwritable):
#   .context/test-failures.log   failure blocks (cleared at start)
#   .context/test-summary.txt    per-shard pass/fail/skip/duration (cleared at start)
#   .context/test-shards/        per-shard logs + exit codes (cleared at start)

set -uo pipefail

cd "$(dirname "$0")/.."

# Process-safety state. The signal handler walks each shard subprocess tree
# before terminating the wrapper, so Ctrl-C/HUP/TERM cannot leave timeout or
# Bun workers consuming resources after the parent session disappears.
SHARD_PIDS=()
HB_PID=""
CLEANUP_RUNNING=0
RUN_LOCK_DIR=".context/unit-parallel.lock"
RUN_LOCK_HELD=0

child_pids() {
  local parent_pid="$1"
  if command -v ps >/dev/null 2>&1; then
    ps -eo pid=,ppid= 2>/dev/null |
      awk -v parent="$parent_pid" '$2 == parent { print $1 }'
    return
  fi

  # Minimal Docker images may omit procps entirely. Linux /proc still exposes
  # field 4 (parent PID) in /proc/<pid>/stat, so signal cleanup must not
  # silently degrade to killing only the shard shell and orphaning workers.
  if [ -d /proc ]; then
    local proc_stat proc_pid proc_row proc_rest proc_ppid
    for proc_stat in /proc/[0-9]*/stat; do
      [ -r "$proc_stat" ] || continue
      proc_pid="${proc_stat#/proc/}"
      proc_pid="${proc_pid%/stat}"
      proc_row=$(cat "$proc_stat" 2>/dev/null) || continue
      proc_rest="${proc_row##*) }"
      # After stripping "pid (comm) ", fields start at state; PPID is second.
      set -- $proc_rest
      proc_ppid="${2:-}"
      [ "$proc_ppid" = "$parent_pid" ] && echo "$proc_pid"
    done
  fi
}

descendant_pids() {
  local parent_pid="$1"
  local child_pid
  for child_pid in $(child_pids "$parent_pid"); do
    descendant_pids "$child_pid"
    echo "$child_pid"
  done
}

terminate_pid_tree() {
  local root_pid="$1"
  local descendants
  descendants=$(descendant_pids "$root_pid")
  if [ -n "$descendants" ]; then
    # Intentional word splitting: each line is a numeric PID discovered from
    # the still-live parent tree immediately above.
    kill -TERM $descendants 2>/dev/null || true
  fi
  kill -TERM "$root_pid" 2>/dev/null || true

  # A stuck WASM worker may ignore TERM. Bound cleanup itself so an
  # interrupted test run cannot keep the controlling session open forever.
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$root_pid" 2>/dev/null || break
    sleep 0.2
  done
  if [ -n "$descendants" ]; then
    kill -KILL $descendants 2>/dev/null || true
  fi
  kill -KILL "$root_pid" 2>/dev/null || true
}

release_run_lock() {
  if [ "$RUN_LOCK_HELD" = "1" ] && [ -f "$RUN_LOCK_DIR/pid" ] && \
     [ "$(cat "$RUN_LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -f "$RUN_LOCK_DIR/pid"
    rmdir "$RUN_LOCK_DIR" 2>/dev/null || true
  fi
  RUN_LOCK_HELD=0
}

cleanup_children() {
  [ "$CLEANUP_RUNNING" = "1" ] && return
  CLEANUP_RUNNING=1
  if [ -n "$HB_PID" ]; then
    kill "$HB_PID" 2>/dev/null || true
    wait "$HB_PID" 2>/dev/null || true
    HB_PID=""
  fi
  local shard_pid
  for shard_pid in "${SHARD_PIDS[@]}"; do
    terminate_pid_tree "$shard_pid"
  done
  for shard_pid in "${SHARD_PIDS[@]}"; do
    wait "$shard_pid" 2>/dev/null || true
  done
}

on_signal() {
  trap - HUP INT TERM
  echo "[unit-parallel] interrupted; stopping all shard process trees..." >&2
  cleanup_children
  exit 130
}

on_exit() {
  local rc=$?
  release_run_lock
  return "$rc"
}

trap on_signal HUP INT TERM
trap on_exit EXIT

# ──────────────────────────────────────────────────────────────────────────
# CPU detection: Apple Silicon perf cores → Mac total physical → nproc → 4.
# Returns a single positive integer.
# ──────────────────────────────────────────────────────────────────────────
detect_cpus() {
  local n=""
  n=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  n=$(sysctl -n hw.physicalcpu 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  n=$(nproc 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  echo 4
}

# ──────────────────────────────────────────────────────────────────────────
# Argument parsing. --shards N override wins over $SHARDS; both are clamped.
# ──────────────────────────────────────────────────────────────────────────
SHARDS_OVERRIDE=""
MAX_CONCURRENCY_OVERRIDE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --shards) SHARDS_OVERRIDE="$2"; shift 2 ;;
    --shards=*) SHARDS_OVERRIDE="${1#*=}"; shift ;;
    --max-concurrency) MAX_CONCURRENCY_OVERRIDE="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONCURRENCY_OVERRIDE="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$SHARDS_OVERRIDE" ]; then
  N="$SHARDS_OVERRIDE"
elif [ -n "${SHARDS:-}" ]; then
  N="$SHARDS"
else
  N="$(detect_cpus)"
  # Cap the default fan-out to keep PGLite WASM cold starts within practical
  # memory/CPU limits on constrained CI and VPS hosts. Four simultaneous
  # processes can still push otherwise-fast hooks beyond their 60s timeout.
  [ "$N" -gt 2 ] && N=2
fi
if ! printf '%s' "$N" | grep -qE '^[0-9]+$' || [ "$N" -lt 1 ]; then
  echo "ERROR: invalid shard count: $N" >&2; exit 2
fi
[ "$N" -gt 8 ] && N=8

if [ -n "$MAX_CONCURRENCY_OVERRIDE" ]; then
  INTRA_CONC="$MAX_CONCURRENCY_OVERRIDE"
elif [ -n "${GBRAIN_TEST_MAX_CONCURRENCY:-}" ]; then
  INTRA_CONC="$GBRAIN_TEST_MAX_CONCURRENCY"
else
  # PGLite's WASM cold-start is memory/CPU heavy. Using the historical
  # default of four tests inside each of eight shards created up to 32
  # concurrent runtimes and made otherwise-passing tests hit their 60s
  # timeout on constrained CI/VPS hosts.
  INTRA_CONC=$((2 / N))
  [ "$INTRA_CONC" -lt 1 ] && INTRA_CONC=1
fi
SHARD_TIMEOUT="${GBRAIN_TEST_SHARD_TIMEOUT:-600}"

# ──────────────────────────────────────────────────────────────────────────
# Output directories. Prefer workspace-local .context/, fall back to /tmp.
# ──────────────────────────────────────────────────────────────────────────
LOG_DIR=""
if mkdir -p .context/test-shards 2>/dev/null; then
  LOG_DIR=".context/test-shards"
  FAILURES_LOG=".context/test-failures.log"
  SUMMARY_FILE=".context/test-summary.txt"
else
  LOG_DIR="/tmp/gbrain-test-shards-$$"
  FAILURES_LOG="/tmp/gbrain-test-failures.log"
  SUMMARY_FILE="/tmp/gbrain-test-summary.txt"
  mkdir -p "$LOG_DIR" || { echo "ERROR: cannot create log dir" >&2; exit 2; }
fi
# ──────────────────────────────────────────────────────────────────────────
# Resolve `timeout` command. macOS without coreutils has neither; we degrade
# to bg-pid + sleep cap. For now, prefer gtimeout (brew coreutils) → timeout.
# ──────────────────────────────────────────────────────────────────────────
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi

START_TS=$(date +%s)
echo "[unit-parallel] N=$N shards | --max-concurrency=$INTRA_CONC | timeout=${SHARD_TIMEOUT}s | logs=$LOG_DIR" >&2

if [ "$DRY_RUN" = "1" ]; then
  echo "[unit-parallel] dry-run: would spawn $N shards with the above settings."
  for i in $(seq 1 "$N"); do
    SHARD="$i/$N" bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null \
      | sed "s|^|  [s$i] |"
  done
  exit 0
fi

# Refuse overlapping full-suite runs in the same worktree. A stale lock is
# recovered only when its recorded PID is no longer alive.
if mkdir "$RUN_LOCK_DIR" 2>/dev/null; then
  RUN_LOCK_HELD=1
else
  lock_pid=""
  [ -f "$RUN_LOCK_DIR/pid" ] && lock_pid=$(cat "$RUN_LOCK_DIR/pid" 2>/dev/null)
  if printf '%s' "$lock_pid" | grep -qE '^[0-9]+$' && kill -0 "$lock_pid" 2>/dev/null; then
    echo "ERROR: unit test suite already running (pid=$lock_pid)" >&2
    exit 2
  fi
  rm -f "$RUN_LOCK_DIR/pid" 2>/dev/null
  rmdir "$RUN_LOCK_DIR" 2>/dev/null || {
    echo "ERROR: cannot recover stale test lock: $RUN_LOCK_DIR" >&2
    exit 2
  }
  mkdir "$RUN_LOCK_DIR" || {
    echo "ERROR: cannot acquire test lock: $RUN_LOCK_DIR" >&2
    exit 2
  }
  RUN_LOCK_HELD=1
fi
echo "$$" > "$RUN_LOCK_DIR/pid"

# Clear prior artifacts only after acquiring the single-run lock, so a second
# invocation can never truncate the active suite's logs before being refused.
rm -f "$LOG_DIR"/shard-*.log "$LOG_DIR"/shard-*.exit "$LOG_DIR"/shard-*.wedged 2>/dev/null
: > "$FAILURES_LOG"
: > "$SUMMARY_FILE"

# ──────────────────────────────────────────────────────────────────────────
# Spawn shards. Each child captures its own exit code into a sentinel file
# so $? is recoverable per-shard (we never trust `wait`'s aggregate value).
# ──────────────────────────────────────────────────────────────────────────
for i in $(seq 1 "$N"); do
  (
    SHARD_LOG="$LOG_DIR/shard-$i.log"
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" --kill-after=5s "${SHARD_TIMEOUT}s" \
        env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1
    else
      env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1 &
      pid=$!
      ( sleep "$SHARD_TIMEOUT" && kill -TERM "$pid" 2>/dev/null && \
        sleep 5 && kill -KILL "$pid" 2>/dev/null ) &
      cap_pid=$!
      wait "$pid" 2>/dev/null
      kill "$cap_pid" 2>/dev/null
      wait "$cap_pid" 2>/dev/null
    fi
    rc=$?
    echo "$rc" > "$LOG_DIR/shard-$i.exit"
    [ "$rc" = "124" ] && echo "WEDGED" > "$LOG_DIR/shard-$i.wedged"
  ) &
  SHARD_PIDS+=($!)
done

# ──────────────────────────────────────────────────────────────────────────
# Heartbeat: every 10s, print per-shard progress to stderr by tailing logs
# and counting Bun's `(pass)` / `(fail)` / `(skip)` markers. Read-only.
# ──────────────────────────────────────────────────────────────────────────
# grep_count: returns 0 (single integer) if file is missing or zero matches,
# otherwise the match count. Avoids the `grep -c | echo 0` double-output bug
# where 0 matches produces a 2-line "0\n0" string that breaks arithmetic.
grep_count() {
  local pattern="$1"; local file="$2"
  if [ ! -f "$file" ]; then echo 0; return; fi
  local n
  n=$(grep -cE "$pattern" "$file" 2>/dev/null) || n=0
  echo "${n:-0}"
}

# bun_summary_count: parses Bun's summary lines (one per `bun test` invocation
# inside a shard — there's only one when we pass an explicit file list).
# Looks for ` N pass` / ` N fail` / ` N skip` patterns and sums them across
# all summary blocks the shard emitted. `bun test` prints these near the end
# of its output. Format: leading whitespace + integer + space + label.
bun_summary_count() {
  local label="$1"; local file="$2"
  if [ ! -f "$file" ]; then echo 0; return; fi
  awk -v label="$label" '
    $1 ~ /^[0-9]+$/ && $2 == label { total += $1 }
    END { print total + 0 }
  ' "$file"
}

heartbeat() {
  while true; do
    sleep 10
    local line=""
    for i in $(seq 1 "$N"); do
      if [ -f "$LOG_DIR/shard-$i.exit" ]; then
        local rc; rc=$(cat "$LOG_DIR/shard-$i.exit" 2>/dev/null || echo "?")
        local status="✓"
        [ "$rc" != "0" ] && status="✗"
        line="$line [s$i: done $status]"
      else
        local lf="$LOG_DIR/shard-$i.log"
        if [ -f "$lf" ]; then
          # Heartbeat: prefer Bun's per-test "✓" (passed) and "(fail)" markers
          # so we see live progress; the "N pass" summary line only appears at
          # the very end of the shard and would always show 0 mid-run.
          local p f
          p=$(grep_count '^[[:space:]]+✓' "$lf")
          f=$(grep_count '^\(fail\)' "$lf")
          line="$line [s$i: ${p}p ${f}f ...]"
        else
          line="$line [s$i: starting]"
        fi
      fi
    done
    printf '[heartbeat] %s\n' "$line" >&2
  done
}
heartbeat &
HB_PID=$!

# Wait for every shard. Don't care about wait's exit code.
for pid in "${SHARD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

kill "$HB_PID" 2>/dev/null
wait "$HB_PID" 2>/dev/null
HB_PID=""

# ──────────────────────────────────────────────────────────────────────────
# Aggregate failures (single writer; serial; never concurrent).
# Bun failure block format: from `(fail) ...` line through next `(pass)`,
# `(skip)`, blank line, or `__bun_test_summary__` marker.
# ──────────────────────────────────────────────────────────────────────────
TOTAL_FAILURES=0
TOTAL_PASS=0
TOTAL_SKIP=0
TOTAL_RC=0
for i in $(seq 1 "$N"); do
  SHARD_LOG="$LOG_DIR/shard-$i.log"
  EXIT_FILE="$LOG_DIR/shard-$i.exit"
  WEDGED_FILE="$LOG_DIR/shard-$i.wedged"
  rc=1
  [ -f "$EXIT_FILE" ] && rc=$(cat "$EXIT_FILE" 2>/dev/null || echo 1)

  pass_count=$(bun_summary_count "pass" "$SHARD_LOG")
  fail_count=$(bun_summary_count "fail" "$SHARD_LOG")
  skip_count=$(bun_summary_count "skip" "$SHARD_LOG")
  TOTAL_PASS=$((TOTAL_PASS + pass_count))
  TOTAL_FAILURES=$((TOTAL_FAILURES + fail_count))
  TOTAL_SKIP=$((TOTAL_SKIP + skip_count))

  if [ -f "$WEDGED_FILE" ]; then
    TOTAL_RC=1
    {
      echo "--- shard $i: WEDGED after ${SHARD_TIMEOUT}s ---"
      [ -f "$SHARD_LOG" ] && tail -50 "$SHARD_LOG"
      echo ""
    } >> "$FAILURES_LOG"
    echo "shard $i/$N: WEDGED after ${SHARD_TIMEOUT}s (rc=$rc)" >> "$SUMMARY_FILE"
    continue
  fi

  echo "shard $i/$N: pass=$pass_count fail=$fail_count skip=$skip_count rc=$rc" >> "$SUMMARY_FILE"

  if [ "$rc" != "0" ]; then
    TOTAL_RC=1
    if [ "$fail_count" -gt 0 ] && [ -f "$SHARD_LOG" ]; then
      # Extract each (fail) block: from `(fail)` line through next `(pass)`,
      # `(skip)`, blank line, or `__bun_test_summary__`. Single awk pass.
      awk -v shard="$i" '
        /^\(fail\) / { in_block=1; print "--- shard " shard ": " $0; next }
        in_block {
          if (/^\(pass\)/ || /^\(skip\)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' "$SHARD_LOG" >> "$FAILURES_LOG"
    elif [ -f "$SHARD_LOG" ]; then
      # Non-zero rc but no (fail) line found — extraction couldn't pinpoint.
      # Dump the full shard log so we never silently lose the failure cause.
      {
        echo "--- shard $i: rc=$rc, no (fail) markers — full log follows ---"
        cat "$SHARD_LOG"
        echo ""
      } >> "$FAILURES_LOG"
    fi
  fi
done

# ──────────────────────────────────────────────────────────────────────────
# Print each shard's full output to stdout (developer expects to scroll
# through it). Print summary file last for one-glance overview.
# ──────────────────────────────────────────────────────────────────────────
for i in $(seq 1 "$N"); do
  SHARD_LOG="$LOG_DIR/shard-$i.log"
  echo ""
  echo "════════════ shard $i/$N ════════════"
  [ -f "$SHARD_LOG" ] && cat "$SHARD_LOG"
done
echo ""
echo "════════════ summary ════════════"
cat "$SUMMARY_FILE"
echo ""

# ──────────────────────────────────────────────────────────────────────────
# Serial pass: any *.serial.test.ts files run after parallel pass.
# ──────────────────────────────────────────────────────────────────────────
SERIAL_RC=0
SERIAL_FILES_COUNT=0
SERIAL_FILES_COUNT=$(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$SERIAL_FILES_COUNT" -gt 0 ]; then
  echo "════════════ serial pass ($SERIAL_FILES_COUNT files) ════════════"
  bash scripts/run-serial-tests.sh > "$LOG_DIR/serial.log" 2>&1
  SERIAL_RC=$?
  cat "$LOG_DIR/serial.log"
  if [ "$SERIAL_RC" != "0" ]; then
    TOTAL_RC=1
    s_fail=$(bun_summary_count "fail" "$LOG_DIR/serial.log")
    TOTAL_FAILURES=$((TOTAL_FAILURES + s_fail))
    if [ "$s_fail" -gt 0 ]; then
      awk '
        /^\(fail\) / { in_block=1; print "--- shard serial: " $0; next }
        in_block {
          if (/^\(pass\)/ || /^\(skip\)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' "$LOG_DIR/serial.log" >> "$FAILURES_LOG"
    else
      {
        echo "--- shard serial: rc=$SERIAL_RC, no (fail) markers — full log follows ---"
        cat "$LOG_DIR/serial.log"
        echo ""
      } >> "$FAILURES_LOG"
    fi
    echo "serial: rc=$SERIAL_RC fail=$s_fail" >> "$SUMMARY_FILE"
  else
    s_pass=$(bun_summary_count "pass" "$LOG_DIR/serial.log")
    TOTAL_PASS=$((TOTAL_PASS + s_pass))
    echo "serial: pass=$s_pass rc=0" >> "$SUMMARY_FILE"
  fi
fi

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

# ──────────────────────────────────────────────────────────────────────────
# Loud banner if anything failed. To stderr so it survives `| head`/`| tail`.
# ──────────────────────────────────────────────────────────────────────────
if [ "$TOTAL_RC" != "0" ]; then
  ABS_FAIL=$(cd "$(dirname "$FAILURES_LOG")" && pwd)/$(basename "$FAILURES_LOG")
  {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "❌ $TOTAL_FAILURES TEST FAILURES — full details:"
    echo "   $ABS_FAIL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    tail -30 "$FAILURES_LOG"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP"
  } >&2
  exit 1
fi

echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP" >&2
exit 0
