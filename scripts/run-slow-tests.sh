#!/usr/bin/env bash
# scripts/run-slow-tests.sh
# Tier 4 sister to run-unit-shard.sh: runs ONLY *.slow.test.ts files.
# CI runs both; bun run ci:local skips slow tests via run-unit-shard.sh.

set -euo pipefail
cd "$(dirname "$0")/.."

slow_files=()
while IFS= read -r f; do
  slow_files+=("$f")
done < <(find test -name '*.slow.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${#slow_files[@]}" -eq 0 ]; then
  echo "[run-slow-tests] no *.slow.test.ts files; nothing to do."
  exit 0
fi

echo "[run-slow-tests] running ${#slow_files[@]} slow files (CI runs these as part of bun run test)"
# v0.40.10 flake-hardening: bump per-test timeout 60s → 120s. Slow tests
# legitimately approach 60s in isolation (longmemeval E2E suite is ~50s);
# when bun runs slow files in parallel, CPU contention pushes them past
# 60s and individual tests timeout even though they'd pass solo. Slow
# tests are explicit by-name — generous per-test budget is correct.
exec bun test --timeout=120000 "${slow_files[@]}"
