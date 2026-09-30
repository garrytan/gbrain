#!/usr/bin/env bash
# Smoke-test run-e2e.sh's argv and shard handling (called by ci-local.sh).
# The expected default corpus is the test/e2e glob minus the shared live-key
# list (scripts/e2e-live-key-only.txt, the same file run-e2e.sh skips) plus
# phantom-redirect-engine-parity, which lives in test/ but whose Postgres arm
# is only reachable through the DATABASE_URL-bearing E2E lane.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

live_key_only=$(grep -v '^[[:space:]]*#' scripts/e2e-live-key-only.txt | sed '/^[[:space:]]*$/d')
EXPECTED_ALL=$(( $(ls test/e2e/*.test.ts | grep -vxF -e "${live_key_only:-/}" | wc -l | tr -d ' ') + 1 ))

SMOKE_NO_ARGS=$(bash scripts/run-e2e.sh --dry-run-list | wc -l | tr -d ' ')
if [ "$SMOKE_NO_ARGS" != "$EXPECTED_ALL" ]; then
  echo "[ci-local] ERROR: --dry-run-list (no args) printed $SMOKE_NO_ARGS, expected $EXPECTED_ALL" >&2
  exit 1
fi
SMOKE_ONE_ARG=$(bash scripts/run-e2e.sh --dry-run-list test/e2e/sync.test.ts)
if [ "$SMOKE_ONE_ARG" != "test/e2e/sync.test.ts" ]; then
  echo "[ci-local] ERROR: --dry-run-list with 1 arg printed '$SMOKE_ONE_ARG'" >&2
  exit 1
fi
SHARD_TOTAL=$(( $(SHARD=1/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) + \
                $(SHARD=2/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) + \
                $(SHARD=3/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) + \
                $(SHARD=4/4 bash scripts/run-e2e.sh --dry-run-list | wc -l) ))
if [ "$SHARD_TOTAL" != "$EXPECTED_ALL" ]; then
  echo "[ci-local] ERROR: shards 1-4 covered $SHARD_TOTAL files, expected $EXPECTED_ALL" >&2
  exit 1
fi
echo "[ci-local] Smoke OK ($SMOKE_NO_ARGS files no-arg, 1 single-arg, ${SHARD_TOTAL}=4-shard total)."
