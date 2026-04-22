#!/usr/bin/env bash
# Run E2E tests ONE FILE AT A TIME.
#
# Bun's default is to run test files in parallel (each in its own worker).
# Our E2E suite shares one Postgres database across all 13 files, and
# `setupDB()` does TRUNCATE CASCADE + fixture import. When files run in
# parallel, file A's TRUNCATE can race with file B's fixture import,
# producing observed fails like "expected 16 pages, got 8", missing
# links, orphaned timeline entries, etc. The flakiness was visible on
# ~3 of every 5 runs pre-fix.
#
# Running files sequentially eliminates the race entirely. It also costs
# some startup overhead (each file spins up a fresh bun process) but for
# a suite this size that is measured in ~1-2s per file, amortized under
# the natural per-file test time of 5-10s.
#
# Exits non-zero on the first failing file so CI fails fast.

set -euo pipefail

cd "$(dirname "$0")/.."

pass_files=0
fail_files=0
fail_list=()
total_pass=0
total_fail=0

for f in test/e2e/*.test.ts; do
  name=$(basename "$f")
  echo ""
  echo "=== $name ==="
  if output=$(bun test "$f" 2>&1); then
    pass_files=$((pass_files + 1))
    # Extract pass/fail counts from bun's summary (e.g., "123 pass")
    p=$(echo "$output" | grep -oE '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || echo 0)
    total_pass=$((total_pass + p))
    echo "$output" | tail -8
  else
    fail_files=$((fail_files + 1))
    fail_list+=("$name")
    p=$(echo "$output" | grep -oE '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || echo 0)
    fl=$(echo "$output" | grep -oE '[0-9]+ fail' | tail -1 | grep -oE '[0-9]+' || echo 0)
    total_pass=$((total_pass + p))
    total_fail=$((total_fail + fl))
    echo "$output"
    echo ""
    echo "FAILED: $name"
    # Continue so we see all failures; exit nonzero at the end.
  fi
done

echo ""
echo "========================================"
echo "E2E SUMMARY (sequential execution)"
echo "========================================"
echo "Files: $((pass_files + fail_files)) total, $pass_files passed, $fail_files failed"
echo "Tests: $total_pass passed, $total_fail failed"
if [ ${#fail_list[@]} -gt 0 ]; then
  echo ""
  echo "Failing files:"
  for f in "${fail_list[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
