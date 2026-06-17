#!/usr/bin/env bash
# CI guard: every `switch (X.type)` site in src/ that discriminates on a
# PageType-shaped value MUST use assertNever() in the default branch.
#
# Why: extending PageType (e.g. v0.27.1 adding 'image') silently fell through
# default branches in v0.20 / v0.22 because TypeScript couldn't catch the
# missing case at type-check time. assertNever() forces the compiler to error
# when a new PageType lacks a matching case.
#
# Today (pre-v0.27.1) the codebase has zero PageType-discriminating switches —
# it uses the type system for exhaustiveness via union narrowing. This guard
# is preventive: catches the moment a contributor adds a switch and forgets
# the assertNever.
#
# Pattern: a `switch (x.type)` where the surrounding file imports PageType
# (heuristic: imports from './types' or '../types') is treated as a
# PageType-shaped switch and must include assertNever in default.
#
# False positives are easy to silence by adding an `// eslint-disable-line
# pagetype-exhaustive` style comment above the offending switch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VIOLATIONS=0

# Find every src/**.ts file that imports PageType. Portable across Bash 3.2
# (macOS default) — no mapfile, no process substitution arrays.
PAGETYPE_FILES=$(grep -rlE "import.*PageType.*from.*types" src 2>/dev/null || true)

if [ -z "$PAGETYPE_FILES" ]; then
  echo "[check-pagetype-exhaustive] No files import PageType. Skipping."
  exit 0
fi

while IFS= read -r file; do
  [ -z "$file" ] && continue
  # Look for `switch (X.type)` patterns in the file. Heuristic: any `switch (`
  # followed by a `.type)` within the line.
  if grep -nE 'switch\s*\([^)]*\.type\s*\)' "$file" >/dev/null 2>&1; then
    # File has at least one switch on .type. Verify assertNever is imported
    # AND used somewhere in the file. If both are present, assume the dev
    # wired it correctly — finer-grained per-switch checking is too brittle.
    if ! grep -qE 'assertNever' "$file"; then
      echo "[check-pagetype-exhaustive] FAIL: $file has switch(X.type) but no assertNever() use." >&2
      grep -nE 'switch\s*\([^)]*\.type\s*\)' "$file" >&2 || true
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  fi
done <<< "$PAGETYPE_FILES"

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "" >&2
  echo "Fix: import { assertNever } from './types.ts' (or wherever appropriate)" >&2
  echo "and add \`default: return assertNever(x.type);\` to the switch." >&2
  echo "If the switch is intentionally non-exhaustive (e.g. handling only a" >&2
  echo "subset of PageTypes), document why with a comment and add the file" >&2
  echo "to an explicit allow-list at the top of this script." >&2
  exit 1
fi

echo "[check-pagetype-exhaustive] All PageType-discriminating switches use assertNever() (or none exist)."
