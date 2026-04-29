#!/usr/bin/env bash
# Partition unit test files into N shards by stable hash and run one shard.
#
# Usage: scripts/test-shard.sh <shard-index> <total-shards>
#   shard-index: 1-based (1..N)
#   total-shards: positive integer
#
# E2E tests under test/e2e/ are excluded — they need DATABASE_URL and run via
# bun run test:e2e separately.
#
# Stable partitioning: a file's shard is `(hash(path) % N) + 1`. Same file
# lands in the same shard on every run, regardless of how many other files
# exist, so retries are reproducible. Hash is FNV-1a — pure shell, no jq.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/test-shard.sh <shard-index> <total-shards>" >&2
  exit 1
fi

SHARD_INDEX="$1"
TOTAL_SHARDS="$2"

if ! [[ "$SHARD_INDEX" =~ ^[0-9]+$ ]] || ! [[ "$TOTAL_SHARDS" =~ ^[0-9]+$ ]]; then
  echo "error: shard index and total must be positive integers" >&2
  exit 1
fi
if [ "$SHARD_INDEX" -lt 1 ] || [ "$SHARD_INDEX" -gt "$TOTAL_SHARDS" ]; then
  echo "error: shard index $SHARD_INDEX out of range 1..$TOTAL_SHARDS" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Find all unit test files, deterministic order. Excludes test/e2e/.
# Portable: avoid `mapfile` (bash 4+) so this runs on macOS bash 3.2 too.
FILES=()
while IFS= read -r line; do
  FILES+=("$line")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no test files found under test/" >&2
  exit 1
fi

# FNV-1a 32-bit hash of a string — implemented in pure bash so we don't depend
# on python/openssl/etc on the runner. Output is decimal.
fnv1a() {
  local str="$1"
  local h=2166136261  # FNV offset basis
  local i ord
  for (( i=0; i<${#str}; i++ )); do
    ord=$(printf '%d' "'${str:$i:1}")
    h=$(( (h ^ ord) & 0xFFFFFFFF ))
    h=$(( (h * 16777619) & 0xFFFFFFFF ))
  done
  echo "$h"
}

SHARD_FILES=()
for f in "${FILES[@]}"; do
  hash=$(fnv1a "$f")
  bucket=$(( hash % TOTAL_SHARDS + 1 ))
  if [ "$bucket" -eq "$SHARD_INDEX" ]; then
    SHARD_FILES+=("$f")
  fi
done

echo "shard $SHARD_INDEX/$TOTAL_SHARDS: ${#SHARD_FILES[@]}/${#FILES[@]} files"
if [ "${#SHARD_FILES[@]}" -eq 0 ]; then
  echo "warning: shard $SHARD_INDEX has no files (rehash or reduce shard count)" >&2
  exit 0
fi

exec bun test --timeout=60000 "${SHARD_FILES[@]}"
