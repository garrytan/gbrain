#!/usr/bin/env bash
# tests/heavy/sync_timeout_rescue.sh
#
# v0.41.13.0 (T9) — reproduce the PR #1472 RFC's "8 of 12 cron timeouts at
# 1803s" scenario at smaller scale and assert that the v4 fix breaks the
# cascade.
#
# Production failure mode (RFC):
#   - 4 federated sources × 370K pages
#   - hourly cron with 30-min wall clock
#   - sync --all is one async-fanout process; cron SIGKILL kills the whole
#     process including sources not yet reached AND leaks the per-source
#     lock for sources mid-import
#   - next cron finds the stale lock + a bigger backlog and times out worse
#   - sources late in the fan-out (media-corpus, straylight-brain) go 50+
#     hours stale
#
# What v0.41.13.0 ships (the contract this test pins):
#   1. --timeout self-terminates each source gracefully (per-source budget
#      via D-V3-3 AbortController inside runOne; per-iteration abort check
#      in pull/delete/rename/import per D-V3-2 + D-V4-2).
#   2. --break-lock --all --max-age 1800 cron-self-heals across all sources
#      via the new last_refreshed_at semantic (D-V3-4 / D-V4-1).
#   3. partial status preserves last_commit so next cron re-walks the
#      same diff and content_hash short-circuits already-imported files.
#
# This test simulates the cascade-recovery flow by:
#   - Creating 4 in-memory PGLite "sources" backed by tiny git fixtures.
#   - Running 3 sequential sync waves with --timeout set tight enough that
#     at least one wave per source hits the partial path.
#   - Asserting every source reaches `last_commit === HEAD` within 3 waves.
#
# This is NOT a Postgres test (PGLite forces serial sync internally — see
# `parallelEligible` at sync.ts) but it exercises the per-source
# AbortController + partial-status threading + post-partial resume which
# are the load-bearing v4 changes. The Postgres parallel-fan-out case
# lives in test/e2e/sync-parallel.test.ts (D-V4-mech-10).
#
# Usage:
#   tests/heavy/sync_timeout_rescue.sh                  # quick run
#   PAGES=500 WAVES=3 TIMEOUT_SECONDS=2 tests/heavy/sync_timeout_rescue.sh
#
# Env vars:
#   PAGES            pages per source (default 200)
#   WAVES            sync waves to run (default 3)
#   TIMEOUT_SECONDS  --timeout value per wave (default 5)
#   STRICT           1 = fail if any source isn't current by WAVES waves
#                    0 = informational (default 1)

set -euo pipefail

cd "$(dirname "$0")/../.."

PAGES="${PAGES:-200}"
WAVES="${WAVES:-3}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-5}"
STRICT="${STRICT:-1}"

LOG_DIR="${GBRAIN_HOME:-$HOME/.gbrain}/audit"
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%d-%H%M%SZ)
WORKLOAD_OUT="$LOG_DIR/heavy-sync_timeout_rescue-$TS.json"

echo "[sync_timeout_rescue] pages=$PAGES waves=$WAVES timeout=${TIMEOUT_SECONDS}s strict=$STRICT"
echo "[sync_timeout_rescue] running cascade-recovery simulation..."

unset DATABASE_URL || true
set +e
timeout 600s env \
  PAGES="$PAGES" \
  WAVES="$WAVES" \
  TIMEOUT_SECONDS="$TIMEOUT_SECONDS" \
  STRICT="$STRICT" \
  bun run tests/heavy/_sync_timeout_rescue_workload.ts > "$WORKLOAD_OUT" 2>>"$LOG_DIR/heavy-sync_timeout_rescue-stderr-$TS.log"
WORKLOAD_RC=$?
set -e

if [ "$WORKLOAD_RC" -ne 0 ]; then
  echo "[sync_timeout_rescue] FAIL: workload exited $WORKLOAD_RC" >&2
  cat "$WORKLOAD_OUT" >&2 2>/dev/null || true
  echo "  See $LOG_DIR/heavy-sync_timeout_rescue-stderr-$TS.log for stderr." >&2
  exit 1
fi

cat "$WORKLOAD_OUT"
echo "[sync_timeout_rescue] PASS — every source converged within $WAVES waves."
