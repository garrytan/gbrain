#!/usr/bin/env bash
# Stop the compute half of the deployment for the off-hours window.
#
# Safe to run at any time. Nothing in this deployment holds volatile state:
# there are no git-backed sources, so nothing on the container filesystem
# must survive, and Postgres storage is untouched by a compute stop.
#
# ORDER MATTERS. Worker first, database last. Stopping Postgres while the
# worker is mid-write leaves jobs to fail and retry on the next start; the
# lease machinery recovers either way, but a clean stop avoids a burst of
# retries every morning.
#
# IDEMPOTENT ON PURPOSE. A stop that runs when everything is already stopped
# must exit 0, not fail — otherwise a skipped start, a manual stop, or a
# retried workflow all produce alert noise for a no-op.
#
# The MCP app is not stopped: it already sits at min-replicas 0 and bills only
# on request, so with no traffic it costs nothing. See §15.4 of the plan for
# a hard stop if you ever see charges you cannot explain.

set -euo pipefail
# shellcheck source=scripts/azure/lib.sh
source "$(dirname "$0")/lib.sh"

require_az

log "scaling worker $WORKER to zero"
az containerapp update -g "$RG" -n "$WORKER" --min-replicas 0 --max-replicas 0 --output none

# Wait for the replica to actually go away before touching the database. The
# supervisor handles SIGTERM gracefully, waiting up to ~40s for its child
# worker to finish the job in flight — cutting the database out from under it
# in that window is exactly what the ordering is meant to avoid.
log "waiting for worker replicas to drain"
deadline=$(( SECONDS + WORKER_DRAIN_TIMEOUT ))
while true; do
  replicas=$(az containerapp replica list -g "$RG" -n "$WORKER" --query '[].name' -o tsv 2>/dev/null || true)
  [ -z "$replicas" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    # Not fatal. Stopping the database anyway is survivable — the job lease
    # expires and the next start re-runs it — and failing here would leave
    # compute billing overnight, which is the thing this script exists to
    # prevent.
    log "WARNING: worker replicas still present after ${WORKER_DRAIN_TIMEOUT}s; stopping the database anyway"
    break
  fi
  log "worker replicas still draining..."
  sleep 10
done

state=$(pg_state)
case "$state" in
  Stopped|Stopping)
    log "postgres already $state — nothing to do"
    ;;
  *)
    log "stopping postgres $PG (state=$state)"
    # Tolerated rather than checked: a concurrent operation can leave the
    # server briefly un-stoppable, and a hard failure here would fail the
    # scheduled workflow for something the next run fixes by itself.
    az postgres flexible-server stop -g "$RG" -n "$PG" --output none \
      || log "WARNING: stop returned non-zero (state was $state); re-run if it is still running"
    ;;
esac

log "stop complete"
