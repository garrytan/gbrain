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
  # Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree.
  ROOT="${GBRAIN_GUARD_ROOT:-}"
  [ -n "$ROOT" ] || ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$ROOT" ] || ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$ROOT" || exit 1
  FILES=()
  for f in src/core/pglite-engine.ts src/core/postgres-engine.ts src/core/migrate.ts; do
    [ -f "$f" ] && FILES+=("$f")
  done
  # Engine method modules peeled out of the façade classes are engine-live
  # paths too — extraction must not shrink this guard's coverage. Refactor
  # wave 1 adds the shared engine SQL (src/core/engine-sql/) and the split
  # migrations (src/core/schema-migrations/), both loaded on engine connect.
  for d in src/core/pglite-engine src/core/postgres-engine src/core/engine-sql src/core/schema-migrations; do
    if [ -d "$d" ]; then
      while IFS= read -r f; do FILES+=("$f"); done < <(find "$d" -name '*.ts' | sort)
    fi
  done
  if [ "${#FILES[@]}" -eq 0 ]; then
    echo "ERROR: no engine-live files found under $ROOT" >&2
    exit 1
  fi
fi

exec bun "$SCRIPT_DIR/check-engine-dynamic-import.ts" "${FILES[@]}"
