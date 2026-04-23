#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

require_cmd() {
  local cmd="$1"
  local message="${2:-Required command not found: $cmd}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$message" >&2
    exit 1
  fi
}

ensure_docker_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    echo "docker compose is required. Install Docker Compose before running bootstrap." >&2
    exit 1
  fi
}

ensure_local_gbrain_shim() {
  local repo_root shim_dir shim_path
  repo_root="${HQ_MINIONS_GBRAIN_REPO_ROOT:-$(cd ../.. && pwd)}"

  if command -v "${GBRAIN_BIN:-gbrain}" >/dev/null 2>&1; then
    return
  fi

  require_cmd bun "bun is required because no global gbrain binary was found. Install Bun or set GBRAIN_BIN before running bootstrap."

  shim_dir="$repo_root/.hq-minions-bin"
  shim_path="$shim_dir/gbrain"
  mkdir -p "$shim_dir"
  cat > "$shim_path" <<SHIM
#!/usr/bin/env bash
set -Eeuo pipefail
cd "$repo_root"
exec bun src/cli.ts "\$@"
SHIM
  chmod +x "$shim_path"
  export PATH="$shim_dir:$PATH"
  export GBRAIN_BIN="$shim_path"
}

require_cmd docker "docker is required before running bootstrap."
ensure_docker_compose
require_cmd bun "bun is required before running bootstrap."

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

ensure_local_gbrain_shim

run_gbrain() {
  if command -v "${GBRAIN_BIN:-gbrain}" >/dev/null 2>&1; then
    "${GBRAIN_BIN:-gbrain}" "$@"
  elif [[ -f "../../src/cli.ts" ]]; then
    (cd ../.. && bun src/cli.ts "$@")
  else
    echo "Cannot find GBrain CLI. Run from gbrain/ops/hq-minions-openclaw or set GBRAIN_BIN." >&2
    exit 1
  fi
}

echo "Starting Postgres..."
docker compose up -d postgres

echo "Installing add-on dependencies..."
bun install

echo "Waiting for Postgres..."
bun scripts/wait-for-postgres.ts

echo "Installing GBrain dependencies..."
(cd ../.. && bun install)

echo "Initializing and migrating GBrain..."
run_gbrain init --url "$DATABASE_URL"
run_gbrain apply-migrations --yes --non-interactive
run_gbrain init --migrate-only

echo "Running upstream doctor/smoke..."
run_gbrain doctor --json
run_gbrain jobs smoke

echo "Running add-on doctor..."
bun src/cli.ts doctor --json

echo "Bootstrap complete."
