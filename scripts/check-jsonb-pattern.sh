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

# v0.42.52: targeted guard for op_checkpoints.completed_keys. The broken path
# bound JSON.stringify(sorted) into `$3::jsonb` through executeRawDirect, which
# postgres.js stores as a JSONB string scalar. Keep this narrow so this
# regression check does not turn into a repo-wide JSONB migration.
POSITIONAL_HITS="$(
  perl -0777 -ne '
      while (/executeRaw(?:Direct)?\s*(?:<[^()]*>\s*)?\((.*?)\)\s*;/sg) {
        my $call = $1;
        next unless $call =~ /op_checkpoints/;
        next unless $call =~ /completed_keys/;
        next unless $call =~ /::jsonb/ && $call =~ /JSON\.stringify\s*\(/;
        my $line = (substr($_, 0, pos()) =~ tr/\n//) + 1;
        print "$ARGV:$line: op_checkpoints.completed_keys JSON.stringify(...) bound to \$N::jsonb\n";
      }
    ' src/core/op-checkpoint.ts 2>/dev/null
)"

if [ -n "$POSITIONAL_HITS" ]; then
  echo "$POSITIONAL_HITS"
  echo
  echo "ERROR: Found op_checkpoints.completed_keys JSON.stringify(...) bound to a \$N::jsonb cast."
  echo "       postgres.js re-encodes the string, producing a JSONB STRING literal"
  echo "       (jsonb_typeof='string'); PGLite hides it. Bind raw JSON instead."
  exit 1
fi

echo "OK: op_checkpoints.completed_keys does not bind JSON.stringify(x) to \$N::jsonb"

# v0.13.1 #219: guard against max_stalled DEFAULT 1 regressing in any schema
# source file. DEFAULT 1 dead-lettered any SIGKILL'd job on first stall, making
# the "10/10 rescued" claim false for out-of-the-box users. Default is 5 now.
MAX_STALLED_PATTERN='max_stalled\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1\b'

if grep -rEn "$MAX_STALLED_PATTERN" src/schema.sql src/core/migrate.ts src/core/pglite-schema.ts src/core/schema-embedded.ts 2>/dev/null; then
  echo
  echo "ERROR: max_stalled DEFAULT 1 reintroduced in schema."
  echo "       Must be DEFAULT 5 to preserve SIGKILL-rescue guarantee. See #219."
  exit 1
fi

echo "OK: max_stalled defaults are 5 in all schema sources"
