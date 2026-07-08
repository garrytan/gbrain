#!/bin/bash
# Generate src/core/schema-embedded.ts from src/schema.sql
# One source of truth: schema.sql is the canonical file.
# This script produces a TypeScript constant for use in compiled binaries.
#
# SCHEMA_FILE / OUT_FILE are env-overridable so the freshness guard
# (scripts/check-schema-embedded-fresh.sh + test/build-schema-fresh.test.ts)
# can run THIS exact generator into a temp file and byte-compare against the
# committed output — no logic duplication. Defaults reproduce prior behavior.
# NOTE: this script cd's to the repo root first, so a RELATIVE SCHEMA_FILE /
# OUT_FILE resolves against the repo root, not the caller's cwd. Pass an
# absolute path to read/write outside the tree (both freshness guards do).
set -e
cd "$(dirname "$0")/.."
SCHEMA_FILE="${SCHEMA_FILE:-src/schema.sql}"
OUT_FILE="${OUT_FILE:-src/core/schema-embedded.ts}"
echo "// AUTO-GENERATED — do not edit. Run: bun run build:schema" > "$OUT_FILE"
echo "// Source: $SCHEMA_FILE" >> "$OUT_FILE"
echo "" >> "$OUT_FILE"
echo "export const SCHEMA_SQL = \`" >> "$OUT_FILE"
# Escape backticks and dollar signs in the SQL for template literal safety
sed 's/`/\\`/g; s/\$/\\$/g' "$SCHEMA_FILE" >> "$OUT_FILE"
echo "\`;" >> "$OUT_FILE"
echo "Generated $OUT_FILE from $SCHEMA_FILE"
