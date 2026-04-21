#!/usr/bin/env bash
# CI guard: fail if any source file uses the buggy `${JSON.stringify(x)}::jsonb`
# template-string pattern instead of postgres.js's `sql.json(x)`.
#
# This is best-effort static analysis. It catches the common copy-paste form
# that caused the v0.12.0 silent-data-loss bug (JSONB columns stored as
# string literals on Postgres while PGLite hid the bug). Multi-line and
# helper-wrapped variants are NOT caught here — those are covered by
# test/e2e/postgres-jsonb.test.ts which round-trips actual writes through
# real Postgres and asserts `frontmatter->>'k'` returns objects, not strings.
#
# Usage: scripts/check-jsonb-pattern.sh
# Exit:  0 when no matches, 1 when matches found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Match the interpolated form: ${JSON.stringify(...)}::jsonb
# Using grep -P for Perl-compatible regex (lookahead-free pattern is enough here).
PATTERN='\$\{JSON\.stringify\([^)]*\)\}::jsonb'

if grep -rEn "$PATTERN" src/ 2>/dev/null; then
  echo
  echo "ERROR: Found JSON.stringify(...)::jsonb pattern in src/."
  echo "       postgres.js v3 stringifies again, producing JSONB string literals."
  echo "       Use sql.json(x) instead. See feedback_postgres_jsonb_double_encode.md."
  exit 1
fi

echo "OK: no JSON.stringify(x)::jsonb interpolation pattern in src/"
