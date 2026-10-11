#!/usr/bin/env bash
# scripts/run-verify-parallel.sh — canonical verify dispatcher.
#
# Runs the complete CHECKS registry (privacy, version/generated files, JSONB,
# source-id, guard self-test, typecheck, …), waits for all, aggregates exit codes,
# surfaces failed-check name + tail of its log to stderr.
#
# Replaces the sequential `&&`-chain in package.json's `verify` script.
# Wallclock: 19 sequential checks (~15-25s on CI) → parallel (~3-5s).
#
# Usage:
#   bash scripts/run-verify-parallel.sh              # run every CHECK below
#   bash scripts/run-verify-parallel.sh --dry-list   # print check list, exit
#
# Env overrides:
#   GBRAIN_VERIFY_TIMEOUT       per-check wallclock cap, seconds (default 120)
#   GBRAIN_VERIFY_MAX_PARALLEL  bounded worker count (default: detected CPUs,
#                               capped at 8)
#   GBRAIN_VERIFY_LOG_DIR       where to write per-check logs (default tempdir)
#
# Exit codes:
#   0   all checks passed
#   1   one or more checks failed (full details in stderr)
#   2   usage error / no checks defined

set -uo pipefail

cd "$(dirname "$0")/.."

# ──────────────────────────────────────────────────────────────────────────
# Checks to run. Order is irrelevant (parallel), but keep stable for log
# determinism + grep-ability. Each entry is a bun-script name (the
# `package.json` "scripts" key), invoked as `bun run <name>`.
#
# To add a check: append to this array. To skip in CI temporarily, comment
# the line — the parallel runner doesn't care about count.
# ──────────────────────────────────────────────────────────────────────────
CHECKS=(
  # This is intentionally first and runs synchronously. It regenerates tracked
  # admin/release artifacts; every other check must see the same generated
  # state instead of racing that build.
  "check:admin-build"
  "check:repository-hygiene"
  "check:version-sync"
  "check:gbrain-subsystems"
  "check:privacy"
  "check:proposal-pii"
  "check:test-names"
  "check:jsonb"
  "check:source-id-projection"
  "check:source-config-leak"
  "check:progress"
  "check:test-isolation"
  "check:wasm"
  "check:admin-scope-drift"
  "check:cli-exec"
  "check:system-of-record"
  "check:eval-glossary"
  "check:no-pii-agent-voice"
  "check:synthetic-corpus-privacy"
  "check:skill-brain-first"
  "check:fuzz-purity"
  "check:operations-filter-bypass"
  "check:gateway-routed"
  "check:worker-pool-atomicity"
  "check:fixture-privacy"
  "check:conversation-parser"
  "check:resolver"
  "check:source-scope-onboard"
  "check:no-legacy-getconnection"
  "check:newlines"
  "check:exports-count"
  "check:pagetype-exhaustive"
  "check:pg-url-redaction"
  "check:no-double-retry"
  "check:batch-audit-site"
  "check:worker-lock-renewal-shape"
  "check:guard-self-test"
  "check:pmbrain-env"
  "check:scattered-contracts"
  "typecheck"
)

if [ "${#CHECKS[@]}" -eq 0 ]; then
  echo "ERROR: no checks defined in run-verify-parallel.sh" >&2
  exit 2
fi

# Dry-run path: list checks, exit. Used by tests + ops debugging.
if [ "${1:-}" = "--dry-list" ]; then
  printf '%s\n' "${CHECKS[@]}"
  exit 0
fi

if [ "$#" -gt 0 ] && [ "${1:-}" != "" ]; then
  echo "ERROR: unknown arg: $1" >&2
  echo "usage: bash scripts/run-verify-parallel.sh [--dry-list]" >&2
  exit 2
fi

TIMEOUT="${GBRAIN_VERIFY_TIMEOUT:-120}"
if ! printf '%s' "$TIMEOUT" | grep -qE '^[0-9]+$' || [ "$TIMEOUT" -lt 1 ]; then
  echo "ERROR: GBRAIN_VERIFY_TIMEOUT must be a positive integer" >&2
  exit 2
fi

detect_cpus() {
  if command -v nproc >/dev/null 2>&1; then nproc; return; fi
  if command -v sysctl >/dev/null 2>&1; then
    cpus=$(sysctl -n hw.ncpu 2>/dev/null || true)
    [ -n "$cpus" ] && echo "$cpus" && return
  fi
  echo 4
}

MAX_PARALLEL="${GBRAIN_VERIFY_MAX_PARALLEL:-$(detect_cpus)}"
if ! printf '%s' "$MAX_PARALLEL" | grep -qE '^[0-9]+$' || [ "$MAX_PARALLEL" -lt 1 ]; then
  echo "ERROR: GBRAIN_VERIFY_MAX_PARALLEL must be a positive integer" >&2
  exit 2
fi
if [ "$MAX_PARALLEL" -gt 8 ]; then MAX_PARALLEL=8; fi

# Per-check temp dir. Each check gets its own subdir so writes can't race
# on shared scratch state (the checks themselves are read-only — they grep
# the working tree — but defense-in-depth.)
if [ -n "${GBRAIN_VERIFY_LOG_DIR:-}" ]; then
  LOG_DIR="$GBRAIN_VERIFY_LOG_DIR"
  mkdir -p "$LOG_DIR" || { echo "ERROR: cannot create $LOG_DIR" >&2; exit 2; }
else
  LOG_DIR="$(mktemp -d /tmp/gbrain-verify-XXXXXX)"
  trap 'rm -rf "$LOG_DIR"' EXIT
fi

# Resolve `timeout` for per-check wallclock cap. macOS doesn't ship one;
# brew coreutils provides `gtimeout`. If neither is available, fall back to
# bg-pid + sleep-cap (slightly less reliable but still bounded).
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi

START_TS=$(date +%s)
echo "[verify-parallel] running ${#CHECKS[@]} checks (max-parallel=${MAX_PARALLEL}, timeout=${TIMEOUT}s, logs=$LOG_DIR)" >&2

# ──────────────────────────────────────────────────────────────────────────
# Spawn one background process per check. Each child captures its own exit
# code into a sentinel file under $LOG_DIR/<safe-name>.exit; the parent
# never trusts `wait`'s aggregate value because that maps to last-spawned.
#
# safe_name: turn `check:privacy` into `check_privacy` so it fits a filename
# without escaping.
# ──────────────────────────────────────────────────────────────────────────
PIDS=()
SAFE_NAMES=()

run_check() {
  local c="$1" log_file="$2" exit_file="$3" rc
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "${TIMEOUT}s" bun run "$c" > "$log_file" 2>&1
    rc=$?
  else
    bun run "$c" > "$log_file" 2>&1 &
    pid=$!
    ( sleep "$TIMEOUT" && kill -TERM "$pid" 2>/dev/null && \
      sleep 5 && kill -KILL "$pid" 2>/dev/null ) &
    cap_pid=$!
    wait "$pid" 2>/dev/null
    rc=$?
    # Kill the watchdog and its child sleep process. Otherwise a completed
    # check can leave a timer behind that wakes during a later verify run.
    kill "$cap_pid" 2>/dev/null || true
    pkill -P "$cap_pid" 2>/dev/null || true
    wait "$cap_pid" 2>/dev/null || true
  fi
  echo "$rc" > "$exit_file"
  return "$rc"
}

for c in "${CHECKS[@]}"; do
  safe="${c//:/_}"
  SAFE_NAMES+=("$safe")
  LOG_FILE="$LOG_DIR/$safe.log"
  EXIT_FILE="$LOG_DIR/$safe.exit"

  if [ "$c" = "check:admin-build" ]; then
    echo "[verify-parallel] running generated-artifact gate before parallel checks" >&2
    run_check "$c" "$LOG_FILE" "$EXIT_FILE" || true
    continue
  fi

  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$MAX_PARALLEL" ]; do
    sleep 0.1
  done
  (run_check "$c" "$LOG_FILE" "$EXIT_FILE" || true) &
  PIDS+=($!)
done

# Wait for every background job. Ignore wait's aggregate exit — exit codes
# live in the sentinel files.
for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

# ──────────────────────────────────────────────────────────────────────────
# Aggregate. For each check, read its exit file; on failure, append a
# labeled block (check name + tail of log) to the failure report. Surface
# one final summary line and the report to stderr if anything failed.
# ──────────────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
FAIL_NAMES=()
FAIL_REPORT=""

for i in "${!CHECKS[@]}"; do
  c="${CHECKS[$i]}"
  safe="${SAFE_NAMES[$i]}"
  EXIT_FILE="$LOG_DIR/$safe.exit"
  LOG_FILE="$LOG_DIR/$safe.log"

  rc=1
  [ -f "$EXIT_FILE" ] && rc=$(cat "$EXIT_FILE" 2>/dev/null || echo 1)

  if [ "$rc" = "0" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$c")
    if [ "$rc" = "124" ]; then
      FAIL_REPORT+=$'\n--- '"$c"' (TIMED OUT after '"${TIMEOUT}"'s) ---\n'
    else
      FAIL_REPORT+=$'\n--- '"$c"' (rc='"$rc"') ---\n'
    fi
    if [ -f "$LOG_FILE" ]; then
      FAIL_REPORT+="$(tail -30 "$LOG_FILE")"
      FAIL_REPORT+=$'\n'
    fi
  fi
done

if [ "$FAIL" -gt 0 ]; then
  {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "❌ verify failed: $FAIL/${#CHECKS[@]} checks did not pass"
    echo "Failed: ${FAIL_NAMES[*]}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%s' "$FAIL_REPORT"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[verify-parallel] elapsed=${ELAPSED}s | pass=$PASS fail=$FAIL"
  } >&2
  exit 1
fi

echo "[verify-parallel] elapsed=${ELAPSED}s | pass=$PASS fail=0 | all checks green" >&2
exit 0
