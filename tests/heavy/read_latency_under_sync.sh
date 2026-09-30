#!/usr/bin/env bash
# Three independent in-memory PGLite idle/load comparisons. Public writes,
# zero ignored errors and >=90% actual in-flight overlap are always mandatory.
# STRICT_LATENCY=1 also enforces the median-of-three p99 regression budget.
# The original 500-page, 200-query, four-writer fixture and 50% limit remain.
set -euo pipefail
cd "$(dirname "$0")/../.."

LOG_DIR="${GBRAIN_HOME:-$HOME/.gbrain}/audit"
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%d-%H%M%SZ)
WORKLOAD_OUT="$LOG_DIR/heavy-read_latency-$TS.json"
WORKLOAD_ERR="$LOG_DIR/heavy-read_latency-stderr-$TS.log"
ARGS=()
if [ "${STRICT_LATENCY:-0}" != "1" ]; then ARGS+=(--informational); fi

unset DATABASE_URL GBRAIN_DATABASE_URL
echo "[read_latency] three runs: pages=${BRAIN_PAGES:-500} queries=${NUM_QUERIES:-200} writers=${NUM_WRITERS:-4} strict=${STRICT_LATENCY:-0}"
set +e
bun --no-env-file scripts/persistence/performance.ts --engine=pglite \
  --pages="${BRAIN_PAGES:-500}" --queries="${NUM_QUERIES:-200}" \
  --writers="${NUM_WRITERS:-4}" --writes-per-writer="${WRITES_PER_WRITER:-25}" \
  --threshold="${THRESHOLD_PCT:-50}" --manifest="$WORKLOAD_OUT" \
  "${ARGS[@]}" > /dev/null 2> "$WORKLOAD_ERR"
WORKLOAD_RC=$?
set -e

if [ -f "$WORKLOAD_OUT" ]; then
  bun --no-env-file -e 'const m = await Bun.file(process.argv[1]).json();
    console.log(`[read_latency] idle p99=${m.phase_a?.p99_ms}ms loaded p99=${m.phase_b?.p99_ms}ms delta=${m.delta_p99_pct}%`);
    console.log(`[read_latency] overlap=${m.overlap_pct}% completed=${m.phase_b?.writes_completed} verdict=${m.verdict}`);' "$WORKLOAD_OUT"
fi
echo "[read_latency] manifest: $WORKLOAD_OUT"
if [ "$WORKLOAD_RC" -ne 0 ]; then
  echo "[read_latency] FAIL: workload exited $WORKLOAD_RC; stderr: $WORKLOAD_ERR" >&2
  exit 1
fi
echo "[read_latency] measurement complete (strict=${STRICT_LATENCY:-0})"
