#!/bin/bash
# Migrate local PGLite brain → Railway Postgres
# Usage: RAILWAY_DATABASE_URL="postgresql://..." bash scripts/migrate-to-railway.sh

set -euo pipefail

if [ -z "${RAILWAY_DATABASE_URL:-}" ]; then
  echo "ERROR: Set RAILWAY_DATABASE_URL first"
  echo "  Get it from: Railway dashboard → your Postgres service → Connect → Public URL"
  echo ""
  echo "  export RAILWAY_DATABASE_URL='postgresql://postgres:xxx@monorail.proxy.rlwy.net:PORT/railway'"
  echo "  bash scripts/migrate-to-railway.sh"
  exit 1
fi

echo "→ Running schema migrations on Railway Postgres..."
DATABASE_URL="$RAILWAY_DATABASE_URL" gbrain apply-migrations --yes

echo ""
echo "→ Migrating brain data from PGLite → Railway Postgres..."
gbrain migrate --to supabase --url "$RAILWAY_DATABASE_URL" --force

echo ""
echo "→ Verifying..."
DATABASE_URL="$RAILWAY_DATABASE_URL" gbrain stats

echo ""
echo "Done! Set these env vars in Railway dashboard:"
echo "  DATABASE_URL      = (already set as Postgres service var)"
echo "  GBRAIN_HTTP_TOKEN = $(openssl rand -hex 24 2>/dev/null || echo 'generate-a-secret-token')"
echo "  OPENAI_API_KEY    = your key (needed for vector search)"
