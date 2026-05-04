#!/usr/bin/env bash
# scripts/run-serial-tests.sh — run *.serial.test.ts files with --max-concurrency=1.
#
# Serial files are tests that share file-wide state (top-level mock.module,
# module-level singletons that intentionally cross test cases) and would race
# under intra-file concurrency. Discovered via filename suffix; no annotation
# inside the file is needed.
#
# Excluded by run-unit-shard.sh and run-unit-parallel.sh's parallel pass.
# Invoked separately by run-unit-parallel.sh after the parallel pass succeeds.

set -euo pipefail

cd "$(dirname "$0")/.."

# Use while-read for portability to macOS bash 3.2 (no mapfile).
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[serial-tests] no *.serial.test.ts files found"
  exit 0
fi

# --dry-run-list mirrors run-unit-shard.sh for inline checks/tests.
if [ "${1:-}" = "--dry-run-list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[serial-tests] running ${#files[@]} file(s) with --max-concurrency=1"
exec bun test --max-concurrency=1 --timeout=60000 "${files[@]}"
