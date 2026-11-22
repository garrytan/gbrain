#!/usr/bin/env bash
# scripts/dev/rust-engine-bootstrap.sh — one-shot dev machine setup for Rust
# engine parity work (docs/research/rust-engine/dev-environment.md).
#
# Installs, on Ubuntu, without prompts:
#   1. the Bun version gbrain pins (package.json engines.bun),
#   2. Postgres 16 + pgvector (pg_trgm and pgcrypto ship with the server),
#      started, with a superuser role and a test database for the e2e tests,
#   3. the Rust stable toolchain (rustfmt, clippy) and the napi-rs CLI,
#   4. the repository's dependencies (bun install --frozen-lockfile).
# Then writes an env file and prints a pass/fail summary.
#
# Idempotent: a second run skips what is already in place and only starts
# Postgres if the machine restarted. Needs root or passwordless sudo.
#
# Knobs (all optional):
#   GBRAIN_DEV_BUN_VERSION   Bun version (default: read from package.json)
#   GBRAIN_DEV_PG_PORT       Postgres port when the script creates the cluster (default 5432)
#   GBRAIN_DEV_PG_USER / GBRAIN_DEV_PG_PASSWORD / GBRAIN_DEV_PG_DB
#                            role, password and database (default gbrain / gbrain / gbrain_test;
#                            letters, digits and _ only)
#   GBRAIN_DEV_ENV_FILE      env file to write (default ~/.gbrain-rust-dev.env)
#   GBRAIN_DEV_LINK_BINS=0   do not link bun, cargo, rustc and napi into /usr/local/bin
#   GBRAIN_DEV_SKIP_RUST=1   skip the Rust toolchain and napi-rs CLI
#   GBRAIN_DEV_BIN           where the napi wrapper goes (default ~/.gbrain-rust-dev/bin)
#   GBRAIN_DEV_LOG_DIR       parent of the per-run log folders (default ~/.gbrain-rust-dev/logs)
#
# Each run writes its step logs to a new private folder, run-<time>-XXXXXX,
# under GBRAIN_DEV_LOG_DIR. The script unsets PGHOST, PGHOSTADDR and PGSERVICE
# for itself, so every Postgres call reaches the local 16/main cluster. It
# creates the database role only when it is missing and never changes an
# existing role; when an existing role cannot be used, it stops and says why.
#
# The script never exports DATABASE_URL into your shell: the test preload
# (test/helpers/database-url-guard-preload.ts) refuses every plain `bun test`
# while DATABASE_URL is set. The env file exports RUST_ENGINE_DATABASE_URL
# instead; pass it as DATABASE_URL to the e2e wrapper only.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_ROOT="${GBRAIN_DEV_LOG_DIR:-$HOME/.gbrain-rust-dev/logs}"
ENV_FILE="${GBRAIN_DEV_ENV_FILE:-$HOME/.gbrain-rust-dev.env}"
PG_MAJOR=16
PG_USER="${GBRAIN_DEV_PG_USER:-gbrain}"
PG_PASSWORD="${GBRAIN_DEV_PG_PASSWORD:-gbrain}"
PG_DB="${GBRAIN_DEV_PG_DB:-gbrain_test}"
PG_PORT="${GBRAIN_DEV_PG_PORT:-5432}"
LINK_BINS="${GBRAIN_DEV_LINK_BINS:-1}"
SKIP_RUST="${GBRAIN_DEV_SKIP_RUST:-0}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
DEV_BIN="${GBRAIN_DEV_BIN:-$HOME/.gbrain-rust-dev/bin}"
export PATH="$DEV_BIN:$BUN_INSTALL/bin:$CARGO_HOME/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
# These would send psql, createdb and pg_isready to another server than the
# local cluster the script set up. Clear them for this script only.
unset PGHOST PGHOSTADDR PGSERVICE

# Each run logs to a folder that mktemp creates new, mode 700, so no file or
# link another user put in a shared parent folder can be written through.
mkdir -p -m 700 "$LOG_ROOT" || { echo "cannot create log directory $LOG_ROOT" >&2; exit 1; }
# Others could still rename the run folder inside a parent they can write to.
if [ -L "$LOG_ROOT" ] || [ ! -O "$LOG_ROOT" ] || [ $((8#$(stat -c %a "$LOG_ROOT") & 8#022)) -ne 0 ]; then
  echo "log directory $LOG_ROOT must be a real directory owned by $(id -un) that only it can write to" >&2
  exit 1
fi
LOG_DIR="$(mktemp -d "$LOG_ROOT/run-$(date +%Y%m%dT%H%M%S)-XXXXXX")" ||
  { echo "cannot create a run log folder under $LOG_ROOT" >&2; exit 1; }

# Role, password and database go into SQL, a URL and the env file, so keep
# them to characters that need no quoting anywhere.
for _v in PG_USER PG_PASSWORD PG_DB; do
  case "${!_v}" in
    ''|*[!A-Za-z0-9_]*) echo "GBRAIN_DEV_${_v}: use letters, digits and _ only" >&2; exit 1 ;;
  esac
done
case "$PG_PORT" in ''|*[!0-9]*) echo "GBRAIN_DEV_PG_PORT must be a number" >&2; exit 1 ;; esac
T0=$SECONDS
SUMMARY=()
FAILED=0
APT_UPDATED=0

say() { printf '[bootstrap] %s\n' "$*"; }

# Run one step: its output goes to $LOG_DIR/<name>.log; on failure the last
# lines are printed. Records PASS/FAIL with seconds and an optional detail
# the step writes to $STEP_DETAIL.
run_step() {
  local name="$1"; shift
  local log="$LOG_DIR/$name.log" start=$SECONDS
  STEP_DETAIL=""
  say "$name ..."
  if "$@" >"$log" 2>&1; then
    SUMMARY+=("PASS  $(printf '%-12s %4ss' "$name" $((SECONDS - start)))  ${STEP_DETAIL:-}")
  else
    FAILED=1
    SUMMARY+=("FAIL  $(printf '%-12s %4ss' "$name" $((SECONDS - start)))  see $log")
    say "$name failed; last lines of $log:"
    tail -n 15 "$log" | sed 's/^/    /'
    return 1
  fi
}

# Steps run in this shell (only their output is redirected), so a step can
# set STEP_DETAIL and DB_URL for later steps.
detail() { STEP_DETAIL="$*"; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
else
  SUDO=(sudo -n)
fi

as_root() { "${SUDO[@]}" "$@"; }
as_postgres() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u postgres -- "$@"
  else
    sudo -n -u postgres "$@"
  fi
}

apt_install() {
  if [ "$APT_UPDATED" -eq 0 ]; then
    as_root apt-get update -q || return 1
    APT_UPDATED=1
  fi
  as_root apt-get install -y -q --no-install-recommends "$@"
}

# ---------------------------------------------------------------- preflight
preflight() {
  if ! grep -qi '^ID=ubuntu' /etc/os-release 2>/dev/null; then
    echo "This script supports Ubuntu only (found: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"))."
    return 1
  fi
  if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
    echo "Needs root or passwordless sudo (sudo -n true failed)."
    return 1
  fi
  local missing=()
  for tool in curl unzip git cc pkg-config python3 pgrep; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  [ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  if [ "${#missing[@]}" -gt 0 ]; then
    local pkgs=(ca-certificates curl unzip git pkg-config python3 procps)
    case " ${missing[*]} " in *" cc "*) pkgs+=(build-essential) ;; esac
    apt_install "${pkgs[@]}" || return 1
    detail "installed ${pkgs[*]}"
  else
    detail "$(. /etc/os-release; echo "$PRETTY_NAME")"
  fi
}

# ---------------------------------------------------------------------- bun
pinned_bun_version() {
  if [ -n "${GBRAIN_DEV_BUN_VERSION:-}" ]; then
    echo "$GBRAIN_DEV_BUN_VERSION"
    return
  fi
  # package.json: "engines": { "bun": ">=1.4.4" } — the floor CI also pins.
  sed -n 's/.*"bun"[[:space:]]*:[[:space:]]*"[^0-9]*\([0-9][0-9.]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -n 1
}

install_bun() {
  local want have
  want="$(pinned_bun_version)"
  [ -n "$want" ] || { echo "could not read engines.bun from package.json"; return 1; }
  have="$("$BUN_INSTALL/bin/bun" --version 2>/dev/null || true)"
  if [ "$have" != "$want" ]; then
    curl -fsSL https://bun.com/install | bash -s "bun-v$want" || return 1
    have="$("$BUN_INSTALL/bin/bun" --version 2>/dev/null || true)"
    [ "$have" = "$want" ] || { echo "installed bun reports '$have', wanted $want"; return 1; }
  fi
  if [ "$LINK_BINS" = "1" ]; then
    as_root ln -sfn "$BUN_INSTALL/bin/bun" /usr/local/bin/bun || return 1
    as_root ln -sfn "$BUN_INSTALL/bin/bun" /usr/local/bin/bunx || return 1
  fi
  detail "bun $have ($BUN_INSTALL/bin/bun)"
}

# ----------------------------------------------------------------- postgres
pg_installed() {
  [ -x "/usr/lib/postgresql/$PG_MAJOR/bin/postgres" ] &&
    [ -f "/usr/share/postgresql/$PG_MAJOR/extension/vector.control" ] &&
    [ -f "/usr/share/postgresql/$PG_MAJOR/extension/pg_trgm.control" ]
}

install_postgres() {
  if ! pg_installed; then
    apt_install postgresql-common || return 1
    # Ubuntu's own archive carries postgresql-16 and an older pgvector; the
    # PGDG archive matches CI's pgvector/pgvector:pg16 image more closely.
    if ! grep -rqs 'apt.postgresql.org' /etc/apt/sources.list /etc/apt/sources.list.d/; then
      as_root /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y || return 1
      APT_UPDATED=0
    fi
    apt_install "postgresql-$PG_MAJOR" "postgresql-$PG_MAJOR-pgvector" || return 1
  fi
  pg_installed || { echo "postgres $PG_MAJOR or its extensions are still missing"; return 1; }
  detail "$("/usr/lib/postgresql/$PG_MAJOR/bin/postgres" --version)"
}

# Port of the existing 16/main cluster, or empty when there is none.
cluster_port() {
  pg_lsclusters --no-header 2>/dev/null | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main" { print $3 }'
}

cluster_status() {
  pg_lsclusters --no-header 2>/dev/null | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main" { print $4 }'
}

start_postgres() {
  if [ -z "$(cluster_port)" ]; then
    as_root pg_createcluster "$PG_MAJOR" main --port "$PG_PORT" || return 1
  fi
  PG_PORT="$(cluster_port)"
  if [ "$(cluster_status)" != "online" ]; then
    # Another server (for example a Postgres 17 cluster) on the same port
    # would make the start fail with a confusing message; say it plainly.
    if pg_isready -q -h 127.0.0.1 -p "$PG_PORT" 2>/dev/null; then
      echo "Port $PG_PORT already has a server that is not Postgres $PG_MAJOR/main."
      echo "Stop it (pg_lsclusters lists clusters) or move one cluster to another port."
      return 1
    fi
    as_root pg_ctlcluster "$PG_MAJOR" main start || return 1
  fi
  local i
  for i in $(seq 1 30); do
    pg_isready -q -h 127.0.0.1 -p "$PG_PORT" && break
    sleep 1
  done
  pg_isready -h 127.0.0.1 -p "$PG_PORT" || return 1
  detail "16/main online on port $PG_PORT"
}

create_database() {
  # Every admin call names the 16/main port: with a second cluster on the
  # machine, Ubuntu's psql wrapper would otherwise pick the default one.
  PG_PORT="$(cluster_port)"
  [ -n "$PG_PORT" ] || { echo "no $PG_MAJOR/main cluster"; return 1; }
  # cd / so `sudo -u postgres` does not warn about an unreadable cwd.
  # The password goes in on stdin, never in argv where `ps` shows it.
  # PG_USER and PG_PASSWORD are already limited to [A-Za-z0-9_].
  # An existing role is kept as it is: something else may use it.
  # Superuser: the tests CREATE DATABASE and CREATE EXTENSION vector. Local dev only.
  (cd / && as_postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -q -d postgres) <<SQL || return 1
SELECT format('CREATE ROLE %I WITH LOGIN SUPERUSER PASSWORD %L', '$PG_USER', '$PG_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$PG_USER') \\gexec
SQL
  local flags
  flags="$(cd / && as_postgres psql -p "$PG_PORT" -tAq -d postgres -c "SELECT rolcanlogin::text || ' ' || rolsuper::text FROM pg_roles WHERE rolname = '$PG_USER'")" || return 1
  if [ "$flags" != "true true" ]; then
    echo "Role $PG_USER already exists and is not a login superuser; the script does not change existing roles."
    echo "Set GBRAIN_DEV_PG_USER to an unused role name and run the script again."
    return 1
  fi
  if ! (cd / && as_postgres psql -p "$PG_PORT" -tAq -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'") | grep -q 1; then
    (cd / && as_postgres createdb -p "$PG_PORT" -O "$PG_USER" "$PG_DB") || return 1
  fi
  local url="postgresql://$PG_USER:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB"
  # Connect with the password in the environment, not on the command line.
  local conn="postgresql://$PG_USER@127.0.0.1:$PG_PORT/$PG_DB"
  if ! PGPASSWORD="$PG_PASSWORD" psql "$conn" -tAq -c 'SELECT 1' >/dev/null; then
    echo "Cannot log in as $PG_USER with the configured password. The role existed before and the"
    echo "script keeps its password. Set GBRAIN_DEV_PG_PASSWORD to that role's password, or set"
    echo "GBRAIN_DEV_PG_USER to an unused role name, and run the script again."
    return 1
  fi
  PGPASSWORD="$PG_PASSWORD" psql "$conn" -v ON_ERROR_STOP=1 -q \
    -c 'CREATE EXTENSION IF NOT EXISTS vector' \
    -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' \
    -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto' || return 1
  local exts
  exts="$(PGPASSWORD="$PG_PASSWORD" psql "$conn" -tA -c "SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension WHERE extname IN ('vector','pg_trgm','pgcrypto')")" || return 1
  echo "extensions: $exts"
  case "$exts" in *vector*pg_trgm*|*pg_trgm*vector*) ;; *) echo "vector or pg_trgm missing"; return 1 ;; esac
  DB_URL="$url"
  detail "$PG_DB as $PG_USER ($exts)"
}

# --------------------------------------------------------------------- rust
install_rust() {
  if ! command -v rustup >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs |
      sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable || return 1
  else
    rustup toolchain install stable --profile minimal || return 1
    rustup default stable || return 1
  fi
  rustup component add rustfmt clippy || return 1
  if [ "$LINK_BINS" = "1" ]; then
    local bin
    for bin in cargo rustc rustup rustfmt cargo-fmt cargo-clippy clippy-driver rustdoc; do
      [ -e "$CARGO_HOME/bin/$bin" ] && { as_root ln -sfn "$CARGO_HOME/bin/$bin" "/usr/local/bin/$bin" || return 1; }
    done
  fi
  detail "$(rustc --version | cut -d' ' -f1-2), $(cargo --version | cut -d' ' -f1-2)"
}

install_napi_cli() {
  # Global CLI only; nothing is added to package.json (RUST_ENGINE.md: no npm
  # dependency). The CLI is a Node script, and Ubuntu's own nodejs (18) is too
  # old for it, so a small wrapper runs it on the Bun runtime instead. That
  # keeps Node off the machine entirely.
  local cli="$BUN_INSTALL/install/global/node_modules/@napi-rs/cli/dist/cli.js"
  if [ ! -f "$cli" ]; then
    bun add -g @napi-rs/cli@3 || return 1
  fi
  mkdir -p "$DEV_BIN" || return 1
  printf '#!/bin/sh\n# Written by scripts/dev/rust-engine-bootstrap.sh: run the napi-rs CLI on Bun.\nexec "%s" --bun "%s" "$@"\n' \
    "$BUN_INSTALL/bin/bun" "$cli" >"$DEV_BIN/napi" || return 1
  chmod 755 "$DEV_BIN/napi" || return 1
  if [ "$LINK_BINS" = "1" ]; then
    as_root ln -sfn "$DEV_BIN/napi" /usr/local/bin/napi || return 1
  fi
  local v
  v="$("$DEV_BIN/napi" --version 2>&1 | head -n 1)" || true
  case "$v" in [0-9]*) ;; *) echo "napi --version printed: $v"; return 1 ;; esac
  detail "napi-rs CLI $v (runs on bun)"
}

# -------------------------------------------------------------- bun install
install_deps() {
  (cd "$REPO_ROOT" && bun install --frozen-lockfile) || return 1
  detail "node_modules ready (bun $(bun --version))"
}

write_env_file() {
  local url="${DB_URL:-postgresql://$PG_USER:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB}"
  local dir tmp d
  dir="$(dirname "$ENV_FILE")"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "$dir/.gbrain-rust-dev.env.XXXXXX")" || return 1
  {
    echo "# Written by scripts/dev/rust-engine-bootstrap.sh. Source it: . $ENV_FILE"
    printf 'export BUN_INSTALL=%q\n' "$BUN_INSTALL"
    printf 'export CARGO_HOME=%q\n' "$CARGO_HOME"
    printf 'export RUSTUP_HOME=%q\n' "$RUSTUP_HOME"
    for d in "$BUN_INSTALL/bin" "$CARGO_HOME/bin" "$DEV_BIN"; do
      printf 'case ":$PATH:" in *:%q:*) ;; *) export PATH=%q:"$PATH" ;; esac\n' "$d" "$d"
    done
    echo "# Local test database. Not exported as DATABASE_URL on purpose: the test"
    echo "# preload refuses a direct test run while DATABASE_URL is set. Use:"
    echo '#   DATABASE_URL="$RUST_ENGINE_DATABASE_URL" bash scripts/run-e2e.sh <files>'
    printf 'export RUST_ENGINE_DATABASE_URL=%q\n' "$url"
  } >"$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$ENV_FILE" || { rm -f "$tmp"; return 1; }
  detail "$ENV_FILE"
}

# ---------------------------------------------------------------------- run
say "repo: $REPO_ROOT  logs: $LOG_DIR"
run_step preflight preflight
if [ "$FAILED" -eq 0 ]; then
  run_step bun install_bun
  # Each Postgres step needs the one before it: never touch roles or
  # databases on a server this script did not verify.
  if run_step postgres install_postgres; then
    if run_step pg-start start_postgres; then
      run_step pg-database create_database
    else
      SUMMARY+=("SKIP  pg-database  (pg-start failed)")
    fi
  else
    SUMMARY+=("SKIP  pg-start     (postgres failed)" "SKIP  pg-database  (postgres failed)")
  fi
  if [ "$SKIP_RUST" = "1" ]; then
    SUMMARY+=("SKIP  rust         (GBRAIN_DEV_SKIP_RUST=1)")
  else
    run_step rust install_rust
    run_step napi-cli install_napi_cli
  fi
  run_step bun-install install_deps
  run_step env-file write_env_file
fi

echo
echo "== rust-engine bootstrap summary ($((SECONDS - T0))s total) =="
printf '%s\n' "${SUMMARY[@]}"
echo
if [ "$FAILED" -eq 0 ]; then
  echo "RESULT: PASS"
  echo "Next:"
  echo "  . $ENV_FILE"
  echo "  bun test --timeout=60000 test/pglite-engine.test.ts"
  echo "  DATABASE_URL=\"\$RUST_ENGINE_DATABASE_URL\" bash scripts/run-e2e.sh test/e2e/engine-parity.test.ts"
  exit 0
fi
echo "RESULT: FAIL (logs in $LOG_DIR)"
exit 1
