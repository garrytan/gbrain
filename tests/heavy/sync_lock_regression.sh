#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/_db_floor.sh"
cd "$(dirname "$0")/../.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[sync_lock_regression] DATABASE_URL not set; skipping (informational)." >&2
  exit 0
fi

export GBRAIN_TEST_ALLOW_DATABASE_URL=1
LOG_DIR="${GBRAIN_HEAVY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/gbrain-sync-lock-logs.XXXXXX")}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/heavy-sync_lock_regression-$(date -u +%Y%m%d-%H%M%SZ).log"
echo "[sync_lock_regression] log=$LOG"
bun test --timeout=180000 test/e2e/sync-lock-overlap-postgres.test.ts 2>&1 | tee "$LOG"
