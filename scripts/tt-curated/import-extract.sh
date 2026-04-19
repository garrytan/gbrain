#!/usr/bin/env bash
set -euo pipefail
source /home/tt/workspace/tools/gbrain/scripts/tt-curated/common.sh

if [[ ! -d "$CURATED_STAGE" ]]; then
  echo "curated stage missing: $CURATED_STAGE" >&2
  echo "run refresh-stage.sh first" >&2
  exit 1
fi

if [[ ! -e "$CURATED_DB_PATH" ]]; then
  /home/tt/workspace/tools/gbrain/scripts/tt-curated/init-db.sh
fi

run_gbrain import "$CURATED_STAGE" --no-embed
run_gbrain extract all --dir "$CURATED_STAGE"
