#!/usr/bin/env bash
# Bring the deployment up for the operating window.
#
# ORDER MATTERS, and it is the reverse of stop.sh. Database FIRST, and wait
# for it to report Ready before anything connects: /health probes the
# database, so Container Apps will not route to a replica that comes up
# against a database still starting. Skipping the wait produces a deployment
# that looks broken for several minutes and then silently fixes itself, which
# is worse than a slow start.
#
# The worker comes up next so it can drain the overnight cycle — synthesize,
# patterns, consolidate, extract-takes — before anyone is querying
# interactively. That is the point of a morning warm-up: the nightly
# enrichment still happens, just time-shifted into the window that is paid
# for anyway.
#
# IDEMPOTENT ON PURPOSE. Running this against an already-running deployment
# must exit 0.

set -euo pipefail
# shellcheck source=scripts/azure/lib.sh
source "$(dirname "$0")/lib.sh"

require_az

state=$(pg_state)
case "$state" in
  Ready)
    log "postgres already Ready"
    ;;
  Starting)
    log "postgres already Starting"
    ;;
  *)
    log "starting postgres $PG (state=$state)"
    az postgres flexible-server start -g "$RG" -n "$PG" --output none \
      || log "WARNING: start returned non-zero (state was $state); still waiting for Ready below"
    ;;
esac

wait_for_postgres_ready

log "scaling worker $WORKER to one replica"
# Exactly one. Two supervisors race on the same job leases — the lock
# machinery survives it, but the result is duplicated LLM spend on every
# cycle phase.
az containerapp update -g "$RG" -n "$WORKER" --min-replicas 1 --max-replicas 1 --output none

# Warm the MCP app so the first client call is not a cold start. Best effort:
# the app scales to zero and a cold start is well inside Claude Code's
# 60-second first-byte timer anyway, so a failure here is a missed
# optimization, not a broken window.
brain_url=$(resolve_brain_url)
if [ -n "$brain_url" ]; then
  log "warming $brain_url/health"
  if curl -fsS --max-time 120 "$brain_url/health" >/dev/null 2>&1; then
    log "mcp warm"
  else
    log "WARNING: warm-up request failed; the app will cold-start on the first real call"
  fi
else
  log "WARNING: could not resolve the MCP app URL; skipping warm-up"
fi

log "start complete"
