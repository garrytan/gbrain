#!/bin/sh
# gbrain Docker entrypoint
# Configures gbrain from environment variables, then execs the CMD.
# Supports both Postgres (DATABASE_URL set) and PGLite (no DATABASE_URL).

set -e

# ---------------------------------------------------------------------------
# Required env vars
# ---------------------------------------------------------------------------
: "${OLLAMA_BASE_URL:?OLLAMA_BASE_URL is required — http://ollama:11434/v1}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required — for chat model}"

# ---------------------------------------------------------------------------
# Optional env vars with defaults
# ---------------------------------------------------------------------------
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://opencode.ai/zen/go/v1}"
SEARCH_MODE="${SEARCH_MODE:-balanced}"
GBRAIN_PORT="${GBRAIN_PORT:-3001}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-ollama:nomic-embed-text}"
EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-768}"

# ---------------------------------------------------------------------------
# Step 1: Init gbrain
#   DATABASE_URL set    → Postgres engine (--url)
#   DATABASE_URL unset  → PGLite engine (--pglite, uses PVC data)
#   --force makes this idempotent on pod restarts
# ---------------------------------------------------------------------------
echo "=== gbrain init ==="
if [ -n "${DATABASE_URL}" ]; then
  echo "Engine: postgres (DATABASE_URL set)"
  gbrain init \
    --url "${DATABASE_URL}" \
    --embedding-model "${EMBEDDING_MODEL}" \
    --embedding-dimensions "${EMBEDDING_DIMENSIONS}" \
    --force \
    2>&1
else
  echo "Engine: PGLite (no DATABASE_URL)"
  gbrain init \
    --pglite \
    --embedding-model "${EMBEDDING_MODEL}" \
    --embedding-dimensions "${EMBEDDING_DIMENSIONS}" \
    --force \
    2>&1
fi

# ---------------------------------------------------------------------------
# Step 2: Set search mode
# ---------------------------------------------------------------------------
echo "=== Setting search mode: ${SEARCH_MODE} ==="
gbrain config set search.mode "${SEARCH_MODE}" 2>&1 || true

# ---------------------------------------------------------------------------
# Step 3: Verify health
# ---------------------------------------------------------------------------
echo "=== gbrain doctor ==="
gbrain doctor --json 2>&1 | head -5 || echo "doctor check completed"

# ---------------------------------------------------------------------------
# Step 4: Exec the CMD (gbrain serve --http)
# ---------------------------------------------------------------------------
echo "=== Starting gbrain serve on port ${GBRAIN_PORT} ==="
exec "$@"
