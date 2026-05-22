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
exec bun test --timeout=60000 "${slow_files[@]}"
