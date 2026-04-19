#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/tt/workspace/tools/gbrain-sandbox-home
export PATH=/home/tt/workspace/tools/gbrain-local-bun/bin:$PATH
export GBRAIN_EMBED_DIMENSIONS="768"

GBRAIN_ROOT="/home/tt/workspace/tools/gbrain"
GBRAIN_CLI="/home/tt/workspace/tools/gbrain-local-bun/bin/bun run src/cli.ts"
CURATED_STAGE="/home/tt/workspace/tools/gbrain-curated-stage"
CURATED_DB_DIR="/home/tt/workspace/tools/gbrain-curated-db-768"
CURATED_DB_PATH="$CURATED_DB_DIR/brain.pglite"
CURATED_LOG_DIR="/home/tt/workspace/tools/gbrain-curated-logs"

mkdir -p "$CURATED_LOG_DIR"

run_gbrain() {
  cd "$GBRAIN_ROOT"
  # shellcheck disable=SC2086
  $GBRAIN_CLI "$@"
}

ensure_interactive_env() {
  if [[ -z "${OPENAI_BASE_URL:-}" || -z "${GBRAIN_EMBED_MODEL:-}" ]]; then
    echo "warning: OPENAI_BASE_URL or GBRAIN_EMBED_MODEL not set in current shell" >&2
    echo "hint: run these scripts via: bash -ic '<script>' so ~/.bashrc exports load" >&2
  fi
}
