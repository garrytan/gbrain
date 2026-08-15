#!/usr/bin/env bash
# Engine-live paths use static imports by default. A line-level
# `engine-dynamic-import-ok` marker is required for a justified lazy import.
#
# Historical Windows runs associated imports on these paths with abrupt Bun
# test-process exits, but system-wide commit exhaustion remained a confound.
# This guard therefore enforces a reviewed engine-path hardening invariant; it
# does not claim every dynamic import deterministically crashes Windows.
#
# Usage:
#   bash scripts/check-engine-dynamic-import.sh
#   bash scripts/check-engine-dynamic-import.sh FILE [FILE...]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1

if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$ROOT" ] || ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$ROOT" || exit 1
  FILES=(
    src/core/pglite-engine.ts
    src/core/postgres-engine.ts
    src/core/migrate.ts
  )
fi

exec bun "$SCRIPT_DIR/check-engine-dynamic-import.ts" "${FILES[@]}"
