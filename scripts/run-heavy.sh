#!/usr/bin/env bash
# scripts/run-heavy.sh
# Runs every shell script under tests/heavy/ sequentially.
# Sister to scripts/run-slow-tests.sh and scripts/run-e2e.sh, but for
# ops-shape tests that aren't bun:test targets.
#
# Usage:
#   bun run test:heavy                  # all scripts, sequential
#   bash scripts/run-heavy.sh           # same
#   bash scripts/run-heavy.sh <pattern> # only scripts whose basename matches glob
#
# Exit codes:
#   0  all scripts passed (or no scripts found — informational)
#   N  exit code of the first failing script

set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN="${1:-}"

heavy_files=()
while IFS= read -r f; do
  # Skip README.md, non-shell files, and underscore-prefixed helpers
  # (convention: `_foo.sh` is a library/helper invoked by sibling tests).
  [[ "$f" == *.sh ]] || continue
  base=$(basename "$f")
  case "$base" in
    _*) continue ;;
  esac
  if [ -n "$PATTERN" ]; then
    case "$base" in
      $PATTERN) ;;
      *) continue ;;
    esac
  fi
  heavy_files+=("$f")
done < <(find tests/heavy -maxdepth 1 -type f -name '*.sh' | sort)

if [ "${#heavy_files[@]}" -eq 0 ]; then
  if [ -n "$PATTERN" ]; then
    echo "[run-heavy] no scripts under tests/heavy/ matched '$PATTERN'" >&2
    exit 1
  fi
  echo "[run-heavy] no scripts under tests/heavy/; nothing to do."
  exit 0
fi

echo "[run-heavy] running ${#heavy_files[@]} heavy script(s):"
for f in "${heavy_files[@]}"; do echo "  - $f"; done
echo ""

failed=0
for f in "${heavy_files[@]}"; do
  echo "[run-heavy] --- $f ---"
  start=$(date +%s)
  if bash "$f"; then
    elapsed=$(( $(date +%s) - start ))
    echo "[run-heavy] OK ($f, ${elapsed}s)"
  else
    rc=$?
    elapsed=$(( $(date +%s) - start ))
    echo "[run-heavy] FAIL ($f exited $rc after ${elapsed}s)" >&2
    failed=$rc
    break
  fi
  echo ""
done

if [ "$failed" -ne 0 ]; then
  echo "[run-heavy] FAILED — first failing script aborted the run." >&2
  exit "$failed"
fi

echo "[run-heavy] all ${#heavy_files[@]} script(s) passed."
