#!/bin/bash
# Generate compiled schema constants from src/schema.sql.
# One source of truth: schema.sql is the canonical file.
set -euo pipefail

CHECK_MODE=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=1
  shift
fi

if [[ $# -gt 0 ]]; then
  echo "Usage: bash scripts/build-schema.sh [--check]" >&2
  exit 2
fi

SCHEMA_FILE="src/schema.sql"
EMBEDDED_OUT_FILE="src/core/schema-embedded.ts"
PGLITE_OUT_FILE="src/core/pglite-schema.ts"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

EMBEDDED_TMP="$TMP_DIR/schema-embedded.ts"
PGLITE_SQL_TMP="$TMP_DIR/pglite-schema.sql"
PGLITE_TMP="$TMP_DIR/pglite-schema.ts"

write_ts_const() {
  local const_name="$1"
  local source_note="$2"
  local sql_file="$3"
  local out_file="$4"
  shift 4

  {
    echo "// AUTO-GENERATED — do not edit. Run: bun run build:schema"
    echo "// Source: $source_note"
    for note in "$@"; do
      echo "// $note"
    done
    echo ""
    echo "export const $const_name = \`"
    # Escape backticks and dollar signs in the SQL for template literal safety.
    sed 's/`/\\`/g; s/\$/\\$/g' "$sql_file"
    echo "\`;"
  } > "$out_file"
}

append_section() {
  local start_marker="$1"
  local end_marker="$2"

  awk -v start="$start_marker" -v end="$end_marker" '
    $0 == start { found_start = 1; printing = 1 }
    printing && $0 == end { found_end = 1; exit }
    printing { print }
    END {
      if (!found_start || !found_end) {
        exit 1
      }
    }
  ' "$SCHEMA_FILE" >> "$PGLITE_SQL_TMP" || {
    echo "Failed to extract PGLite schema section: $start_marker -> $end_marker" >&2
    exit 1
  }
}

build_pglite_sql() {
  awk '
    NR == 1 {
      print "-- MBrain PGLite schema (local embedded Postgres)"
      next
    }
    $0 == "-- source registry and raw ingest provenance" { exit }
    { print }
  ' "$SCHEMA_FILE" > "$PGLITE_SQL_TMP"

  append_section "-- task-memory: operational continuity records" "-- memory_jobs: durable maintenance runtime job queue"
  append_section "-- memory_jobs: durable maintenance runtime job queue" "-- runner_jobs/tool_calls/messages/artifacts: restricted maintenance runners"
  append_section "-- memory_cycle_locks / memory_worker_heartbeats: maintenance coordination" "-- config: brain-level settings"
  append_section "-- assertion pipeline and session graph" "-- lifecycle forgetting and purge audit"
  append_section "-- config: brain-level settings" "-- access_tokens: bearer tokens for remote MCP access"
  append_section "-- Trigger-based search_vector (spans pages + timeline_entries)" "-- Row Level Security: block anon access, postgres role bypasses"

  local pglite_config_tmp="$TMP_DIR/pglite-schema-with-config.sql"
  awk '
    {
      print
      if ($0 == "  ('\''version'\'', '\''1'\''),") {
        print "  ('\''engine'\'', '\''pglite'\''),"
      }
    }
  ' "$PGLITE_SQL_TMP" > "$pglite_config_tmp"
  mv "$pglite_config_tmp" "$PGLITE_SQL_TMP"
}

write_ts_const "SCHEMA_SQL" "$SCHEMA_FILE" "$SCHEMA_FILE" "$EMBEDDED_TMP"

build_pglite_sql
write_ts_const \
  "PGLITE_SCHEMA_SQL" \
  "$SCHEMA_FILE (PGLite transform)" \
  "$PGLITE_SQL_TMP" \
  "$PGLITE_TMP" \
  "Excludes source registry, governed ledger, restricted runner, remote auth/OAuth/files, lifecycle forgetting, and RLS blocks from the Postgres schema." \
  "PGLite starts from this local baseline and then applies src/core/migrate.ts migrations."

if [[ "$CHECK_MODE" == "1" ]]; then
  failed=0
  for pair in "$EMBEDDED_TMP:$EMBEDDED_OUT_FILE" "$PGLITE_TMP:$PGLITE_OUT_FILE"; do
    generated="${pair%%:*}"
    target="${pair#*:}"
    if [[ ! -f "$target" ]] || ! cmp -s "$generated" "$target"; then
      echo "Generated schema is out of date: $target (run: bun run build:schema)" >&2
      failed=1
    fi
  done
  exit "$failed"
fi

mv "$EMBEDDED_TMP" "$EMBEDDED_OUT_FILE"
mv "$PGLITE_TMP" "$PGLITE_OUT_FILE"
echo "Generated $EMBEDDED_OUT_FILE from $SCHEMA_FILE"
echo "Generated $PGLITE_OUT_FILE from $SCHEMA_FILE"
