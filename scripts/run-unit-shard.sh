#!/usr/bin/env bash
# scripts/run-unit-shard.sh
#
# Runs the unit suite for a single shard. Excludes test/e2e/* (those are run
# by scripts/run-e2e.sh in the E2E phase). When SHARD=N/M is set, keeps every
# M-th file starting at index N (1-indexed); otherwise runs the full unit set.
#
# Used by scripts/ci-local.sh to fan 4 unit-shard workers in parallel inside
# the runner container, each pinned to its own postgres shard for the
# downstream E2E phase.
#
# Sequential bun processes within a shard (one bun test invocation with the
# shard's file list); parallel across shards (4 of these run concurrently).

set -euo pipefail

cd "$(dirname "$0")/.."

# All non-E2E test files, sorted for deterministic shard splits.
# Tier 4: *.slow.test.ts is the convention for "always-slow" tests (e.g.,
# bootstrap correctness checks that intentionally exercise the cold init
# path and can't benefit from Tier 3's snapshot). They're excluded from the
# fast loop and run via `bun run test:slow` (or in CI where everything runs).
# Use while-read to stay portable to macOS bash 3.2 (no mapfile).
all_files=()
while IFS= read -r f; do
  all_files+=("$f")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' | sort)

files=()
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}
  shard_m=${SHARD#*/}
  if ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  i=0
  for f in "${all_files[@]}"; do
    if [ $((i % shard_m + 1)) -eq "$shard_n" ]; then
      files+=("$f")
    fi
    i=$((i + 1))
  done
else
  files=("${all_files[@]}")
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "[unit-shard ${SHARD:-(unsharded)}] no files; exiting clean."
  exit 0
fi

# --dry-run-list mirrors scripts/run-e2e.sh for inline smoke checks.
if [ "${1:-}" = "--dry-run-list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[unit-shard ${SHARD:-(unsharded)}] running ${#files[@]} files"
exec bun test --timeout=60000 "${files[@]}"
