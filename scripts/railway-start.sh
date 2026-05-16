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

if [ "$GBRAIN_MODE" = "company" ] && [ -n "${COMPANY_SHARE_MEMBER_ID:-}" ]; then
  : "${COMPANY_SHARE_MEMBER_ISSUER_URL:?COMPANY_SHARE_MEMBER_ISSUER_URL is required when COMPANY_SHARE_MEMBER_ID is set}"
  : "${COMPANY_SHARE_MEMBER_MCP_URL:?COMPANY_SHARE_MEMBER_MCP_URL is required when COMPANY_SHARE_MEMBER_ID is set}"
  : "${COMPANY_SHARE_MEMBER_OAUTH_CLIENT_ID:?COMPANY_SHARE_MEMBER_OAUTH_CLIENT_ID is required when COMPANY_SHARE_MEMBER_ID is set}"
  : "${COMPANY_SHARE_MEMBER_OAUTH_CLIENT_SECRET:?COMPANY_SHARE_MEMBER_OAUTH_CLIENT_SECRET is required when COMPANY_SHARE_MEMBER_ID is set}"
  : "${COMPANY_SHARE_MEMBER_MANIFEST_SECRET:?COMPANY_SHARE_MEMBER_MANIFEST_SECRET is required when COMPANY_SHARE_MEMBER_ID is set}"

  echo "[gbrain] registering company-share member $COMPANY_SHARE_MEMBER_ID"
  bun src/cli.ts company-share members add "$COMPANY_SHARE_MEMBER_ID" \
    --issuer-url "$COMPANY_SHARE_MEMBER_ISSUER_URL" \
    --mcp-url "$COMPANY_SHARE_MEMBER_MCP_URL" \
    --oauth-client-id "$COMPANY_SHARE_MEMBER_OAUTH_CLIENT_ID" \
    --oauth-client-secret "$COMPANY_SHARE_MEMBER_OAUTH_CLIENT_SECRET" \
    --manifest-secret "$COMPANY_SHARE_MEMBER_MANIFEST_SECRET" \
    --json >/dev/null
fi

if [ "$GBRAIN_MODE" = "company" ] && [ -n "${COMPANY_SHARE_PULL_INTERVAL_SECONDS:-}" ]; then
  if ! [[ "$COMPANY_SHARE_PULL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [ "$COMPANY_SHARE_PULL_INTERVAL_SECONDS" -lt 60 ]; then
    echo "COMPANY_SHARE_PULL_INTERVAL_SECONDS must be an integer >= 60; got: $COMPANY_SHARE_PULL_INTERVAL_SECONDS" >&2
    exit 2
  fi

  echo "[gbrain] starting company-share pull loop every ${COMPANY_SHARE_PULL_INTERVAL_SECONDS}s"
  (
    while true; do
      sleep "$COMPANY_SHARE_PULL_INTERVAL_SECONDS"
      echo "[gbrain] running company-share pull"
      if [ -n "${COMPANY_SHARE_MEMBER_ID:-}" ]; then
        bun src/cli.ts company-share pull --member "$COMPANY_SHARE_MEMBER_ID" --json || true
      else
        bun src/cli.ts company-share pull --json || true
      fi
    done
  ) &
fi

echo "[gbrain] serving $GBRAIN_MODE brain on 0.0.0.0:$PORT as $PUBLIC_URL"
exec bun src/cli.ts serve \
  --http \
  --bind 0.0.0.0 \
  --port "$PORT" \
  --public-url "$PUBLIC_URL"
