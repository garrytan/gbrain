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
#   SHARDS=N                          same as --shards
#   GBRAIN_TEST_MAX_CONCURRENCY       passed through to bun test (default 4)
#   GBRAIN_TEST_SHARD_TIMEOUT         per-shard wallclock cap, seconds. Default is
#                                     DERIVED (see "Per-shard caps" below), not a
#                                     constant; set this to pin it explicitly.
#   GBRAIN_TEST_SECONDS_PER_FILE      per-file budget the derived cap is built from
#                                     (default: 6 on Unix, 30 on Windows).
#   GBRAIN_TEST_SHARD_STALL_SECONDS   kill a shard that writes nothing to its log
#                                     for this long (default 600; 0 disables).
#
# Output files (workspace-local; falls back to /tmp if .context/ unwritable):
#   .context/test-failures.log   failure blocks (cleared at start)
#   .context/test-summary.txt    per-shard pass/fail/skip/duration (cleared at start)
#   .context/test-shards/        per-shard logs + exit codes (cleared at start)

set -uo pipefail

cd "$(dirname "$0")/.."

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

N="${SHARDS_OVERRIDE:-${SHARDS:-$(detect_cpus)}}"
if ! printf '%s' "$N" | grep -qE '^[0-9]+$' || [ "$N" -lt 1 ]; then
  echo "ERROR: invalid shard count: $N" >&2; exit 2
fi
# v0.40.10 flake-hardening: clamp default to 4 (was 8) to match CI's
# test-shard.sh fan-out. At 8-shard parallel on Apple Silicon we observed
# shard 5 SIGKILL during source-health.test.ts's PGLite migration replay —
# 8 parallel PGLite WASM inits contend severely on the lockfile, and the
# 92-migration replay × 8 simultaneous can wedge past even 900s. CI uses
# 4 and is stable. Trade ~2x wallclock for reliability + parity with CI's
# fan-out. Override via --shards N or SHARDS=N (still capped at 8).
[ "$N" -gt 8 ] && N=8
if [ -z "${SHARDS_OVERRIDE:-}" ] && [ -z "${SHARDS:-}" ] && [ "$N" -gt 4 ]; then
  N=4
fi

INTRA_CONC="${MAX_CONCURRENCY_OVERRIDE:-${GBRAIN_TEST_MAX_CONCURRENCY:-4}}"

# ──────────────────────────────────────────────────────────────────────────
# Per-shard caps.
#
# TWO independent guards, because one number cannot do both jobs:
#
#   1. SHARD_TIMEOUT — wallclock backstop. DERIVED, never a bare constant:
#      per-file budget × files-per-shard. A constant encodes a snapshot of
#      (suite size × host speed) and silently rots when either moves. It has
#      rotted twice: 900s was sized for the 8-shard/~80-file split and
#      false-killed the 4-shard/159-file split (v0.40.10), and its 1500s
#      successor — calibrated on Apple Silicon at ~6s/file — false-killed
#      ALL FOUR shards on Windows, where per-file process spawn + module load
#      + PGLite WASM init is several times slower. Deriving from the file
#      count means growing the suite no longer re-breaks the cap.
#
#   2. STALL_SECONDS — progress watchdog. The wallclock cap must be generous
#      to be safe, which makes it a poor hang detector (a genuinely hung
#      shard would ride it for hours). A shard that has written NOTHING to
#      its log for this long is not slow, it is stuck. Same instrument
#      gbrain already uses for sync (GBRAIN_SYNC_STALL_ABORT_SECONDS): watch
#      forward progress, not elapsed time. Default 600s is 10× bun's 60s
#      per-test cap, so it clears any legitimate quiet period with room to
#      spare on a loaded box.
#
# Bias for both: too high costs a longer wait before a real hang is reported;
# too low false-kills healthy runs and makes the suite unusable. Bias high.
# ──────────────────────────────────────────────────────────────────────────
UNIX_SECONDS_PER_FILE=6
WINDOWS_SECONDS_PER_FILE=30
SHARD_TIMEOUT_FLOOR=600

# Windows here means the MSYS2 / Git-Bash / Cygwin userland this script runs
# under; `uname -s` reports MINGW*/MSYS*/CYGWIN* there. $OS is the belt-and-
# suspenders fallback for a userland whose uname doesn't say so. WSL reports
# Linux and does not set $OS — correctly treated as Unix.
detect_seconds_per_file() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) echo "$WINDOWS_SECONDS_PER_FILE"; return ;;
  esac
  if [ "${OS:-}" = "Windows_NT" ]; then echo "$WINDOWS_SECONDS_PER_FILE"; return; fi
  echo "$UNIX_SECONDS_PER_FILE"
}

# Ask the shard runner itself for the file set, rather than duplicating its
# `find` expression here — the exclusion list (e2e / .slow / .serial) lives in
# ONE place and can't drift. SHARD= (empty) makes it list the unsharded set.
count_unit_files() {
  local n
  n=$(SHARD= bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null | wc -l | tr -d ' ')
  printf '%s' "${n:-0}"
}

require_positive_int() {
  local name="$1"; local val="$2"
  if ! printf '%s' "$val" | grep -qE '^[0-9]+$' || [ "$val" -lt 1 ]; then
    echo "ERROR: $name must be a positive integer, got: $val" >&2; exit 2
  fi
}

SECONDS_PER_FILE="${GBRAIN_TEST_SECONDS_PER_FILE:-$(detect_seconds_per_file)}"
require_positive_int "GBRAIN_TEST_SECONDS_PER_FILE" "$SECONDS_PER_FILE"

TOTAL_UNIT_FILES=$(count_unit_files)
if [ "$TOTAL_UNIT_FILES" -gt 0 ]; then
  FILES_PER_SHARD=$(( (TOTAL_UNIT_FILES + N - 1) / N ))
else
  # Discovery failed (bad cwd, unreadable test/). Fail open to the floor
  # rather than deriving a nonsense cap of 0 and killing every shard.
  FILES_PER_SHARD=0
fi
DERIVED_TIMEOUT=$(( FILES_PER_SHARD * SECONDS_PER_FILE ))
[ "$DERIVED_TIMEOUT" -lt "$SHARD_TIMEOUT_FLOOR" ] && DERIVED_TIMEOUT="$SHARD_TIMEOUT_FLOOR"

if [ -n "${GBRAIN_TEST_SHARD_TIMEOUT:-}" ]; then
  SHARD_TIMEOUT="$GBRAIN_TEST_SHARD_TIMEOUT"
  require_positive_int "GBRAIN_TEST_SHARD_TIMEOUT" "$SHARD_TIMEOUT"
  TIMEOUT_ORIGIN="env GBRAIN_TEST_SHARD_TIMEOUT"
elif [ "$FILES_PER_SHARD" -gt 0 ] && [ "$DERIVED_TIMEOUT" -gt "$SHARD_TIMEOUT_FLOOR" ]; then
  SHARD_TIMEOUT="$DERIVED_TIMEOUT"
  TIMEOUT_ORIGIN="${FILES_PER_SHARD} files/shard × ${SECONDS_PER_FILE}s"
else
  SHARD_TIMEOUT="$DERIVED_TIMEOUT"
  TIMEOUT_ORIGIN="floor ${SHARD_TIMEOUT_FLOOR}s"
fi

STALL_SECONDS="${GBRAIN_TEST_SHARD_STALL_SECONDS:-600}"
if ! printf '%s' "$STALL_SECONDS" | grep -qE '^[0-9]+$'; then
  echo "ERROR: GBRAIN_TEST_SHARD_STALL_SECONDS must be a non-negative integer, got: $STALL_SECONDS" >&2
  exit 2
fi
STALL_POLL=10

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
# Clear from prior run.
rm -f "$LOG_DIR"/shard-*.log "$LOG_DIR"/shard-*.exit \
      "$LOG_DIR"/shard-*.wedged "$LOG_DIR"/shard-*.stalled 2>/dev/null
: > "$FAILURES_LOG"
: > "$SUMMARY_FILE"

# ──────────────────────────────────────────────────────────────────────────
# Resolve `timeout` command. macOS without coreutils has neither; we degrade
# to bg-pid + sleep cap. For now, prefer gtimeout (brew coreutils) → timeout.
# ──────────────────────────────────────────────────────────────────────────
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi

START_TS=$(date +%s)
# Show HOW the cap was derived, not just its value — the next person staring
# at a WEDGED shard needs to know which knob to turn.
if [ "$STALL_SECONDS" -gt 0 ]; then
  STALL_NOTE="stall=${STALL_SECONDS}s"
else
  STALL_NOTE="stall=off"
fi
echo "[unit-parallel] N=$N shards | --max-concurrency=$INTRA_CONC | timeout=${SHARD_TIMEOUT}s (${TIMEOUT_ORIGIN}) | ${STALL_NOTE} | logs=$LOG_DIR" >&2

if [ "$DRY_RUN" = "1" ]; then
  echo "[unit-parallel] dry-run: would spawn $N shards with the above settings."
  for i in $(seq 1 "$N"); do
    SHARD="$i/$N" bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null \
      | sed "s|^|  [s$i] |"
  done
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Stall watchdog. Polls one shard's log size; if it hasn't grown in
# STALL_SECONDS the shard is stuck (not merely slow) — drop the sentinel and
# tear down its process tree. Log size is strictly monotonic while a shard is
# alive, so it is the one liveness signal bun's default reporter always
# leaves behind (it prints no per-file progress markers, only a final
# summary).
#
# Kills the work FIRST, then the leader, and goes straight to SIGKILL. Both
# choices are deliberate:
#   - run-unit-shard.sh ends in `exec bun test`, so under timeout(1) the tree
#     is `timeout` → `bun` (the intermediate env/bash are exec'd away).
#     pkill -P therefore reaches bun itself.
#   - No TERM-then-grace ladder. A grace period here is a race: the moment the
#     leader dies the shard subshell's `wait` returns and tears this watchdog
#     down, which would strand a bun that hadn't finished honoring SIGTERM.
#     We have already concluded the shard is hung, and its output is written
#     straight to the log by redirect, so there is nothing to flush politely.
# ──────────────────────────────────────────────────────────────────────────
stall_watchdog() {
  local pid="$1" logf="$2" sentinel="$3"
  [ "$STALL_SECONDS" -gt 0 ] || return 0
  local last_size=-1 last_change size now
  last_change=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$STALL_POLL"
    # An unreadable log reads as 0. That is intentional: a shard whose log
    # never appears at all is as stuck as one whose log stopped growing, and
    # bun writes its version banner immediately on a healthy start.
    size=$(wc -c < "$logf" 2>/dev/null | tr -d ' ')
    size="${size:-0}"
    now=$(date +%s)
    if [ "$size" != "$last_size" ]; then
      last_size="$size"
      last_change="$now"
    elif [ $((now - last_change)) -ge "$STALL_SECONDS" ]; then
      echo "STALLED" > "$sentinel"
      pkill -KILL -P "$pid" 2>/dev/null
      kill -KILL "$pid" 2>/dev/null
      return 0
    fi
  done
}

# ──────────────────────────────────────────────────────────────────────────
# Spawn shards. Each child captures its own exit code into a sentinel file
# so $? is recoverable per-shard (we never trust `wait`'s aggregate value).
# ──────────────────────────────────────────────────────────────────────────
SHARD_PIDS=()
for i in $(seq 1 "$N"); do
  (
    SHARD_LOG="$LOG_DIR/shard-$i.log"
    # Create the log up front so the watchdog's first poll reads a real size
    # instead of treating a not-yet-created file as a stall.
    : > "$SHARD_LOG"
    if [ -n "$TIMEOUT_BIN" ]; then
      # timeout(1) owns the wallclock cap (and gives us rc=124 for free);
      # the watchdog only has to catch stalls.
      "$TIMEOUT_BIN" "${SHARD_TIMEOUT}s" \
        env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1 &
      run_pid=$!
      cap_pid=""
    else
      env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1 &
      run_pid=$!
      # No timeout(1): a sleep-then-kill sibling enforces the wallclock cap.
      ( sleep "$SHARD_TIMEOUT" && echo "WEDGED" > "$LOG_DIR/shard-$i.wedged" && \
        kill -TERM "$run_pid" 2>/dev/null && \
        sleep 5 && kill -KILL "$run_pid" 2>/dev/null ) &
      cap_pid=$!
    fi

    stall_watchdog "$run_pid" "$SHARD_LOG" "$LOG_DIR/shard-$i.stalled" &
    wd_pid=$!

    wait "$run_pid" 2>/dev/null
    # Capture the shard's status from ITS wait, before any teardown below
    # overwrites $?. A killed watchdog reports 143; letting that land in the
    # sentinel is how every shard once "failed" with rc=143 even when green.
    rc=$?

    # Reap the watchdog and the cap sibling, children first: SIGTERM to a
    # shell parked in `sleep` doesn't reach the sleep, so killing only the
    # subshell orphans it until its timer expires. CI's orphan sweep reports
    # those as phantom test failures.
    for helper in "$wd_pid" "$cap_pid"; do
      [ -n "$helper" ] || continue
      pkill -P "$helper" 2>/dev/null
      kill "$helper" 2>/dev/null
      wait "$helper" 2>/dev/null
    done

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

# shard_total_files: parse the "[unit-shard N/M] running X files" line that
# run-unit-shard.sh echoes before invoking bun test. Returns the file count
# the shard was given, or 0 if the line isn't there yet (shard still
# bootstrapping). Uses sed-then-grep so it's portable to macOS awk (BSD awk
# doesn't support `match($0, /re/, arr)` with the array sink — that's gawk-only).
shard_total_files() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  local n
  n=$(sed -n 's/^\[unit-shard [0-9][0-9]*\/[0-9][0-9]*\] running \([0-9][0-9]*\) files.*/\1/p' "$file" 2>/dev/null | head -1)
  echo "${n:-0}"
}

# shard_pglite_init_count: count "Schema version" lines as a proxy for "test
# files initialized so far." Each PGLite-using test file's beforeAll triggers
# one initSchema() which prints this. Undercounts because not every test file
# opens a PGLite engine, but it's the only real-time progress signal bun's
# default reporter leaves in the log (bun has no per-file progress markers,
# only a final shard-end summary).
shard_pglite_init_count() {
  # Routed through grep_count deliberately: a bare `grep -c ... || echo 0`
  # prints BOTH grep's own "0" and the fallback "0" on no-match, and the
  # resulting two-line value renders as "~0\n0/253f" in the heartbeat.
  grep_count 'Schema version [0-9]+ . [0-9]+' "$1"
}

# shard_quiet_seconds: how long since the shard last wrote anything. This is
# what the stall watchdog keys on, surfaced in the heartbeat so a run that is
# drifting toward a stall abort is visible before it gets killed.
shard_quiet_seconds() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  local mtime now
  # GNU coreutils then BSD/macOS. (`date -r` is NOT portable here: on macOS it
  # reads a timestamp argument, not a file.)
  mtime=$(stat -c %Y "$file" 2>/dev/null)
  [ -n "$mtime" ] || mtime=$(stat -f %m "$file" 2>/dev/null)
  [ -n "$mtime" ] || { echo 0; return; }
  now=$(date +%s)
  echo $(( now - mtime ))
}

# log_size_kb: total stderr+stdout written by the shard so far. Strictly
# monotonic — useful as a "definitely alive" signal when other heuristics
# read 0 (e.g. very early in shard startup before initSchema fires).
log_size_kb() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  local b
  b=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
  echo $(( ${b:-0} / 1024 ))
}

# fmt_elapsed: pretty-print seconds → "Mm:SS" or "SSs" for short.
fmt_elapsed() {
  local s=$1
  if [ "$s" -ge 60 ]; then
    printf '%dm%02ds' $((s / 60)) $((s % 60))
  else
    printf '%ds' "$s"
  fi
}

heartbeat() {
  local hb_start=$(date +%s)
  while true; do
    sleep 10
    local line=""
    local now; now=$(date +%s)
    local hb_elapsed=$((now - hb_start))
    for i in $(seq 1 "$N"); do
      if [ -f "$LOG_DIR/shard-$i.exit" ]; then
        local rc; rc=$(cat "$LOG_DIR/shard-$i.exit" 2>/dev/null || echo "?")
        local status="✓"
        [ "$rc" != "0" ] && status="✗"
        local f
        f=$(bun_summary_count "fail" "$LOG_DIR/shard-$i.log")
        local p
        p=$(bun_summary_count "pass" "$LOG_DIR/shard-$i.log")
        line="$line [s$i: done $status ${p}p ${f}f]"
      else
        local lf="$LOG_DIR/shard-$i.log"
        if [ -f "$lf" ]; then
          # Bun's default reporter has no per-file progress markers, only a
          # final shard-end summary, so we surface three complementary signals
          # mid-run: (1) PGLite initSchema() count as a "files started" proxy,
          # (2) total files this shard was assigned (from the runner banner),
          # (3) log size in KB as a strictly-monotonic liveness signal.
          local total; total=$(shard_total_files "$lf")
          local pglite; pglite=$(shard_pglite_init_count "$lf")
          local kb; kb=$(log_size_kb "$lf")
          local et; et=$(fmt_elapsed "$hb_elapsed")
          # Surface a lengthening quiet period once it's over a minute — this
          # is the signal the stall watchdog will act on, so showing it early
          # turns a surprise kill into something you saw coming.
          local quiet; quiet=$(shard_quiet_seconds "$lf")
          local qnote=""
          if [ "$STALL_SECONDS" -gt 0 ] && [ "$quiet" -ge 60 ]; then
            qnote=" quiet ${quiet}s/${STALL_SECONDS}s"
          fi
          if [ "$total" -gt 0 ]; then
            line="$line [s$i: ~${pglite}/${total}f ${kb}KB ${et}${qnote}]"
          else
            line="$line [s$i: starting ${kb}KB ${et}${qnote}]"
          fi
        else
          line="$line [s$i: spawning]"
        fi
      fi
    done
    printf '[heartbeat] %s\n' "$line" >&2
  done
}
heartbeat &
HB_PID=$!
# v0.41.11.0 cleanup: pkill children FIRST, then kill heartbeat. If we
# kill the heartbeat shell first, its current `sleep 10` is reparented
# to init/launchd and pkill -P can no longer find it (orphan). Order:
# children first while the parent PID is still findable, then parent.
# Known bash quirk: SIGTERM to a shell sleeping inside `sleep` doesn't
# propagate to the sleep child before the wait returns. Without this,
# each invocation of this script leaks ONE orphan sleep; CI's "orphan
# process cleanup" at end-of-job reports them as (unnamed) test failures.
# Seen on the garrytan/port-pr-1406 PR, 2 CI runs in a row, 6 orphans
# matching the 6 invocations in test/scripts/run-unit-parallel.test.ts.
trap 'pkill -P "$HB_PID" 2>/dev/null; kill "$HB_PID" 2>/dev/null; wait "$HB_PID" 2>/dev/null' EXIT

# Wait for every shard. Don't care about wait's exit code.
for pid in "${SHARD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

pkill -P "$HB_PID" 2>/dev/null
kill "$HB_PID" 2>/dev/null
wait "$HB_PID" 2>/dev/null
trap - EXIT

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
  STALLED_FILE="$LOG_DIR/shard-$i.stalled"
  rc=1
  [ -f "$EXIT_FILE" ] && rc=$(cat "$EXIT_FILE" 2>/dev/null || echo 1)

  pass_count=$(bun_summary_count "pass" "$SHARD_LOG")
  fail_count=$(bun_summary_count "fail" "$SHARD_LOG")
  skip_count=$(bun_summary_count "skip" "$SHARD_LOG")
  TOTAL_PASS=$((TOTAL_PASS + pass_count))
  TOTAL_FAILURES=$((TOTAL_FAILURES + fail_count))
  TOTAL_SKIP=$((TOTAL_SKIP + skip_count))

  # Stall is checked BEFORE wedge: the watchdog's kill can also trip the
  # wallclock path, and "stopped making progress" is the more specific — and
  # more actionable — diagnosis of the two.
  if [ -f "$STALLED_FILE" ]; then
    TOTAL_RC=1
    {
      echo "--- shard $i: STALLED — no log output for ${STALL_SECONDS}s ---"
      echo "    (a shard that writes nothing for this long is stuck, not slow."
      echo "     If this box is just heavily loaded, raise or disable it:"
      echo "     GBRAIN_TEST_SHARD_STALL_SECONDS=1800  # or =0 to disable)"
      [ -f "$SHARD_LOG" ] && tail -50 "$SHARD_LOG"
      echo ""
    } >> "$FAILURES_LOG"
    echo "shard $i/$N: STALLED after ${STALL_SECONDS}s with no output (rc=$rc)" >> "$SUMMARY_FILE"
    continue
  fi

  if [ -f "$WEDGED_FILE" ]; then
    TOTAL_RC=1
    {
      echo "--- shard $i: WEDGED after ${SHARD_TIMEOUT}s (${TIMEOUT_ORIGIN}) ---"
      echo "    (the cap is derived from the file count; if this shard was"
      echo "     healthy but slow, raise the per-file budget rather than the"
      echo "     cap itself: GBRAIN_TEST_SECONDS_PER_FILE=$((SECONDS_PER_FILE * 2)))"
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
