#!/usr/bin/env bash
# CI guard for src/core/schema-embedded.ts freshness.
#
# Mirrors scripts/check-eval-glossary-fresh.sh: regenerate the auto-generated
# blob into a tmp file via THE REAL generator (scripts/build-schema.sh with an
# OUT_FILE override — no logic duplication), diff against the committed file,
# fail the build if they drift.
#
# The compiled binary embeds this blob, so a stale copy ships an old schema to
# every PGLite install. The unit-suite guard is test/build-schema-fresh.test.ts;
# this shell guard runs on the fast `bun run verify` pre-push path too.
#
# Run: bash scripts/check-schema-embedded-fresh.sh
# Exit: 0 when fresh, 1 when stale (or generation fails).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMITTED="$REPO_ROOT/src/core/schema-embedded.ts"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$COMMITTED" ]; then
  echo "ERROR: $COMMITTED not found." >&2
  echo "Run: bun run build:schema" >&2
  exit 1
fi

# Regenerate into TMP without touching the committed file. Pin SCHEMA_FILE to
# the canonical source: build-schema.sh honors a SCHEMA_FILE override, so an
# inherited env var must not be able to redirect THIS canonical comparison to a
# non-canonical schema (which would silently false-pass). Use the RELATIVE path
# (build-schema.sh cd's to the repo root) so the embedded `// Source:` line
# matches the committed blob byte-for-byte; an absolute path would not.
if ! SCHEMA_FILE="src/schema.sql" OUT_FILE="$TMP" \
     bash "$REPO_ROOT/scripts/build-schema.sh" >/dev/null; then
  echo "ERROR: schema generation failed (scripts/build-schema.sh) — cannot verify freshness." >&2
  exit 1
fi

if ! diff -q "$COMMITTED" "$TMP" >/dev/null 2>&1; then
  echo "ERROR: src/core/schema-embedded.ts is stale vs src/schema.sql." >&2
  echo "" >&2
  echo "Diff between committed and freshly-generated:" >&2
  echo "" >&2
  diff -u "$COMMITTED" "$TMP" >&2 || true
  echo "" >&2
  echo "To regenerate: bun run build:schema" >&2
  exit 1
fi

echo "✓ src/core/schema-embedded.ts is fresh"
