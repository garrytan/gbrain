#!/usr/bin/env bash
# preship-e2e.sh — Run Tier 1 E2E tests when feasible during pre-ship.
#
# Closes the framework gap that let PRs #17-19 land while their E2E test
# was failing on master. The Shippable Standard's gate scan is fast and
# local; E2E catches integration regressions. Both belong in `preship`.
#
# Behavior (in order, first match wins):
#   1. DATABASE_URL set + reachable      → run bun run test:e2e against it
#   2. Docker available + responsive     → spin test container, run, tear down
#   3. Neither                           → SKIP loudly, exit 0 (CI is authoritative)
#
# Why skip-loud-exit-0 instead of exit 1: blocking ship on "you don't have
# Docker" punishes laptops without docker. The framework's enforcement
# story: preship catches what it can locally; CI is the authoritative
# gate (and you should not merge red CI). Loud skip makes the gap visible
# without blocking work.
#
# Override flags:
#   GBRAIN_PRESHIP_SKIP_E2E=1  Don't run E2E even if reachable. For
#                              cosmetic-only PRs (docs, comments) when
#                              you're confident E2E isn't relevant. Use
#                              sparingly — abuse defeats the gate.
#   GBRAIN_PRESHIP_REQUIRE_E2E=1  Reverse: skip-when-impossible becomes
#                                 fail-when-impossible. For CI environments
#                                 where you DO want a hard gate.

set -euo pipefail

cd "$(dirname "$0")/.."

# Auto-source .env.testing if it exists. This is the canonical place per
# .env.testing.example for the local Tier 1 DATABASE_URL. Sourcing it here
# means the user runs `bun run preship` once and Path 1 fires automatically
# without having to remember the env var. The file is gitignored, so each
# machine has its own copy.
#
# Explicit DATABASE_URL in the parent shell still wins (set -a is scoped to
# this `if` block, so we don't override an already-exported value).
if [[ -f .env.testing ]]; then
  # shellcheck disable=SC1091  (file is .env-format, not bash; that's fine)
  set -a
  # Only export vars from .env.testing that aren't already set, so a parent
  # shell's DATABASE_URL takes precedence.
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # Strip surrounding quotes from value if present
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < .env.testing
  set +a
fi

# Honor the explicit skip first.
if [[ "${GBRAIN_PRESHIP_SKIP_E2E:-0}" == "1" ]]; then
  echo "[preship-e2e] SKIPPED via GBRAIN_PRESHIP_SKIP_E2E=1" >&2
  echo "[preship-e2e] Reminder: CI Tier 1 (Mechanical) will run E2E. Do NOT merge if CI is red." >&2
  exit 0
fi

REQUIRE_E2E="${GBRAIN_PRESHIP_REQUIRE_E2E:-0}"

# --- Path 1: caller already has DATABASE_URL pointing at a reachable test DB ---

try_existing_database_url() {
  [[ -n "${DATABASE_URL:-}" ]] || return 1

  # Refuse to run E2E against the live brain. The Supabase pooler URL is the
  # canonical production target; running E2E against it would write/truncate
  # real data. Hard-fail with a clear message instead of silently nuking.
  if [[ "$DATABASE_URL" == *"supabase.com"* || "$DATABASE_URL" == *"supabase.co"* ]]; then
    echo "[preship-e2e] REFUSING: DATABASE_URL points at Supabase ($(echo "$DATABASE_URL" | sed 's|://[^@]*@|://***@|'))." >&2
    echo "[preship-e2e] E2E truncates tables. Set DATABASE_URL to a local test DB instead, or unset it to use the Docker fallback." >&2
    exit 2
  fi

  # Parse host + port from DATABASE_URL for pg_isready. Falls back to localhost:5432.
  local host port
  host=$(printf '%s' "$DATABASE_URL" | sed -nE 's|^postgres(ql)?://[^@]*@([^:/]+).*|\2|p')
  port=$(printf '%s' "$DATABASE_URL" | sed -nE 's|^postgres(ql)?://[^@]*@[^:]+:([0-9]+).*|\2|p')
  host="${host:-localhost}"
  port="${port:-5432}"

  if command -v pg_isready >/dev/null 2>&1; then
    if pg_isready -h "$host" -p "$port" -t 3 >/dev/null 2>&1; then
      echo "[preship-e2e] Using existing DATABASE_URL ($host:$port). Running test:e2e..." >&2
      bun run test:e2e
      return 0
    fi
    echo "[preship-e2e] DATABASE_URL set but $host:$port is not reachable; falling through." >&2
    return 1
  fi

  # No pg_isready — try the test run anyway and let bun report.
  echo "[preship-e2e] DATABASE_URL set; pg_isready not installed. Attempting E2E directly..." >&2
  bun run test:e2e
  return 0
}

# --- Path 2: spin a Docker test container, run E2E, tear down ---

try_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1

  # Pick a free port — try 5434 first (the project default per CLAUDE.md),
  # fall back through 5435/5436/5437 if any is busy.
  local port
  for candidate in 5434 5435 5436 5437; do
    if ! docker ps --filter "publish=$candidate" --format '{{.Names}}' | grep -q .; then
      port=$candidate
      break
    fi
  done
  if [[ -z "${port:-}" ]]; then
    echo "[preship-e2e] No free port in 5434-5437; falling through." >&2
    return 1
  fi

  local container="gbrain-preship-pg-$$"
  echo "[preship-e2e] Starting Docker test DB on port $port (container: $container)..." >&2

  # Tear down on any exit (success, failure, Ctrl-C).
  trap 'docker stop "$container" >/dev/null 2>&1 || true; docker rm "$container" >/dev/null 2>&1 || true' EXIT

  if ! docker run -d --name "$container" \
       -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
       -e POSTGRES_DB=gbrain_test \
       -p "$port:5432" \
       pgvector/pgvector:pg16 >/dev/null; then
    echo "[preship-e2e] Failed to start Docker container; falling through." >&2
    return 1
  fi

  # Wait until ready, max 30s. Don't loop forever if pg never comes up.
  local attempts=0
  until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ $attempts -gt 30 ]]; then
      echo "[preship-e2e] Postgres did not become ready in 30s; aborting Docker path." >&2
      return 1
    fi
    sleep 1
  done

  echo "[preship-e2e] DB ready. Running test:e2e..." >&2
  DATABASE_URL="postgresql://postgres:postgres@localhost:$port/gbrain_test" bun run test:e2e
}

# --- Path 3: skip-loud (or fail-loud if REQUIRE_E2E=1) ---

skip_or_fail() {
  if [[ "$REQUIRE_E2E" == "1" ]]; then
    echo "[preship-e2e] FAIL: GBRAIN_PRESHIP_REQUIRE_E2E=1 but no test DB available" >&2
    echo "[preship-e2e]       (no reachable DATABASE_URL, no responsive Docker daemon)." >&2
    echo "[preship-e2e]       Either start Docker, set DATABASE_URL to a local test DB, or unset GBRAIN_PRESHIP_REQUIRE_E2E." >&2
    exit 1
  fi
  echo ""                                                                    >&2
  echo "[preship-e2e] ╔════════════════════════════════════════════════════╗" >&2
  echo "[preship-e2e] ║  E2E SKIPPED                                       ║" >&2
  echo "[preship-e2e] ║  No reachable DATABASE_URL and no responsive       ║" >&2
  echo "[preship-e2e] ║  Docker daemon. Tier 1 (Mechanical) will run in    ║" >&2
  echo "[preship-e2e] ║  CI; you are responsible for green CI before merge.║" >&2
  echo "[preship-e2e] ║                                                    ║" >&2
  echo "[preship-e2e] ║  To run E2E locally: start Docker and re-run, OR   ║" >&2
  echo "[preship-e2e] ║  point DATABASE_URL at a local test Postgres.      ║" >&2
  echo "[preship-e2e] ╚════════════════════════════════════════════════════╝" >&2
  echo ""                                                                    >&2
  exit 0
}

# --- Main: try paths in order ---

if try_existing_database_url; then
  exit 0
fi

if try_docker; then
  exit 0
fi

skip_or_fail
