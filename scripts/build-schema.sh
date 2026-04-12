#!/bin/bash
# Generate src/core/schema-embedded.ts from src/schema.sql
# One source of truth: schema.sql is the canonical file.
# This script produces a TypeScript constant for use in compiled binaries.
set -e
SCHEMA_FILE="src/schema.sql"
OUT_FILE="src/core/schema-embedded.ts"
echo "// AUTO-GENERATED — do not edit. Run: bun run build:schema" > "$OUT_FILE"
echo "// Source: $SCHEMA_FILE" >> "$OUT_FILE"
echo "" >> "$OUT_FILE"
echo "export const SCHEMA_SQL = \`" >> "$OUT_FILE"
# Escape backticks and dollar signs in the SQL for template literal safety
sed 's/`/\\`/g; s/\$/\\$/g' "$SCHEMA_FILE" >> "$OUT_FILE"
echo "\`;" >> "$OUT_FILE"
echo "Generated $OUT_FILE from $SCHEMA_FILE"
