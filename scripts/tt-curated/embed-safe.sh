#!/usr/bin/env bash
set -euo pipefail
source /home/tt/workspace/tools/gbrain/scripts/tt-curated/common.sh
ensure_interactive_env

if [[ ! -e "$CURATED_DB_PATH" ]]; then
  echo "curated DB missing: $CURATED_DB_PATH" >&2
  echo "run init-db.sh and import-extract.sh first" >&2
  exit 1
fi

ATTEMPTS="${ATTEMPTS:-3}"
SLEEP_SECONDS="${SLEEP_SECONDS:-90}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  log_file="$CURATED_LOG_DIR/embed-safe-$(date '+%Y%m%d-%H%M%S')-attempt${attempt}.log"
  echo "[$ts] embed attempt $attempt/$ATTEMPTS" | tee "$log_file"

  if run_gbrain embed --stale 2>&1 | tee -a "$log_file"; then
    echo "embed command completed on attempt $attempt" | tee -a "$log_file"
  else
    echo "embed command exited non-zero on attempt $attempt" | tee -a "$log_file"
  fi

  stats_json=$(run_gbrain stats 2>/dev/null || true)
  echo "$stats_json" >> "$log_file"

  features_json=$(run_gbrain features --json 2>/dev/null || true)
  echo "$features_json" >> "$log_file"

  if ! grep -q 'missing-embeddings' <<<"$features_json"; then
    echo "no missing-embeddings recommendation remains; stopping" | tee -a "$log_file"
    exit 0
  fi

  if [[ "$attempt" -lt "$ATTEMPTS" ]]; then
    echo "missing embeddings remain; sleeping ${SLEEP_SECONDS}s before retry" | tee -a "$log_file"
    sleep "$SLEEP_SECONDS"
  fi
done

echo "embed-safe finished with remaining missing embeddings" >&2
exit 0
