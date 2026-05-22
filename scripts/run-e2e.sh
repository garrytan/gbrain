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
#
# `--timeout=60000` matches the unit test suite. Bun's default is 5s,
# which is too tight for setupDB's TRUNCATE CASCADE on ~30 tables on
# CI runners under load (one CI flake observed on PR #475 hitting
# exactly 5000.09ms in the Tags beforeAll).

set -euo pipefail

cd "$(dirname "$0")/.."

# --dry-run-list: print the resolved file list (one per line) and exit. Used
# by scripts/ci-local.sh to smoke-test the argv branching at startup.
DRY_RUN_LIST=0
if [ "${1:-}" = "--dry-run-list" ]; then
  DRY_RUN_LIST=1
  shift
fi

# Argv-driven file list (used by `ci:local:diff`); fall back to the full glob.
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=(test/e2e/*.test.ts)
fi

# SHARD env (e.g. SHARD=1/4) keeps every M-th file starting at index N (1-indexed).
# Used by scripts/ci-local.sh to fan 4 shards in parallel against 4 postgres
# containers. Sequential execution within a shard is preserved (the TRUNCATE
# CASCADE no-race rationale at the top of this file still holds).
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}
  shard_m=${SHARD#*/}
  if ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  filtered=()
  i=0
  for f in "${files[@]}"; do
    if [ $((i % shard_m + 1)) -eq "$shard_n" ]; then
      filtered+=("$f")
    fi
    i=$((i + 1))
  done
  # ${filtered[@]:-} avoids "unbound variable" under `set -u` when no files matched.
  files=("${filtered[@]:-}")
  # If the empty placeholder slipped in, drop it.
  if [ "${#files[@]}" -eq 1 ] && [ -z "${files[0]}" ]; then
    files=()
  fi
fi

if [ "$DRY_RUN_LIST" = "1" ]; then
  if [ "${#files[@]}" -eq 0 ]; then
    exit 0
  fi
  printf '%s\n' "${files[@]}"
  exit 0
fi

if [ "${#files[@]}" -eq 0 ]; then
  # Empty shard (e.g. SHARD=4/4 with only 3 files): nothing to do.
  echo "No files for shard ${SHARD:-(unsharded)}; exiting clean."
  exit 0
fi

pass_files=0
fail_files=0
fail_list=()
total_pass=0
total_fail=0

for f in "${files[@]}"; do
  name=$(basename "$f")
  echo ""
  echo "=== $name ==="
  if output=$(bun test --timeout=60000 "$f" 2>&1); then
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
