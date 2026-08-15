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

# W0 fix-wave (Tier-1 #11): self-test seam — the guard harness points this at
# a known-bad fixture tree and asserts exit 1.
SCAN_ROOT="${GBRAIN_GUARD_ROOT:-src/}"

# Match the interpolated form: ${JSON.stringify(...)}::jsonb
#
# W0 fix-wave (Tier-1 #11): the previous `\([^)]*\)` argument matcher could
# not cross a nested `)` — `${JSON.stringify(obj.get())}::jsonb` was
# invisible (the same regex-hole class that made check-no-double-retry a
# permanently-green no-op). `[^}]*` spans nested parens but CANNOT cross the
# interpolation's closing `}`, so a safe `${JSON.stringify(x)}::text::jsonb`
# followed by a separate `${expr()}::jsonb` on the same line is not spanned
# into a false positive (ship-review catch — the greedy `.*` variant was).
PATTERN='\$\{JSON\.stringify\([^}]*\)\}::jsonb'

if grep -rEn "$PATTERN" "$SCAN_ROOT" 2>/dev/null; then
  echo
  echo "ERROR: Found JSON.stringify(...)::jsonb pattern in $SCAN_ROOT."
  echo "       postgres.js v3 stringifies again, producing JSONB string literals."
  echo "       Use sql.json(x) instead. See feedback_postgres_jsonb_double_encode.md."
  exit 1
fi

echo "OK: no JSON.stringify(x)::jsonb interpolation pattern in $SCAN_ROOT"

# v0.13.1 #219: guard against max_stalled DEFAULT 1 regressing in any schema
# source file. DEFAULT 1 dead-lettered any SIGKILL'd job on first stall, making
# the "10/10 rescued" claim false for out-of-the-box users. Default is 5 now.
MAX_STALLED_PATTERN='max_stalled\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1\b'

# Schema files are fixed paths; under a fixture root (self-test) they don't
# exist — skip rather than fail on the missing-file grep.
SCHEMA_FILES=()
for f in src/schema.sql src/core/migrate.ts src/core/pglite-schema.ts src/core/schema-embedded.ts; do
  [ -f "$f" ] && SCHEMA_FILES+=("$f")
done
if [ "${#SCHEMA_FILES[@]}" -gt 0 ] && grep -rEn "$MAX_STALLED_PATTERN" "${SCHEMA_FILES[@]}" 2>/dev/null; then
  echo
  echo "ERROR: max_stalled DEFAULT 1 reintroduced in schema."
  echo "       Must be DEFAULT 5 to preserve SIGKILL-rescue guarantee. See #219."
  exit 1
fi

echo "OK: max_stalled defaults are 5 in all schema sources"

# v0.42.x (#2339 / #2324): positional `$N::jsonb` + JSON.stringify double-encode.
# The template-string grep above only catches `${JSON.stringify(x)}::jsonb`. It
# MISSES the positional-param form — executeRaw(`... $N::jsonb ...`,
# [JSON.stringify(x)]) — which is the exact shape that double-encoded the
# op_checkpoints pin and aborted every sync in #2339. The AST-lite scanner below
# catches it. `set -e` propagates its non-zero exit.
# Under a fixture root, scan that root; the AST-lite scanner takes roots as argv.
if command -v node >/dev/null 2>&1; then
  node scripts/check-jsonb-params.mjs ${GBRAIN_GUARD_ROOT:+"$GBRAIN_GUARD_ROOT"}
elif command -v bun >/dev/null 2>&1; then
  bun scripts/check-jsonb-params.mjs ${GBRAIN_GUARD_ROOT:+"$GBRAIN_GUARD_ROOT"}
else
  echo "WARN: neither node nor bun on PATH; skipping check-jsonb-params.mjs" >&2
fi
