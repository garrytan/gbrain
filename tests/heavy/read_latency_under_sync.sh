#!/usr/bin/env bash
# tests/heavy/read_latency_under_sync.sh
# Measure search latency under concurrent writer load.
#
# Runs an in-memory PGLite brain through two phases: baseline (no writes) +
# under-load (parallel writers inserting pages). Records p50/p95/p99 latency
# in each phase, reports delta_pct. The contract that matters: search p99
# shouldn't blow up while sync is running.
#
# Informational-only by default (delta_pct gets reported but exit stays 0).
# Set STRICT_LATENCY=1 to fail when p99 delta exceeds threshold.
#
# Usage:
#   tests/heavy/read_latency_under_sync.sh
#   STRICT_LATENCY=1 THRESHOLD_PCT=50 tests/heavy/read_latency_under_sync.sh
#
# Env vars:
#   BRAIN_PAGES        initial fixture (default 500)
#   NUM_QUERIES        queries per phase (default 200)
#   NUM_WRITERS        parallel writers in phase B (default 4)
#   WRITES_PER_WRITER  pages each writer inserts (default 25)
#   STRICT_LATENCY     1 = fail on p99 delta > threshold (default 0)
#   THRESHOLD_PCT      p99 regression threshold percent (default 50)

set -euo pipefail

cd "$(dirname "$0")/../.."

LOG_DIR="${GBRAIN_HOME:-$HOME/.gbrain}/audit"
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%d-%H%M%SZ)
WORKLOAD_OUT="$LOG_DIR/heavy-read_latency-$TS.json"

echo "[read_latency] pages=${BRAIN_PAGES:-500} queries=${NUM_QUERIES:-200} writers=${NUM_WRITERS:-4} strict=${STRICT_LATENCY:-0}"
echo "[read_latency] running baseline + under-load workload..."

unset DATABASE_URL || true
set +e
timeout 600s env \
  BRAIN_PAGES="${BRAIN_PAGES:-500}" \
  NUM_QUERIES="${NUM_QUERIES:-200}" \
  NUM_WRITERS="${NUM_WRITERS:-4}" \
  WRITES_PER_WRITER="${WRITES_PER_WRITER:-25}" \
  STRICT="${STRICT_LATENCY:-0}" \
  THRESHOLD_PCT="${THRESHOLD_PCT:-50}" \
  bun run tests/heavy/_read_latency_workload.ts > "$WORKLOAD_OUT" 2>>"$LOG_DIR/heavy-read_latency-stderr-$TS.log"
WORKLOAD_RC=$?
set -e

if [ "$WORKLOAD_RC" -ne 0 ]; then
  echo "[read_latency] FAIL: workload exited $WORKLOAD_RC" >&2
  cat "$WORKLOAD_OUT" >&2 2>/dev/null || true
  echo "  See $LOG_DIR/heavy-read_latency-stderr-$TS.log for stderr." >&2
  exit 1
fi

# Surface key numbers from the JSON. Awk wins here vs jq since jq isn't
# guaranteed on every CI runner; the JSON shape is stable per the workload.
A_P50=$(grep -oE '"phase_a"[[:space:]]*:[[:space:]]*\{[^}]+\}' "$WORKLOAD_OUT" | grep -oE '"p50_ms"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$')
A_P99=$(grep -oE '"phase_a"[[:space:]]*:[[:space:]]*\{[^}]+\}' "$WORKLOAD_OUT" | grep -oE '"p99_ms"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$')
B_P50=$(grep -oE '"phase_b"[[:space:]]*:[[:space:]]*\{[^}]+\}' "$WORKLOAD_OUT" | grep -oE '"p50_ms"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$')
B_P99=$(grep -oE '"phase_b"[[:space:]]*:[[:space:]]*\{[^}]+\}' "$WORKLOAD_OUT" | grep -oE '"p99_ms"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$')
DELTA_P99=$(grep -oE '"delta_p99_pct"[[:space:]]*:[[:space:]]*-?[0-9]+' "$WORKLOAD_OUT" | grep -oE '\-?[0-9]+$')
VERDICT=$(grep -oE '"verdict"[[:space:]]*:[[:space:]]*"[^"]+"' "$WORKLOAD_OUT" | sed -E 's/.*"([^"]+)"$/\1/')
WRITES_DONE=$(grep -oE '"writes_completed"[[:space:]]*:[[:space:]]*[0-9]+' "$WORKLOAD_OUT" | grep -oE '[0-9]+$')

echo "[read_latency] phase_a: p50=${A_P50}ms p99=${A_P99}ms"
echo "[read_latency] phase_b: p50=${B_P50}ms p99=${B_P99}ms (writes_completed=${WRITES_DONE})"
echo "[read_latency] delta_p99=${DELTA_P99}% verdict=${VERDICT}"
echo "[read_latency] full JSON: $WORKLOAD_OUT"

if [ "${STRICT_LATENCY:-0}" = "1" ] && [ "$VERDICT" = "fail" ]; then
  echo "[read_latency] FAIL: p99 regression exceeds threshold (STRICT_LATENCY=1)" >&2
  exit 1
fi

echo "[read_latency] OK"
