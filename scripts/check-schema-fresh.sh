#!/usr/bin/env bash
# W2 — CI guard: the generated schema chain is fresh.
#
# Mirrors scripts/check-tool-catalog-fresh.sh, for a whole chain: runs
# scripts/build-schema.ts into a temp dir (fragments -> src/schema.sql regions
# -> src/core/schema-embedded.generated.ts -> src/core/pglite-schema.generated.ts)
# and diffs every output against the committed file, naming the source that
# should have been edited. The generator's own FAIL/Why/Fix/See errors
# (unknown construct, stale PGLite rule, broken region) surface unchanged.
#
# Run: bash scripts/check-schema-fresh.sh
# Wired into `bun run verify` via package.json `check:schema-fresh`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$REPO_ROOT"
bun scripts/build-schema.ts --out-dir "$TMP"

fail=0
check() {
  local path="$1" edit="$2"
  if ! diff -q "$path" "$TMP/$path" >/dev/null 2>&1; then
    echo "FAIL: $path is stale (differs from what bun run build:schema generates)." >&2
    echo "Why:  $path is generated; a hand edit, or an edit to its source without regenerating, makes it drift." >&2
    echo "Fix:  edit $edit, then run: bun run build:schema   (commit every regenerated file)" >&2
    echo "See:  docs/ENGINES.md#canonical-schema-sources" >&2
    diff -u "$path" "$TMP/$path" | head -30 >&2 || true
    echo "" >&2
    fail=1
  fi
}

check src/schema.sql "the TS fragment module named in the drifted region's BEGIN GENERATED banner (never the region itself)"
check src/core/schema-embedded.generated.ts "src/schema.sql (or a TS fragment module)"
check src/core/pglite-schema.generated.ts "src/schema.sql, a TS fragment module, or the PGLite capability rules in scripts/build-schema.ts"

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "✓ generated schema chain is fresh (schema.sql regions, schema-embedded, pglite-schema template)"
