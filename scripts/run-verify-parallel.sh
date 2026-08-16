#!/usr/bin/env bash
# scripts/run-verify-parallel.sh — parallel verify dispatcher.
#
# Runs the 19+ verify checks (privacy, jsonb, source-id, … + typecheck +
# admin-build) as background jobs, waits for all, aggregates exit codes,
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
#   GBRAIN_VERIFY_LOG_DIR       where to write per-check logs (default tempdir)
#
# Exit codes:
#   0   all checks passed
#   1   one or more checks failed (full details in stderr)
#   2   usage error / no checks defined

set -uo pipefail

cd "$(dirname "$0")/.."

# detect_cpus + ensure_pglite_snapshot (the PGLite-booting eval checks use
# the snapshot fast-path when the shape matches).
. scripts/lib/test-env.sh

# ──────────────────────────────────────────────────────────────────────────
# Checks to run. Each entry is a bun-script name (the `package.json`
# "scripts" key), invoked as `bun run <name>`.
#
# ORDER MATTERS for wallclock: the spawn loop below is capped at
# GBRAIN_VERIFY_MAX_PARALLEL workers, so the heaviest checks go FIRST
# (LPT-style — makespan ≈ max(longest check, total/POOL)). The heavy block:
# typecheck (tsc), two `cp -R src` + `bun build --compile` binary builds,
# the admin vite+tsc build, the fuzz bundles, guard self-tests, the
# PGLite-booting eval checks, and the whole-tree greps. Everything after is
# sub-second; that tail keeps its historical order for grep-ability.
#
# To add a check: append to the right block. To skip in CI temporarily,
# comment the line — the runner doesn't care about count.
# ──────────────────────────────────────────────────────────────────────────
CHECKS=(
  # ── heavy (longest-first) ──
  "typecheck"
  "check:admin-build"
  "check:wasm"
  "check:pglite-embedded"
  "check:fuzz-purity"
  # W0 fix-wave (Tier-1 #11): guard self-tests — every scanner guard proves it
  # can fail (bad fixture → exit 1) before it counts as coverage. Registry:
  # scripts/guards-manifest.tsv (package.json's stale `check:all` copy deleted).
  "check:guard-self-test"
  # Chronicle eval: $0, deterministic, exit-0-only-on-perfect (6 gold tasks).
  # Boots its own PGLite — budget ≤60s under a saturated pool; if it breaches
  # ~100s under contention, move it into the serial-tests CI job instead.
  "check:eval-chronicle"
  # Retrieval canary: $0, hermetic, deterministic-embedder CLI run of the
  # qrels correctness gate. Boots two PGLite processes (seed + real CLI) —
  # budget ≤60s under a saturated pool; if it breaches ~100s under
  # contention, move it into the serial-tests CI job instead (same fallback
  # as eval-chronicle above).
  "check:eval-canary"
  "check:bootstrap-templates"
  "check:skill-brain-first"
  "check:conversation-parser"
  "check:resolver"
  "check:privacy"
  "check:test-names"
  "check:test-isolation"
  # ── light tail (sub-second greps; historical order) ──
  "check:proposal-pii"
  "check:jsonb"
  "check:search-path"
  "check:source-id-projection"
  "check:source-config-leak"
  "check:progress"
  "check:no-tracked-symlinks"
  "check:admin-scope-drift"
  "check:cli-exec"
  "check:system-of-record"
  "check:eval-glossary"
  "check:tool-catalog"
  "check:skills-manifest"
  "check:no-pii-agent-voice"
  "check:synthetic-corpus-privacy"
  "check:operations-filter-bypass"
  "check:gateway-routed"
  "check:worker-pool-atomicity"
  "check:doc-history"
  "check:fixture-privacy"
  "check:source-scope-onboard"
  "check:getpage-scope"
  "check:no-double-retry"
  "check:batch-audit-site"
  "check:engine-dynamic-import"
  "check:grok-pin"
  "check:opencode-pin"
  "check:pin-doc-privacy"
  "check:worker-lock-renewal-shape"
  "check:bootstrap-tag"
  "check:plugin-tree"
  "check:skill-refs"
  # Previously reachable ONLY from the deleted check:all (i.e. never run):
  "check:newlines"
  "check:exports-count"
  "check:no-legacy-getconnection"
  # Revived registered-but-never-executed guards (this pass):
  "check:pagetype-exhaustive"
  "check:pg-url-redaction"
  # Containment sprint: module-size ratchet + structural-suite freshness.
  "check:module-size"
  "check:structural-manifest"
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

# Bounded worker pool. Unbounded fan-out ran two `cp -R src` +
# `bun build --compile` builds, the admin vite build, tsc, and ~40 greps
# simultaneously on a 4-vCPU CI runner — pushing slow checks into the
# 120s per-check timeout (the documented flake class on slower hosts).
# Default = detect_cpus so a many-core dev machine keeps its wide fan-out;
# escape hatch: GBRAIN_VERIFY_MAX_PARALLEL=999.
MAX_PAR="${GBRAIN_VERIFY_MAX_PARALLEL:-$(detect_cpus)}"
if ! printf '%s' "$MAX_PAR" | grep -qE '^[0-9]+$' || [ "$MAX_PAR" -lt 1 ]; then
  echo "ERROR: invalid GBRAIN_VERIFY_MAX_PARALLEL: $MAX_PAR" >&2
  exit 2
fi

ensure_pglite_snapshot "verify-parallel"

START_TS=$(date +%s)
echo "[verify-parallel] running ${#CHECKS[@]} checks (pool=$MAX_PAR, timeout=${TIMEOUT}s, logs=$LOG_DIR)" >&2

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
for c in "${CHECKS[@]}"; do
  # Throttle to the worker pool (bash 3.2 — no wait -n; jobs -rp reaps).
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$MAX_PAR" ]; do
    sleep 0.1
  done
  safe="${c//:/_}"
  SAFE_NAMES+=("$safe")
  LOG_FILE="$LOG_DIR/$safe.log"
  EXIT_FILE="$LOG_DIR/$safe.exit"
  (
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" "${TIMEOUT}s" bun run "$c" > "$LOG_FILE" 2>&1
      rc=$?
    else
      bun run "$c" > "$LOG_FILE" 2>&1 &
      pid=$!
      ( sleep "$TIMEOUT" && kill -TERM "$pid" 2>/dev/null && \
        sleep 5 && kill -KILL "$pid" 2>/dev/null ) &
      cap_pid=$!
      wait "$pid" 2>/dev/null
      # Capture the check's exit code from ITS `wait`, before any watchdog
      # teardown runs. The teardown commands below overwrite $? — the killed
      # watchdog reports 143 — which used to get stamped into every sentinel
      # on machines with no gtimeout/timeout: verify reported pass=0
      # fail=<all> while every per-check log said OK.
      rc=$?
      # Reap the watchdog's `sleep` child too (pkill -P), then the watchdog.
      # Killing only the subshell leaves the sleep orphaned until $TIMEOUT
      # elapses — same quirk the heartbeat cleanup in run-unit-parallel.sh
      # works around; CI's orphan-process sweep flags those.
      pkill -P "$cap_pid" 2>/dev/null
      kill "$cap_pid" 2>/dev/null
      wait "$cap_pid" 2>/dev/null
    fi
    echo "$rc" > "$EXIT_FILE"
  ) &
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
