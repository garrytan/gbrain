#!/bin/sh
# Auto-initializes the brain on first container start (gbrain requires a
# `gbrain init` before `serve` will connect to anything — see
# src/core/pg-access-classify.ts's "No database configured" error), then
# execs the real command. Safe to re-run: skipped once config.json exists.
set -eu

GBRAIN_DIR="${GBRAIN_HOME:-/data}/.gbrain"

if [ ! -f "$GBRAIN_DIR/config.json" ]; then
  echo "[entrypoint] no existing brain at $GBRAIN_DIR — running first-time init" >&2
  if [ -n "${GBRAIN_DATABASE_URL:-}" ]; then
    # Postgres + pgvector (self-hosted or Supabase): GBRAIN_DATABASE_URL set
    # by the environment / docker-compose.
    gbrain init --non-interactive --url "$GBRAIN_DATABASE_URL" ${GBRAIN_INIT_ARGS:-}
  else
    # Zero-config default: embedded PGLite, data lives under $GBRAIN_HOME.
    # Override GBRAIN_INIT_ARGS (e.g. "--embedding-model text-embedding-3-small")
    # to enable embeddings with a provider API key; defaults keyless.
    gbrain init --non-interactive --pglite ${GBRAIN_INIT_ARGS:---no-embedding}
  fi
fi

exec gbrain "$@"
