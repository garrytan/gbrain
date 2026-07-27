#!/usr/bin/env bash
# tests/heavy/measure_rss.sh
# RSS budget gate. Builds a synthetic brain, runs a read workload, measures
# peak RSS, compares against the committed baseline.
#
# Informational-only by default. Set STRICT_RSS=1 to fail the script when
# peak RSS exceeds the baseline by more than RSS_THRESHOLD_PCT (default 25%).
#
# Baseline refresh is GATED to Linux. macOS measurement runs use a VmRSS
# fallback path that gbrain explicitly avoids in production; committing a
# macOS-derived baseline would lock in a wrong metric. See _measure_rss_workload.ts.
#
# Usage:
#   tests/heavy/measure_rss.sh                       # measure + report; never fail
#   tests/heavy/measure_rss.sh --refresh-baseline    # Linux only — overwrite baseline
#   STRICT_RSS=1 tests/heavy/measure_rss.sh          # exit 1 on regression
#
# Env vars:
#   BRAIN_PAGES         pages in the synthetic brain (default 200)
#                       Larger is more realistic but PGLite insert + autolink
#                       scales superlinearly past ~300 pages on Darwin
#                       (observed: 200=1.2s, 500+ hits the 300s timeout).
#                       The cathedral upgrade path is committing a generated
#                       fixture instead of building in-memory each run; deferred.
#   NUM_QUERIES         search queries to run (default 50)
#   RSS_THRESHOLD_PCT   regression threshold (default 25)
#   STRICT_RSS          1 to fail on regression; default 0 (informational)

set -euo pipefail

cd "$(dirname "$0")/../.."

BASELINE="tests/heavy/rss-baseline.json"
THRESHOLD_PCT="${RSS_THRESHOLD_PCT:-25}"
STRICT="${STRICT_RSS:-0}"
REFRESH=0
LOG_DIR="${GBRAIN_HOME:-$HOME/.gbrain}/audit"
TS=$(date -u +%Y%m%d-%H%M%SZ)
mkdir -p "$LOG_DIR"

for arg in "$@"; do
  case "$arg" in
    --refresh-baseline) REFRESH=1 ;;
    --help|-h)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "[measure_rss] unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

PLATFORM=$(uname -s)
echo "[measure_rss] platform=$PLATFORM pages=${BRAIN_PAGES:-200} threshold=${THRESHOLD_PCT}% strict=$STRICT"

# Refusal: macOS / non-Linux baseline refresh.
if [ "$REFRESH" = "1" ] && [ "$PLATFORM" != "Linux" ]; then
  echo "[measure_rss] REFUSAL: --refresh-baseline only safe on Linux." >&2
  echo "  macOS falls back to process.memoryUsage().rss (VmRSS) — the metric" >&2
  echo "  gbrain explicitly avoids in production. Committing a macOS-derived" >&2
  echo "  baseline would lock in the wrong metric and produce false CI delta_pct." >&2
  echo "  Run inside Linux docker:" >&2
  echo "    docker run --rm -v \"\$(pwd):/app\" -w /app oven/bun:1 tests/heavy/measure_rss.sh --refresh-baseline" >&2
  exit 2
fi

# Step 1: run the in-memory workload. Brain build + measurement happen in
# one process (the workload TS file inserts synthetic pages into a fresh
# in-memory PGLite, then runs the read loop). No cross-process state.
WORKLOAD_OUT="$LOG_DIR/heavy-measure_rss-workload-$TS.json"
echo "[measure_rss] running in-memory workload (brain insert + search loop)..."
unset DATABASE_URL || true
set +e
timeout 600s env \
  BRAIN_PAGES="${BRAIN_PAGES:-200}" \
  NUM_QUERIES="${NUM_QUERIES:-50}" \
  bun run tests/heavy/_measure_rss_workload.ts > "$WORKLOAD_OUT" 2>>"$LOG_DIR/heavy-measure_rss-$TS.log"
WORKLOAD_RC=$?
set -e
if [ "$WORKLOAD_RC" -ne 0 ]; then
  echo "[measure_rss] FAIL: workload exited $WORKLOAD_RC" >&2
  cat "$WORKLOAD_OUT" >&2 2>/dev/null || true
  echo "  See $LOG_DIR/heavy-measure_rss-$TS.log for stderr." >&2
  exit 1
fi

# Step 3: parse the workload output
PEAK_KB=$(grep -oE '"peak_rss_kb"[[:space:]]*:[[:space:]]*[0-9]+' "$WORKLOAD_OUT" | head -1 | grep -oE '[0-9]+$')
MEASUREMENT_PATH=$(grep -oE '"measurement_path"[[:space:]]*:[[:space:]]*"[^"]+"' "$WORKLOAD_OUT" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
QUERIES=$(grep -oE '"queries_run"[[:space:]]*:[[:space:]]*[0-9]+' "$WORKLOAD_OUT" | head -1 | grep -oE '[0-9]+$')
ELAPSED=$(grep -oE '"elapsed_ms"[[:space:]]*:[[:space:]]*[0-9]+' "$WORKLOAD_OUT" | head -1 | grep -oE '[0-9]+$')

echo "[measure_rss] peak_rss_kb=$PEAK_KB measurement_path=$MEASUREMENT_PATH queries=$QUERIES elapsed_ms=$ELAPSED"

# Step 4: compare against baseline (if it exists and has a number)
if [ -f "$BASELINE" ] && [ -s "$BASELINE" ]; then
  BASELINE_KB=$(grep -oE '"peak_rss_kb"[[:space:]]*:[[:space:]]*[0-9]+' "$BASELINE" | head -1 | grep -oE '[0-9]+$' || echo "")
  if [ -n "$BASELINE_KB" ] && [ "$BASELINE_KB" -gt 0 ]; then
    # Integer percentage delta: ((peak - baseline) * 100) / baseline
    DELTA_PCT=$(( (PEAK_KB - BASELINE_KB) * 100 / BASELINE_KB ))
    echo "[measure_rss] baseline=$BASELINE_KB peak=$PEAK_KB delta_pct=$DELTA_PCT% (threshold=$THRESHOLD_PCT%)"
    if [ "$DELTA_PCT" -gt "$THRESHOLD_PCT" ]; then
      echo "[measure_rss] REGRESSION: delta_pct=$DELTA_PCT% exceeds threshold $THRESHOLD_PCT%" >&2
      if [ "$STRICT" = "1" ]; then
        echo "[measure_rss] STRICT_RSS=1; failing" >&2
        exit 1
      else
        echo "[measure_rss] STRICT_RSS=0; informational-only, not failing" >&2
      fi
    fi
  else
    echo "[measure_rss] baseline exists but has no peak_rss_kb; treating as missing"
  fi
else
  echo "[measure_rss] no baseline yet at $BASELINE; measurement is informational-only"
fi

# Step 5: refresh baseline if requested (Linux-only; refusal already handled above)
if [ "$REFRESH" = "1" ]; then
  if [ "$MEASUREMENT_PATH" != "proc" ]; then
    echo "[measure_rss] REFUSAL: workload reported measurement_path=$MEASUREMENT_PATH, expected 'proc'." >&2
    echo "  This means /proc/self/status was unavailable. Refusing to commit baseline." >&2
    exit 2
  fi
  cp "$WORKLOAD_OUT" "$BASELINE"
  echo "[measure_rss] baseline refreshed at $BASELINE"
fi

echo "[measure_rss] OK"
