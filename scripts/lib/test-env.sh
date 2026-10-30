# scripts/lib/test-env.sh — shared helpers for the test-runner family
# (test-shard.sh, run-serial-tests.sh, run-slow-tests.sh, run-unit-parallel.sh,
# run-verify-parallel.sh). Source AFTER cd'ing to the repo root:
#
#   . scripts/lib/test-env.sh
#
# bash 3.2 compatible (macOS system bash): no mapfile, no wait -n, no ${var^^}.
# Every helper degrades gracefully inside the script-sandbox tests
# (test/scripts/run-unit-parallel.test.ts symlinks a minimal PATH with no
# sysctl/nproc/vm_stat/timeout and no package.json).

# #7448: Bun switches `bun test` to failure-only output when it detects an AI agent
# (CLAUDECODE or REPL_ID set, or AGENT=1). A passing file then prints no header and
# the runners' file census marks it incomplete. Bun reads AGENT first, and AGENT=0
# keeps the full output whatever the caller's environment.
export AGENT=0

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
# Available-memory detection (MB). macOS: vm_stat free + inactive +
# speculative + purgeable pages (inactive/purgeable are reclaimable on
# pressure, which is exactly the scenario we size for). Linux: MemAvailable.
# Unknown platform → 0, and the caller skips adaptation entirely.
# ──────────────────────────────────────────────────────────────────────────
detect_available_mem_mb() {
  if command -v vm_stat >/dev/null 2>&1; then
    vm_stat 2>/dev/null | awk '
      /page size of/ { psize = $8 }
      /Pages free/        { free = $NF }
      /Pages inactive/    { inactive = $NF }
      /Pages speculative/ { spec = $NF }
      /Pages purgeable/   { purge = $NF }
      END {
        gsub(/\./, "", free); gsub(/\./, "", inactive)
        gsub(/\./, "", spec); gsub(/\./, "", purge)
        if (psize == 0) psize = 16384
        printf "%d\n", (free + inactive + spec + purge) * psize / 1048576
      }'
    return
  fi
  if [ -r /proc/meminfo ]; then
    awk '/MemAvailable/ { printf "%d\n", $2 / 1024; found = 1 } END { if (!found) print 0 }' /proc/meminfo
    return
  fi
  echo 0
}

# ──────────────────────────────────────────────────────────────────────────
# PGLite schema snapshot: build (idempotent, ~40ms when fresh; mkdir-lock
# concurrency-safe; hash folds handler-migration source) and export
# GBRAIN_PGLITE_SNAPSHOT for child bun processes. 500+ test files each
# cold-boot PGLite + replay every migration without it (~3.5x per booting
# file — see docs/TESTING.md).
#
# No-op when GBRAIN_NO_SNAPSHOT=1 or when a parent runner already exported
# the path (double-building is harmless but noisy). Non-fatal on build
# failure — tests fall back to cold init. The one-line "active" echo makes
# a silent fall-back-to-cold-init regression visible in CI logs.
#   $1: label for log lines (defaults to test-env).
# ──────────────────────────────────────────────────────────────────────────
ensure_pglite_snapshot() {
  local label="${1:-test-env}"
  if [ "${GBRAIN_NO_SNAPSHOT:-0}" = "1" ]; then
    unset GBRAIN_PGLITE_SNAPSHOT GBRAIN_TEST_DEFAULT_SNAPSHOT
    return 0
  fi
  if [ -n "${GBRAIN_PGLITE_SNAPSHOT:-}" ]; then
    echo "[$label] PGLite snapshot active (inherited): $GBRAIN_PGLITE_SNAPSHOT" >&2
    return 0
  fi
  if bun run build:pglite-snapshot >/dev/null 2>&1; then
    export GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar
    echo "[$label] PGLite snapshot active: $GBRAIN_PGLITE_SNAPSHOT" >&2
  else
    echo "[$label] snapshot build failed (non-fatal) — tests run with cold init" >&2
  fi
}

# Bare BrainBench CLI children use the shipped embedding shape. Keep this
# auxiliary path separate from their parent bun test process's legacy shape.
ensure_default_pglite_snapshot() {
  local label="${1:-test-env}"
  if [ "${GBRAIN_NO_SNAPSHOT:-0}" = "1" ]; then
    unset GBRAIN_PGLITE_SNAPSHOT GBRAIN_TEST_DEFAULT_SNAPSHOT
    return 0
  fi
  if [ -z "${GBRAIN_TEST_DEFAULT_SNAPSHOT:-}" ]; then
    if bun run build:pglite-snapshot --profile default >/dev/null 2>&1; then
      export GBRAIN_TEST_DEFAULT_SNAPSHOT="$PWD/test/fixtures/pglite-snapshot-default.tar"
    else
      unset GBRAIN_TEST_DEFAULT_SNAPSHOT
      echo "[$label] default snapshot build failed (non-fatal) — CLI children run with cold init" >&2
      return 0
    fi
  fi
  case "$GBRAIN_TEST_DEFAULT_SNAPSHOT" in
    /*) ;;
    *) export GBRAIN_TEST_DEFAULT_SNAPSHOT="$PWD/$GBRAIN_TEST_DEFAULT_SNAPSHOT" ;;
  esac
  echo "[$label] default PGLite snapshot active: $GBRAIN_TEST_DEFAULT_SNAPSHOT" >&2
}

# ──────────────────────────────────────────────────────────────────────────
# Coverage wait multiplier: bun's lcov instrumentation slows the code under
# test while test deadlines stay wall-clock, so a coverage lane (COVERAGE_DIR
# set) exports GBRAIN_TEST_WAIT_MULTIPLIER=2 unless the caller chose a value.
# test/helpers/wait-for.ts scales every waitFor deadline by it and keeps the
# result below bun's 60s per-test timeout. The bun preload keeps GBRAIN_TEST_*
# and run-e2e.sh's env scrub keep-lists the name. Runs when this file is
# sourced, so every runner that sources it gets the same default.
# ──────────────────────────────────────────────────────────────────────────
if [ -n "${COVERAGE_DIR:-}" ] && [ -z "${GBRAIN_TEST_WAIT_MULTIPLIER:-}" ]; then
  export GBRAIN_TEST_WAIT_MULTIPLIER=2
fi

# ──────────────────────────────────────────────────────────────────────────
# Executed-test receipts (X2). With GBRAIN_TEST_RECEIPT_DIR set, every bun
# invocation a runner makes records one receipt in that directory:
#   <id>.receipt     key=value lines: lane, kind (primary|rerun|rescue),
#                    shard/of, arm, sha, run_id, run_attempt, started, and
#                    exit= once the invocation returns
#   <id>.files       the test files assigned to the invocation
#   <id>.junit.xml   Bun's native JUnit report (--reporter=junit)
# scripts/ci-executed-counts.ts reads them: an assigned file with no valid
# JUnit from any attempt is `incomplete`, and a later attempt (rerun/rescue)
# supersedes an earlier one for the files it re-ran.
#
# receipts_init captures the directory and lane, then UNSETS both variables so
# test processes (and the nested runners some tests start) never inherit
# them; a runner that starts another runner passes
# GBRAIN_TEST_RECEIPT_DIR="$TEST_RECEIPT_DIR" explicitly.
#   GBRAIN_TEST_RECEIPT_DIR   receipt directory (unset = receipts off)
#   GBRAIN_TEST_RECEIPT_LANE  overrides the runner's default lane name
# ──────────────────────────────────────────────────────────────────────────
receipts_init() {
  TEST_RECEIPT_LANE="${GBRAIN_TEST_RECEIPT_LANE:-$1}"
  TEST_RECEIPT_DIR="${GBRAIN_TEST_RECEIPT_DIR:-}"
  unset GBRAIN_TEST_RECEIPT_DIR GBRAIN_TEST_RECEIPT_LANE
  RECEIPT_ID=""
  RECEIPT_ARGS=()
  [ -n "$TEST_RECEIPT_DIR" ] || return 0
  case "$TEST_RECEIPT_DIR" in /*) ;; *) TEST_RECEIPT_DIR="$PWD/$TEST_RECEIPT_DIR" ;; esac
  mkdir -p "$TEST_RECEIPT_DIR" || {
    echo "[receipts] cannot create $TEST_RECEIPT_DIR; receipts are required when GBRAIN_TEST_RECEIPT_DIR is set" >&2
    return 1
  }
  TEST_RECEIPT_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
}

# receipt_begin <kind> <tag> <shard> <of> <arm> [file...]
# Sets RECEIPT_ID and RECEIPT_ARGS (the bun reporter flags; empty when
# receipts are off). <tag> must be unique per invocation within the lane.
receipt_begin() {
  local kind="$1" tag="$2" shard="$3" of="$4" arm="$5" id n=1
  shift 5
  RECEIPT_ID=""
  RECEIPT_ARGS=()
  [ -n "${TEST_RECEIPT_DIR:-}" ] || return 0
  id="${TEST_RECEIPT_LANE}--${tag}--${kind}"
  while [ -e "$TEST_RECEIPT_DIR/$id.receipt" ]; do
    n=$((n + 1))
    id="${TEST_RECEIPT_LANE}--${tag}--${kind}-$n"
  done
  {
    echo "version=1"
    echo "lane=$TEST_RECEIPT_LANE"
    echo "kind=$kind"
    echo "tag=$tag"
    echo "shard=$shard"
    echo "of=$of"
    echo "arm=$arm"
    echo "sha=$TEST_RECEIPT_SHA"
    echo "root=$PWD"
    echo "run_id=${GITHUB_RUN_ID:-}"
    echo "run_attempt=${GITHUB_RUN_ATTEMPT:-}"
    echo "job=${GITHUB_JOB:-}"
    echo "started=$(date +%s)"
  } > "$TEST_RECEIPT_DIR/$id.receipt"
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@" > "$TEST_RECEIPT_DIR/$id.files"; else : > "$TEST_RECEIPT_DIR/$id.files"; fi
  RECEIPT_ID="$id"
  RECEIPT_ARGS=(--reporter=junit "--reporter-outfile=$TEST_RECEIPT_DIR/$id.junit.xml")
}

# receipt_end <exit-code>: records how the invocation returned. A receipt
# without exit= was interrupted before its runner saw the result.
receipt_end() {
  [ -n "${TEST_RECEIPT_DIR:-}" ] && [ -n "${RECEIPT_ID:-}" ] || return 0
  echo "exit=$1" >> "$TEST_RECEIPT_DIR/$RECEIPT_ID.receipt"
}

# receipt_empty <tag> <shard> <of>: this invocation was assigned no files.
# Keeps an empty shard from reading as a missing one.
receipt_empty() {
  receipt_begin primary "$1" "$2" "$3" ""
  [ -n "${RECEIPT_ID:-}" ] || return 0
  echo "empty=1" >> "$TEST_RECEIPT_DIR/$RECEIPT_ID.receipt"
  receipt_end 0
  RECEIPT_ARGS=()
}
