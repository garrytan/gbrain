#!/usr/bin/env bash
# tests/heavy/sync_lock_regression.sh
# Sync writer-lock concurrency regression test.
#
# Spawns N concurrent `gbrain sync` processes against one DB; asserts:
#   1. Exactly one wins the writer lock (`gbrain-sync` row in `gbrain_cycle_locks`).
#   2. N-1 lose with "Another sync is in progress" — they fail FAST, they don't queue.
#      (Per src/commands/sync.ts:377 — performSync uses `tryAcquireDbLock`, no wait.)
#   3. After all processes exit, zero leaked `gbrain_cycle_locks` rows remain.
#
# Why the test matters: the eng-review-flagged v1 plan was wrong — the original
# plan asserted the wrong semantics ("N-1 wait then complete one at a time")
# and snapshot the wrong table (`pg_locks` instead of `gbrain_cycle_locks`).
# Both reviewers caught it; this script tests the actual contract.
#
# Postgres-only (no DATABASE_URL = graceful skip with hint).

set -euo pipefail

cd "$(dirname "$0")/../.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[sync_lock_regression] DATABASE_URL not set; skipping (informational)." >&2
  echo "  Local: docker run -d --name gbrain-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gbrain_test -p 5434:5432 pgvector/pgvector:pg16" >&2
  echo "  Then: export DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test" >&2
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[sync_lock_regression] psql required. Install postgresql-client." >&2
  exit 2
fi

TS=$(date -u +%Y%m%d-%H%M%SZ)
# Isolate from the developer's real ~/.gbrain so writing sync.repo_path doesn't
# clobber their config. Restored on exit.
TMP_GBRAIN_HOME=$(mktemp -d -t gbrain-sync-lock-home-XXXXXX)
export GBRAIN_HOME="$TMP_GBRAIN_HOME"
LOG_DIR="$GBRAIN_HOME/audit"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/heavy-sync_lock_regression-$TS.log"
# Surface the log path so it survives the EXIT trap that nukes GBRAIN_HOME.
SURFACE_LOG="${TMPDIR:-/tmp}/heavy-sync_lock_regression-$TS.log"
trap 'rm -rf "$TMP_GBRAIN_HOME"; cp -f "$LOG" "$SURFACE_LOG" 2>/dev/null || true' EXIT

NUM_PARALLEL="${NUM_PARALLEL:-4}"
echo "[sync_lock_regression] DATABASE_URL=$DATABASE_URL"
echo "[sync_lock_regression] log=$LOG"
echo "[sync_lock_regression] spawning $NUM_PARALLEL parallel sync processes..."

# Step 1: ensure schema is up-to-date by running doctor once
echo "[sync_lock_regression] init schema via gbrain doctor..." | tee -a "$LOG"
timeout 180s bun run src/cli.ts doctor --json > /dev/null 2>>"$LOG"

# Step 2: create a tiny brain dir + register it as sync.repo_path so each sync
# call has something legitimate to do.
BRAIN_DIR=$(mktemp -d -t gbrain-sync-lock-XXXXXX)
# Compose with the earlier GBRAIN_HOME-cleanup trap (NOT overwrite it).
trap 'rm -rf "$BRAIN_DIR" "$TMP_GBRAIN_HOME"; cp -f "$LOG" "$SURFACE_LOG" 2>/dev/null || true' EXIT

# Seed two markdown pages so sync has real (but trivial) work
mkdir -p "$BRAIN_DIR"
cat > "$BRAIN_DIR/page-a.md" <<'EOF'
---
title: Lock Test Page A
---
# Lock Test Page A
Trivial content for sync-lock-regression heavy test.
EOF
cat > "$BRAIN_DIR/page-b.md" <<'EOF'
---
title: Lock Test Page B
---
# Lock Test Page B
Trivial content for sync-lock-regression heavy test.
EOF

# git-init so sync's diff-walk has something to anchor (sync expects a git repo)
(cd "$BRAIN_DIR" && git init -q && git add . && git -c user.email=test@test -c user.name=test commit -q -m "seed" >/dev/null 2>&1) || true

# Tell gbrain to use this brain dir
bun run src/cli.ts config set sync.repo_path "$BRAIN_DIR" >/dev/null 2>&1 || true

# Step 3: spawn N parallel sync processes. Capture each one's exit code +
# stdout/stderr. The race for the lock happens during their startup window.
PIDS=()
EXIT_FILES=()
OUT_FILES=()
for ((i=1; i<=NUM_PARALLEL; i+=1)); do
  EXIT_F=$(mktemp -t sync-lock-exit-XXXXXX)
  OUT_F=$(mktemp -t sync-lock-out-XXXXXX)
  EXIT_FILES+=("$EXIT_F")
  OUT_FILES+=("$OUT_F")
  ( bun run src/cli.ts sync --dir "$BRAIN_DIR" >"$OUT_F" 2>&1; echo $? > "$EXIT_F" ) &
  PIDS+=($!)
done

echo "[sync_lock_regression] waiting on ${#PIDS[@]} pids..."
for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || true
done

# Step 4: collect outcomes
WINNERS=0
LOSERS=0
UNKNOWN=0
for ((i=0; i<NUM_PARALLEL; i+=1)); do
  rc=$(cat "${EXIT_FILES[$i]}" 2>/dev/null || echo "?")
  out_file="${OUT_FILES[$i]}"
  if [ "$rc" = "0" ]; then
    WINNERS=$((WINNERS + 1))
    echo "  [sync $((i+1))] rc=0 (winner)" | tee -a "$LOG"
  elif grep -q "Another sync is in progress" "$out_file" 2>/dev/null; then
    LOSERS=$((LOSERS + 1))
    echo "  [sync $((i+1))] rc=$rc (lock-busy: 'Another sync is in progress')" | tee -a "$LOG"
  else
    UNKNOWN=$((UNKNOWN + 1))
    echo "  [sync $((i+1))] rc=$rc (unknown failure — see $out_file)" | tee -a "$LOG"
    head -5 "$out_file" 2>/dev/null | sed 's/^/    > /' | tee -a "$LOG"
  fi
done

# Cleanup tmp files
rm -f "${EXIT_FILES[@]}" "${OUT_FILES[@]}"

echo "[sync_lock_regression] outcomes: winners=$WINNERS losers=$LOSERS unknown=$UNKNOWN" | tee -a "$LOG"

# Step 5: assert no leaked gbrain_cycle_locks rows. The pkey column is `id`,
# not `lock_id` (column name confirmed via \d gbrain_cycle_locks).
LEAKED=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM gbrain_cycle_locks WHERE id = 'gbrain-sync';" 2>>"$LOG" | tr -d ' ')
echo "[sync_lock_regression] post-run gbrain_cycle_locks(gbrain-sync) row count: $LEAKED" | tee -a "$LOG"

# Step 6: verdict
FAIL=0

# We must see exactly one winner. Multiple winners means the lock isn't
# enforcing exclusion; zero winners means every sync failed and we don't know
# if the lock matters.
if [ "$WINNERS" -ne 1 ]; then
  echo "[sync_lock_regression] FAIL: expected 1 winner, got $WINNERS" >&2
  FAIL=1
fi

# We must see N-1 lock-busy losers — anything else means a sync failed for a
# reason other than the lock (which would taint the measurement).
EXPECTED_LOSERS=$((NUM_PARALLEL - 1))
if [ "$LOSERS" -ne "$EXPECTED_LOSERS" ]; then
  echo "[sync_lock_regression] FAIL: expected $EXPECTED_LOSERS lock-busy losers, got $LOSERS (unknown failures: $UNKNOWN)" >&2
  FAIL=1
fi

# The lock row must be cleaned up on exit (release via try/finally).
if [ "$LEAKED" != "0" ]; then
  echo "[sync_lock_regression] FAIL: $LEAKED leaked gbrain_cycle_locks(gbrain-sync) row(s) after all syncs exited" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[sync_lock_regression] FAILED. See $LOG for details." >&2
  exit 1
fi

echo "[sync_lock_regression] OK — 1 winner, $LOSERS lock-busy losers, no leaked lock rows."
