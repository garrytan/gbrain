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

prepare_brain_repo() {
  if [ -z "${BRAIN_REPO_URL:-}" ]; then
    return 0
  fi

  BRAIN_REPO_PATH="${BRAIN_REPO_PATH:-/data/brain-repo}"
  BRAIN_REPO_BRANCH="${BRAIN_REPO_BRANCH:-main}"
  BRAIN_REPO_SYNC_INTERVAL_SECONDS="${BRAIN_REPO_SYNC_INTERVAL_SECONDS:-300}"

  if ! [[ "$BRAIN_REPO_SYNC_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [ "$BRAIN_REPO_SYNC_INTERVAL_SECONDS" -lt 60 ]; then
    echo "BRAIN_REPO_SYNC_INTERVAL_SECONDS must be an integer >= 60; got: $BRAIN_REPO_SYNC_INTERVAL_SECONDS" >&2
    exit 2
  fi

  if [ -n "${BRAIN_REPO_TOKEN:-}" ]; then
    mkdir -p "$GBRAIN_HOME/git"
    cat > "$GBRAIN_HOME/git/askpass.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "x-access-token" ;;
  *Password*) printf '%s\n' "$BRAIN_REPO_TOKEN" ;;
  *) printf '%s\n' "$BRAIN_REPO_TOKEN" ;;
esac
EOF
    chmod 700 "$GBRAIN_HOME/git/askpass.sh"
    export GIT_ASKPASS="$GBRAIN_HOME/git/askpass.sh"
    export GIT_TERMINAL_PROMPT=0
  elif [ -n "${BRAIN_REPO_SSH_KEY:-}" ]; then
    mkdir -p "$GBRAIN_HOME/ssh"
    chmod 700 "$GBRAIN_HOME/ssh"
    printf '%s\n' "$BRAIN_REPO_SSH_KEY" > "$GBRAIN_HOME/ssh/id_brain_repo"
    chmod 600 "$GBRAIN_HOME/ssh/id_brain_repo"
    ssh-keyscan -T 10 github.com > "$GBRAIN_HOME/ssh/known_hosts" 2>/dev/null
    export GIT_SSH_COMMAND="ssh -i $GBRAIN_HOME/ssh/id_brain_repo -o IdentitiesOnly=yes -o ConnectTimeout=10 -o UserKnownHostsFile=$GBRAIN_HOME/ssh/known_hosts"
  fi

  mkdir -p "$(dirname "$BRAIN_REPO_PATH")"
  if [ -d "$BRAIN_REPO_PATH/.git" ]; then
    echo "[gbrain] updating brain repo at $BRAIN_REPO_PATH"
    git -C "$BRAIN_REPO_PATH" remote set-url origin "$BRAIN_REPO_URL"
    git -C "$BRAIN_REPO_PATH" fetch origin "$BRAIN_REPO_BRANCH"
    git -C "$BRAIN_REPO_PATH" checkout "$BRAIN_REPO_BRANCH"
    git -C "$BRAIN_REPO_PATH" reset --hard "origin/$BRAIN_REPO_BRANCH"
  else
    echo "[gbrain] cloning brain repo into $BRAIN_REPO_PATH"
    rm -rf "$BRAIN_REPO_PATH"
    git clone --branch "$BRAIN_REPO_BRANCH" --depth 1 "$BRAIN_REPO_URL" "$BRAIN_REPO_PATH"
  fi
}

sync_brain_repo_once() {
  if [ -z "${BRAIN_REPO_URL:-}" ]; then
    return 0
  fi

  prepare_brain_repo
  echo "[gbrain] syncing brain repo from $BRAIN_REPO_PATH"
  bun src/cli.ts sync --repo "$BRAIN_REPO_PATH" --yes || true
}

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

if [ -n "${BRAIN_REPO_URL:-}" ]; then
  timeout 120s bash -c "$(declare -f prepare_brain_repo sync_brain_repo_once); sync_brain_repo_once" \
    || echo "[gbrain] initial brain repo sync skipped or timed out"

  (
    echo "[gbrain] starting brain repo sync loop every ${BRAIN_REPO_SYNC_INTERVAL_SECONDS}s"
    while true; do
      sleep "$BRAIN_REPO_SYNC_INTERVAL_SECONDS"
      echo "[gbrain] updating and syncing brain repo"
      sync_brain_repo_once || true
    done
  ) &
fi

echo "[gbrain] serving $GBRAIN_MODE brain on 0.0.0.0:$PORT as $PUBLIC_URL"
exec bun src/cli.ts serve \
  --http \
  --bind 0.0.0.0 \
  --port "$PORT" \
  --public-url "$PUBLIC_URL"
