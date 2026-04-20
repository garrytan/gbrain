#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval "$(/usr/bin/python3 "$SCRIPT_DIR/config_loader.py" shell)"

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
