#!/usr/bin/env bash
# Shared configuration and helpers for the Azure runbook scripts.
#
# Sourced by start.sh / stop.sh / verify.sh so the three agree on resource
# names and on what "ready" means. Every value can be overridden from the
# environment, which is what lets the same scripts run by hand and from the
# schedule workflow without a second copy.

set -euo pipefail

RG="${RG:-rg-gbrain}"
PG="${PG:-pg-gbrain}"
MCP="${MCP:-ca-gbrain-mcp}"
WORKER="${WORKER:-ca-gbrain-worker}"

# Public URL of the MCP app. Discovered from the app's own ingress when not
# set, so the scripts work before a custom domain exists.
BRAIN_URL="${BRAIN_URL:-}"

# How long to wait for Postgres to reach Ready. A start takes roughly 2-5
# minutes; 15 is generous enough that a slow start is not mistaken for a
# failed one.
PG_READY_TIMEOUT="${PG_READY_TIMEOUT:-900}"

# How long to wait for worker replicas to drain on stop. The supervisor waits
# up to ~40s for its child to finish the job in flight, so this only needs to
# outlast that plus scheduling.
WORKER_DRAIN_TIMEOUT="${WORKER_DRAIN_TIMEOUT:-300}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { printf '[%s] ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit 1; }

require_az() {
  command -v az >/dev/null 2>&1 || fail "az CLI not found on PATH"
  az account show >/dev/null 2>&1 || fail "not logged in to Azure (az login, or azure/login in CI)"
}

# Current Postgres state: Ready | Stopped | Starting | Stopping | Updating.
pg_state() {
  az postgres flexible-server show -g "$RG" -n "$PG" --query state -o tsv 2>/dev/null || echo 'Unknown'
}

# Resolve the MCP app's public base URL, preferring an explicit BRAIN_URL.
resolve_brain_url() {
  if [ -n "$BRAIN_URL" ]; then
    printf '%s' "$BRAIN_URL"
    return
  fi
  local fqdn
  fqdn=$(az containerapp show -g "$RG" -n "$MCP" \
    --query 'properties.configuration.ingress.fqdn' -o tsv 2>/dev/null || true)
  [ -n "$fqdn" ] && printf 'https://%s' "$fqdn"
}

# Block until Postgres reports Ready.
#
# This is the load-bearing wait in the whole runbook. Container Apps will not
# route traffic to a replica whose readiness probe fails, and /health probes
# the database — so bringing the apps up against a database that is still
# starting produces a deploy that looks broken for several minutes and then
# silently fixes itself.
wait_for_postgres_ready() {
  local deadline=$(( SECONDS + PG_READY_TIMEOUT ))
  local state
  while true; do
    state=$(pg_state)
    case "$state" in
      Ready) log "postgres ready"; return 0 ;;
      Stopped) fail "postgres is Stopped — the start never ran" ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || fail "postgres still '$state' after ${PG_READY_TIMEOUT}s"
    log "postgres state=$state; waiting..."
    sleep 15
  done
}
