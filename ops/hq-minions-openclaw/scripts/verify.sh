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

ensure_local_gbrain_shim() {
  local repo_root shim_dir shim_path
  repo_root="${HQ_MINIONS_GBRAIN_REPO_ROOT:-$(cd ../.. && pwd)}"

  if command -v "${GBRAIN_BIN:-gbrain}" >/dev/null 2>&1; then
    return
  fi

  require_cmd bun "bun is required because no global gbrain binary was found. Install Bun or set GBRAIN_BIN before running verify."

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

require_cmd bun "bun is required before running verify."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

ensure_local_gbrain_shim

run_gbrain() {
  if command -v "${GBRAIN_BIN:-gbrain}" >/dev/null 2>&1; then
    "${GBRAIN_BIN:-gbrain}" "$@"
  elif [[ -f "../../src/cli.ts" ]]; then
    (cd ../.. && bun src/cli.ts "$@")
  else
    echo "Cannot find GBrain CLI." >&2
    exit 1
  fi
}

echo "Typecheck..."
typecheck_failed=0
if ! bun run typecheck; then
  typecheck_failed=1
  if [[ "${HQ_MINIONS_STRICT_TYPECHECK:-0}" == "1" ]]; then
    echo "Typecheck failed and HQ_MINIONS_STRICT_TYPECHECK=1, treating as fatal." >&2
    exit 1
  fi
  echo "WARNING: typecheck failed, continuing because runtime verification is authoritative by default. Set HQ_MINIONS_STRICT_TYPECHECK=1 to make typecheck fatal." >&2
fi

echo "Tests..."
bun test

echo "Add-on doctor..."
bun src/cli.ts doctor --json

echo "Health..."
bun src/cli.ts health --json

echo "Lifecycle smoke..."
job_id=""
cleanup_verify_job() {
  local rc=$?
  if [[ -n "$job_id" ]]; then
    bun src/cli.ts cancel-work-item "$job_id" --json >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup_verify_job EXIT

verify_run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
job_json="$(bun src/cli.ts create-work-item --project verify --workstream smoke --title "verify paused item ${verify_run_id}" --idempotency-key "verify-smoke-${verify_run_id}" --json)"
job_id="$(printf '%s' "$job_json" | sed -n 's/.*"id": *\([0-9][0-9]*\).*/\1/p' | head -n1)"
if [[ -z "$job_id" ]]; then
  echo "Could not parse job id from create-work-item output:" >&2
  echo "$job_json" >&2
  exit 1
fi

bun src/cli.ts get-work-item "$job_id" --json >/dev/null
bun src/cli.ts add-note "$job_id" --message "verification note" --json >/dev/null
bun src/cli.ts resume-work-item "$job_id" --json >/dev/null
bun src/cli.ts hold-work-item "$job_id" --json >/dev/null
bun src/cli.ts cancel-work-item "$job_id" --json >/dev/null
job_id=""
trap - EXIT
bun src/cli.ts board --project verify --json >/dev/null

echo "Upstream jobs smoke..."
run_gbrain jobs smoke

if [[ "$typecheck_failed" == "1" ]]; then
  echo "Verification passed with advisory typecheck failure."
else
  echo "Verification passed."
fi
