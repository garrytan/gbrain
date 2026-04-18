#!/usr/bin/env bash
set -euo pipefail
source /home/tt/workspace/tools/gbrain/scripts/tt-curated/common.sh

rm -rf "$CURATED_DB_DIR"
mkdir -p "$CURATED_DB_DIR"
run_gbrain init --pglite --path "$CURATED_DB_PATH" --json
