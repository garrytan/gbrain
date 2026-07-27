#!/usr/bin/env bash
# tests/heavy/build_legacy_fixtures.sh
# Build a legacy brain fixture by:
#   1. Bringing a fresh DB to LATEST shape (via `gbrain doctor` which triggers initSchema)
#   2. Applying a down-mutation SQL file to strip forward-referenced state
#
# Deterministic alternative to committed pg_dump blobs (which rot via pg_dump
# version noise, opaque diffs, and undocumented regeneration). The down-mutate
# pattern matches what test/bootstrap.test.ts uses for PGLite.
#
# Usage:
#   DATABASE_URL=postgresql://... ./tests/heavy/build_legacy_fixtures.sh <shape>
#
# Where <shape> is one of:
#   pre-v0.13   — strip link_source/origin_page_id; version=10
#   pre-v0.18   — strip pages.source_id + sources table; version=20
#
# Honest limitation: this is a down-mutation simulation, not a real historical
# snapshot. Codex flagged this in plan review as "weak simulation" — it can't
# simulate every possible historical state. Acceptable here because the
# bootstrap's contract is narrow: "given a brain that lacks the specific
# forward-references, initSchema produces a brain at LATEST." This script
# exercises exactly that contract, across multiple historical shapes.

set -euo pipefail

cd "$(dirname "$0")/../.."

SHAPE="${1:-}"
if [ -z "$SHAPE" ]; then
  echo "[build_legacy_fixtures] usage: $0 <shape>" >&2
  echo "  shapes: pre-v0.13 | pre-v0.18" >&2
  exit 2
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[build_legacy_fixtures] DATABASE_URL not set." >&2
  echo "  Local: docker run -d --name gbrain-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gbrain_test -p 5434:5432 pgvector/pgvector:pg16" >&2
  echo "  Then: export DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test" >&2
  exit 2
fi

SQL_FILE="tests/heavy/fixtures/down-mutate-${SHAPE}.sql"
if [ ! -f "$SQL_FILE" ]; then
  echo "[build_legacy_fixtures] no fixture for shape '$SHAPE' at $SQL_FILE" >&2
  echo "  available shapes: $(ls tests/heavy/fixtures/down-mutate-*.sql 2>/dev/null | sed -e 's|.*down-mutate-||' -e 's|\.sql||' | tr '\n' ' ')" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[build_legacy_fixtures] psql is required. Install postgresql-client." >&2
  exit 2
fi

echo "[build_legacy_fixtures] shape=$SHAPE"
echo "[build_legacy_fixtures] db=$DATABASE_URL"

# Step 1: reset schema
echo "[build_legacy_fixtures] dropping public schema..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

# Step 2: bring to LATEST via gbrain. The CLI's `doctor --json` triggers
# engine.connect() which runs applyForwardReferenceBootstrap → SCHEMA_SQL →
# runMigrations. On an empty DB this is a no-op bootstrap + full schema replay
# + zero migrations (already at LATEST).
# NOTE: `--fast` short-circuits schema init checks; we deliberately omit it.
echo "[build_legacy_fixtures] initializing to LATEST via gbrain doctor..."
timeout 180s bun run src/cli.ts doctor --json > /dev/null

# Step 3: down-mutate to the target shape
echo "[build_legacy_fixtures] applying down-mutate from $SQL_FILE..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$SQL_FILE"

# Step 4: confirm the version was rolled back
VERSION=$(psql "$DATABASE_URL" -t -A -c "SELECT value FROM config WHERE key = 'version';")
echo "[build_legacy_fixtures] OK — fixture built, version=$VERSION, shape=$SHAPE"
