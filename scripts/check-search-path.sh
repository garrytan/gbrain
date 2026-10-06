#!/usr/bin/env bash
# CI guard (#1647 / #171 / #5190): every plpgsql function gbrain defines MUST
# pin `SET search_path`. Without it, an unqualified reference inside the
# function body resolves through the caller's search_path, so a same-named
# object in a user-controlled schema could shadow it. Migrations v120 and the
# #5190 search_path migration ALTER existing brains; this guard keeps every
# definition source correct so a new or re-applied function can't reintroduce
# the gap.
#
# Scope: every .ts and .sql file under src/ (schema.sql, the generated
# schemas and the TS schema modules), except src/core/schema-migrations/,
# whose historical bodies are append-only. A header is matched whatever its
# argument list and however it is spread over lines, up to its `AS $tag$`.
# LANGUAGE sql functions are exempt: they stay inlinable (an index expression
# may use them), so they schema-qualify their built-ins instead. Migration-only
# functions are covered at runtime by test/fact-fingerprint-search-path.test.ts,
# which checks pg_proc.proconfig after a fresh migrate.
#
# Usage: scripts/check-search-path.sh
# Exit:  0 when every plpgsql function pins search_path, 1 otherwise.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree.
ROOT="${GBRAIN_GUARD_ROOT:-$ROOT}"
cd "$ROOT"

if [ ! -d src ]; then
  echo "ERROR: no src/ directory under $ROOT"
  exit 1
fi

FILES="$(find src -type f \( -name '*.ts' -o -name '*.sql' \) -not -path 'src/core/schema-migrations/*' | sort)"

# perl reads each file whole, finds every CREATE [OR REPLACE] FUNCTION header up
# to its AS $tag$, skips LANGUAGE sql, and reports headers with no search_path.
BAD="$(printf '%s\n' "$FILES" | xargs perl -0777 -ne '
  while (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\((.*?)\)\s+RETURNS\s+(.*?)\bAS\s+\$(\w*)\$/gis) {
    my ($name, $rest, $start) = ($1, $3, $-[0]);
    next if $rest =~ /\bLANGUAGE\s+sql\b/i;
    next if $rest =~ /search_path/i;
    my $line = 1 + (substr($_, 0, $start) =~ tr/\n//);
    print "$ARGV:$line: $name\n";
  }
' 2>/dev/null || true)"

if [ -n "$BAD" ]; then
  echo "ERROR: plpgsql function(s) missing SET search_path:"
  echo "$BAD"
  echo
  echo "Add 'SET search_path = pg_catalog, public' to the function header, e.g.:"
  echo "  CREATE OR REPLACE FUNCTION foo() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS \$fn\$"
  echo "See #1647 / #171 / #5190."
  exit 1
fi

echo "OK: every plpgsql function definition under src/ pins search_path"
