#!/usr/bin/env bash
# W3 — CI guard for src/core/schema-migrations/registry.generated.ts (and
# latest.generated.ts) freshness.
#
# Mirrors scripts/check-tool-catalog-fresh.sh: regenerate the registry into a
# tmp file, diff against the committed one, fail on drift. The generator also
# enforces the filename/version/name cross-check and the duplicate-version
# rule (each printed as FAIL/Why/Fix/See), so this one guard covers all three.
#
# Run: bash scripts/check-schema-migrations-fresh.sh
# Wired into `bun run verify` via package.json `check:schema-migrations`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="src/core/schema-migrations"
TMP="$(mktemp)"
TMP_LATEST="$(mktemp)"
trap 'rm -f "$TMP" "$TMP_LATEST"' EXIT

cd "$REPO_ROOT"
bun scripts/build-schema-migrations.ts --out "$TMP" --out-latest "$TMP_LATEST" >/dev/null

for pair in "registry.generated.ts:$TMP" "latest.generated.ts:$TMP_LATEST"; do
  name="${pair%%:*}"
  fresh="${pair#*:}"
  if ! diff -q "$DIR/$name" "$fresh" >/dev/null 2>&1; then
    echo "FAIL: $DIR/$name is stale (does not match the migration files)." >&2
    echo "Why:  the registry is generated from src/core/schema-migrations/v<NNN>-*.ts; an added, renamed or" >&2
    echo "      removed migration file, or a hand edit/merge of the registry, makes it drift." >&2
    echo "Fix:  bun run build:schema-migrations   (commit the result; never hand-merge the registry)" >&2
    echo "See:  docs/TESTING.md#schema-migration-registry" >&2
    echo "" >&2
    diff -u "$DIR/$name" "$fresh" | head -40 >&2 || true
    exit 1
  fi
done

echo "✓ src/core/schema-migrations/registry.generated.ts and latest.generated.ts are fresh"
