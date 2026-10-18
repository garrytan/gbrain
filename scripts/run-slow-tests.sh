#!/usr/bin/env bash
# scripts/run-slow-tests.sh
# Tier 4 sister to run-unit-shard.sh: runs ONLY *.slow.test.ts files.
# CI and bun run ci:local both run this lane alongside the unit shards.

set -euo pipefail

# #3485: unit/slow tests need no database — strip ambient DB URLs at this
# wrapper boundary so the bunfig preload guard passes and nothing can reach a
# real brain. The e2e wrapper (run-e2e.sh) is the only lane that keeps them.
unset DATABASE_URL GBRAIN_DATABASE_URL
# An ambient GBRAIN_HOME (a dev shell configured for a real brain) must not
# reach unit tests either: the gbrain-home-preload respects a pre-set value
# (the e2e wrapper needs that), so strip it at this boundary and let the
# preload allocate per-run scratch instead.
unset GBRAIN_HOME
cd "$(dirname "$0")/.."

# --dry-run-list prints the selection; --dry-run-list-exclusive prints only
# the machine-exclusive entries. Positional FILE arguments replace discovery
# (scripts/ci-ubicloud.ts dispatches explicit batches).
DRY_RUN_MODE=""
case "${1:-}" in
  --dry-run-list|--dry-run-list-exclusive) DRY_RUN_MODE="$1"; shift ;;
esac

# EXCLUSIVE_FILES: latency contracts that must run on an otherwise idle
# machine, the way GitHub CI runs them on a dedicated perf runner.
# scripts/ci-ubicloud.ts runs them as control items on a VM with no other
# work; this script's own lane already runs files one at a time.
EXCLUSIVE_FILES=(
  # entity() p99 < 100ms on a 20K-page corpus. Next to 7 heavy items on a
  # 16-vCPU VM the whole process runs 1.6-2.6x slower (thread CPU time
  # rises with wall time, so no in-process clock can separate it).
  "test/entity-card-perf.slow.test.ts"
)

slow_files=()
if [ "$#" -gt 0 ]; then
  slow_files=("$@")
else
  while IFS= read -r f; do
    slow_files+=("$f")
  done < <(find test -name '*.slow.test.ts' -not -path 'test/e2e/*' | sort)
fi

if [ "$DRY_RUN_MODE" = "--dry-run-list" ]; then
  if [ "${#slow_files[@]}" -gt 0 ]; then printf '%s\n' "${slow_files[@]}"; fi
  exit 0
fi
if [ "$DRY_RUN_MODE" = "--dry-run-list-exclusive" ]; then
  for f in ${slow_files[@]+"${slow_files[@]}"}; do
    for e in "${EXCLUSIVE_FILES[@]}"; do
      [ "$f" != "$e" ] || printf '%s\n' "$f"
    done
  done
  exit 0
fi

. scripts/lib/test-env.sh
receipts_init slow
ensure_pglite_snapshot "run-slow-tests"
ensure_default_pglite_snapshot "run-slow-tests"

if [ "${#slow_files[@]}" -eq 0 ]; then
  echo "[run-slow-tests] no *.slow.test.ts files; nothing to do."
  receipt_empty all "" ""
  exit 0
fi

echo "[run-slow-tests] running ${#slow_files[@]} slow files (CI runs these as part of bun run test)"
# v0.40.10 flake-hardening: bump per-test timeout 60s → 120s. Slow tests
# legitimately approach 60s in isolation (longmemeval E2E suite is ~50s);
# when bun runs slow files in parallel, CPU contention pushes them past
# 60s and individual tests timeout even though they'd pass solo. Slow
# tests are explicit by-name — generous per-test budget is correct.
receipt_begin primary all "" "" "" "${slow_files[@]}"
rc=0
bun test --timeout=120000 ${RECEIPT_ARGS[@]+"${RECEIPT_ARGS[@]}"} "${slow_files[@]}" || rc=$?
receipt_end "$rc"
exit "$rc"
