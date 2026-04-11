#!/bin/bash
# Generate src/core/schema-embedded.ts from src/schema.sql
# One source of truth: schema.sql is the canonical file.
# This script produces a TypeScript function for use in compiled binaries and Edge Functions.
set -e
SCHEMA_FILE="src/schema.sql"
OUT_FILE="src/core/schema-embedded.ts"

cat > "$OUT_FILE" << 'HEADER'
// AUTO-GENERATED — do not edit. Run: bun run build:schema
// Source: src/schema.sql

export function getSchemaSQL(dimensions: number, model: string): string {
  const safeModel = model.replace(/'/g, "''");
  return `
HEADER

sed 's/`/\\`/g; s/\$/\\$/g' "$SCHEMA_FILE" \
  | sed "s/vector(1536)/vector(\${dimensions})/g" \
  | sed "s/DEFAULT 'text-embedding-3-large'/DEFAULT '\${safeModel}'/g" \
  | sed "s/('embedding_model', 'text-embedding-3-large')/('embedding_model', '\${safeModel}')/g" \
  | sed "s/('embedding_dimensions', '1536')/('embedding_dimensions', '\${dimensions}')/g" \
  >> "$OUT_FILE"

echo '`;
}' >> "$OUT_FILE"
echo "Generated $OUT_FILE from $SCHEMA_FILE"
