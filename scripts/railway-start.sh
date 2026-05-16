#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required}"

export GBRAIN_HOME="${GBRAIN_HOME:-/data/gbrain}"
export PORT="${PORT:-3000}"
GBRAIN_MODE="${GBRAIN_MODE:-individual}"

case "$GBRAIN_MODE" in
  individual|company) ;;
  *)
    echo "GBRAIN_MODE must be individual or company; got: $GBRAIN_MODE" >&2
    exit 2
    ;;
esac

mkdir -p "$GBRAIN_HOME"

echo "[gbrain] initializing $GBRAIN_MODE brain at $GBRAIN_HOME"
bun src/cli.ts init \
  --mode "$GBRAIN_MODE" \
  --url "$DATABASE_URL" \
  --non-interactive

if [ "$GBRAIN_MODE" = "individual" ] && [ -n "${COMPANY_SHARE_SECRET:-}" ]; then
  echo "[gbrain] configuring individual company-share manifest secret"
  bun src/cli.ts company-share secret set --secret "$COMPANY_SHARE_SECRET" --json >/dev/null
fi

echo "[gbrain] serving $GBRAIN_MODE brain on 0.0.0.0:$PORT as $PUBLIC_URL"
exec bun src/cli.ts serve \
  --http \
  --bind 0.0.0.0 \
  --port "$PORT" \
  --public-url "$PUBLIC_URL"
