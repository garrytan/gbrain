#!/usr/bin/env bash
# CI guard: fail if action-brain source contains auto-send wording.
#
# Policy intent for Action Brain 0.2: sending must always be explicit human
# approval, never automatic behavior hidden behind naming drift.
#
# Usage:
#   scripts/check-action-brain-no-autosend.sh [path]
# Default path:
#   src/action-brain
# Exit:
#   0 when no matches, 1 when matches found, 2 for invalid usage/path.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

TARGET_DIR="${1:-src/action-brain}"
PATTERN='auto.?send|autosend'

if [ ! -d "$TARGET_DIR" ]; then
  echo "ERROR: target directory does not exist: $TARGET_DIR" >&2
  exit 2
fi

if grep -REni "$PATTERN" "$TARGET_DIR" 2>/dev/null; then
  echo
  echo "ERROR: Found forbidden auto-send wording in $TARGET_DIR." >&2
  echo "       Policy: send paths must remain explicit approve-before-send." >&2
  exit 1
fi

echo "OK: no auto-send wording found in $TARGET_DIR"
