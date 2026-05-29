#!/bin/sh
set -eu

CORTEX_BIN="${CORTEX_BIN:-/app/bin/cortex}"

# Railway exposes the public domain to deployments as RAILWAY_PUBLIC_DOMAIN.
# Derive Cortex's issuer/origin from it when the operator has not set a custom
# CORTEX_PUBLIC_URL yet.
if [ -z "${CORTEX_PUBLIC_URL:-}" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  export CORTEX_PUBLIC_URL="https://${RAILWAY_PUBLIC_DOMAIN}"
fi

if [ -z "${CORTEX_HTTP_CORS_ORIGIN:-}" ] && [ -n "${CORTEX_PUBLIC_URL:-}" ]; then
  export CORTEX_HTTP_CORS_ORIGIN="$CORTEX_PUBLIC_URL"
fi

# Hosted containers should never print one-time admin bootstrap material into
# deploy logs. Operators can still use /admin/api/issue-magic-link with the
# configured bootstrap token.
export CORTEX_SUPPRESS_BOOTSTRAP_TOKEN="${CORTEX_SUPPRESS_BOOTSTRAP_TOKEN:-1}"

# External deployments should use CORTEX_* names. These assignments keep older
# internal code paths working while tenant docs and logs stay Cortex-branded.
export GBRAIN_HOME="${GBRAIN_HOME:-${CORTEX_HOME:-/data/cortex}}"
export GBRAIN_BIND="${GBRAIN_BIND:-${CORTEX_BIND:-0.0.0.0}}"
[ -n "${CORTEX_PUBLIC_URL:-}" ] && export GBRAIN_PUBLIC_URL="$CORTEX_PUBLIC_URL"
[ -n "${CORTEX_HTTP_CORS_ORIGIN:-}" ] && export GBRAIN_HTTP_CORS_ORIGIN="$CORTEX_HTTP_CORS_ORIGIN"
[ -n "${CORTEX_HTTP_TRUST_PROXY:-}" ] && export GBRAIN_HTTP_TRUST_PROXY="$CORTEX_HTTP_TRUST_PROXY"
[ -n "${CORTEX_ADMIN_BOOTSTRAP_TOKEN:-}" ] && export GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$CORTEX_ADMIN_BOOTSTRAP_TOKEN"
[ -n "${CORTEX_SUPPRESS_BOOTSTRAP_TOKEN:-}" ] && export GBRAIN_SUPPRESS_BOOTSTRAP_TOKEN="$CORTEX_SUPPRESS_BOOTSTRAP_TOKEN"
[ -n "${CORTEX_ENABLE_DCR:-}" ] && export GBRAIN_ENABLE_DCR="$CORTEX_ENABLE_DCR"
[ -n "${CORTEX_TOKEN_TTL:-}" ] && export GBRAIN_TOKEN_TTL="$CORTEX_TOKEN_TTL"
[ -n "${CORTEX_POOL_SIZE:-}" ] && export GBRAIN_POOL_SIZE="$CORTEX_POOL_SIZE"
[ -n "${CORTEX_PREPARE:-}" ] && export GBRAIN_PREPARE="$CORTEX_PREPARE"
[ -n "${CORTEX_DISABLE_DIRECT_POOL:-}" ] && export GBRAIN_DISABLE_DIRECT_POOL="$CORTEX_DISABLE_DIRECT_POOL"
[ -n "${CORTEX_LOG_FULL_PARAMS:-}" ] && export GBRAIN_LOG_FULL_PARAMS="$CORTEX_LOG_FULL_PARAMS"
[ -n "${CORTEX_RUN_FULL_MIGRATIONS_ON_START:-}" ] && export GBRAIN_RUN_FULL_MIGRATIONS_ON_START="$CORTEX_RUN_FULL_MIGRATIONS_ON_START"
[ -n "${CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS:-}" ] && export GBRAIN_WORKER_RUN_SCHEMA_MIGRATIONS="$CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS"
[ -n "${CORTEX_WORKER_CONCURRENCY:-}" ] && export GBRAIN_WORKER_CONCURRENCY="$CORTEX_WORKER_CONCURRENCY"
[ -n "${CORTEX_ALLOW_SHELL_JOBS:-}" ] && export GBRAIN_ALLOW_SHELL_JOBS="$CORTEX_ALLOW_SHELL_JOBS"

if [ "${GBRAIN_ALLOW_SHELL_JOBS:-}" = "0" ] || [ "${GBRAIN_ALLOW_SHELL_JOBS:-}" = "false" ]; then
  unset GBRAIN_ALLOW_SHELL_JOBS
fi
if [ "${CORTEX_ALLOW_SHELL_JOBS:-}" = "0" ] || [ "${CORTEX_ALLOW_SHELL_JOBS:-}" = "false" ]; then
  unset CORTEX_ALLOW_SHELL_JOBS
fi

require_strong_bootstrap_token() {
  token="${CORTEX_ADMIN_BOOTSTRAP_TOKEN:-${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:-}}"
  if [ -z "$token" ]; then
    echo "CORTEX_ADMIN_BOOTSTRAP_TOKEN is required for hosted Cortex web services." >&2
    exit 64
  fi
  if [ "${#token}" -lt 32 ]; then
    echo "CORTEX_ADMIN_BOOTSTRAP_TOKEN must be at least 32 characters." >&2
    exit 64
  fi
}

require_database_url() {
  effective_database_url="${CORTEX_DATABASE_URL:-${GBRAIN_DATABASE_URL:-${DATABASE_URL:-}}}"
  if [ -z "$effective_database_url" ]; then
    echo "DATABASE_URL or CORTEX_DATABASE_URL is required for hosted Cortex." >&2
    exit 64
  fi
  export CORTEX_DATABASE_URL="$effective_database_url"
  export GBRAIN_DATABASE_URL="$effective_database_url"
  export DATABASE_URL="$effective_database_url"
}

require_public_url() {
  public_url="${CORTEX_PUBLIC_URL:-${GBRAIN_PUBLIC_URL:-${PUBLIC_URL:-}}}"
  if [ -z "$public_url" ]; then
    echo "CORTEX_PUBLIC_URL is required for hosted Cortex web services." >&2
    echo "On Railway, enable public networking or set CORTEX_PUBLIC_URL=https://<domain>." >&2
    exit 64
  fi
  case "$public_url" in
    https://*|http://localhost*|http://127.0.0.1*)
      ;;
    *)
      echo "CORTEX_PUBLIC_URL must be HTTPS for hosted Cortex web services." >&2
      exit 64
      ;;
  esac
  export CORTEX_PUBLIC_URL="$public_url"
  export GBRAIN_PUBLIC_URL="$public_url"
}

require_shell_jobs_disabled() {
  shell_jobs="${CORTEX_ALLOW_SHELL_JOBS:-${GBRAIN_ALLOW_SHELL_JOBS:-}}"
  case "$shell_jobs" in
    ""|0|false|FALSE|False)
      ;;
    *)
      echo "CORTEX_ALLOW_SHELL_JOBS must stay disabled in the hosted SaaS entrypoint." >&2
      exit 64
      ;;
  esac
}

run_schema_migrations() {
  require_database_url
  "$CORTEX_BIN" init --migrate-only --json
}

run_all_migrations() {
  run_schema_migrations
  "$CORTEX_BIN" apply-migrations --yes --non-interactive
}

start_web() {
  require_database_url
  require_public_url
  require_strong_bootstrap_token
  require_shell_jobs_disabled

  if [ "${CORTEX_RUN_FULL_MIGRATIONS_ON_START:-${GBRAIN_RUN_FULL_MIGRATIONS_ON_START:-0}}" = "1" ]; then
    run_all_migrations
  else
    run_schema_migrations
  fi

  port="${PORT:-3131}"
  bind="${CORTEX_BIND:-${GBRAIN_BIND:-0.0.0.0}}"
  public_url="${CORTEX_PUBLIC_URL:-${GBRAIN_PUBLIC_URL:-${PUBLIC_URL:-}}}"
  token_ttl="${CORTEX_TOKEN_TTL:-${GBRAIN_TOKEN_TTL:-3600}}"

  set -- serve --http --port "$port" --bind "$bind" --token-ttl "$token_ttl"
  if [ -n "$public_url" ]; then
    set -- "$@" --public-url "$public_url"
  fi
  if [ "${CORTEX_ENABLE_DCR:-${GBRAIN_ENABLE_DCR:-0}}" = "1" ]; then
    set -- "$@" --enable-dcr
  fi
  if [ "${CORTEX_LOG_FULL_PARAMS:-${GBRAIN_LOG_FULL_PARAMS:-0}}" = "1" ]; then
    set -- "$@" --log-full-params
  fi
  if [ "${CORTEX_SUPPRESS_BOOTSTRAP_TOKEN:-${GBRAIN_SUPPRESS_BOOTSTRAP_TOKEN:-0}}" = "1" ]; then
    set -- "$@" --suppress-bootstrap-token
  fi

  exec "$CORTEX_BIN" "$@"
}

start_worker() {
  require_database_url
  if [ "${CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS:-${GBRAIN_WORKER_RUN_SCHEMA_MIGRATIONS:-0}}" = "1" ]; then
    run_schema_migrations
  fi

  concurrency="${CORTEX_WORKER_CONCURRENCY:-${GBRAIN_WORKER_CONCURRENCY:-2}}"
  pid_file="${CORTEX_SUPERVISOR_PID_FILE:-${GBRAIN_SUPERVISOR_PID_FILE:-}}"
  if [ -z "$pid_file" ] && [ -n "${CORTEX_HOME:-}" ]; then
    pid_file="${CORTEX_HOME%/}/supervisor.pid"
  fi
  set -- jobs supervisor --concurrency "$concurrency"
  if [ -n "$pid_file" ]; then
    set -- "$@" --pid-file "$pid_file"
  fi
  exec "$CORTEX_BIN" "$@"
}

process="${CORTEX_PROCESS:-${GBRAIN_PROCESS:-${1:-web}}}"

case "$process" in
  web|serve)
    start_web
    ;;
  worker)
    start_worker
    ;;
  migrate|release)
    run_all_migrations
    ;;
  doctor)
    require_database_url
    exec "$CORTEX_BIN" doctor --json
    ;;
  *)
    exec "$CORTEX_BIN" "$@"
    ;;
esac
