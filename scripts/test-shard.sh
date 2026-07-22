#!/usr/bin/env bash
# Partition unit test files into N shards and run one shard.
#
# Usage: scripts/test-shard.sh <shard-index> <total-shards>
#   shard-index: 1-based (1..N)
#   total-shards: positive integer
#
# Excluded from sharding:
#   - test/e2e/*           — need DATABASE_URL; run via bun run test:e2e
#   - *.serial.test.ts     — concurrency-unsafe (file-wide mock.module / env
#                            leaks); run via bun run test:serial on its
#                            own runner in CI. Including these here lets
#                            their mock.module() calls leak into the rest
#                            of the shard's bun process and silently break
#                            unrelated tests.
#
# *.slow.test.ts is deliberately INCLUDED here. CI's matrix is the only
# default place these run; the local fast loop (run-unit-shard.sh)
# excludes them. See CLAUDE.md "CI vs local: intentionally divergent file
# sets" for the rationale.
#
# Partition: weight-aware LPT bin-packing via scripts/sharding.ts. Reads
# per-file runtime weights from scripts/test-weights.json (mined from real
# CI logs by scripts/mine-shard-weights.ts). Files absent from the map
# fall back to the corpus median, so adding a new test file works
# immediately without regenerating weights — worst case it lands in the
# wrong shard until next regen, never silently dropped.
#
# Stable partitioning: same `(files, weights, N)` always produces the
# same assignment, so retries are reproducible.

set -euo pipefail

DRY_RUN_LIST=0
if [ "${1:-}" = "--dry-run-list" ]; then
  DRY_RUN_LIST=1
  shift
fi

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/test-shard.sh [--dry-run-list] <shard-index> <total-shards>" >&2
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

# Collect non-E2E, non-serial unit test files. Slow files INCLUDED — see
# header comment. Local run-unit-shard.sh excludes slow files (different
# policy by design).
#
# Two test files are pulled out of the matrix and into their own dedicated
# CI jobs (see .github/workflows/test.yml):
#   - eval-longmemeval-e2e.slow.test.ts (~200s after TODO #1 engine sharing)
#     → job: slow-eval-longmemeval
#   - entity-resolve-perf.slow.test.ts (~159s, single non-subdivisible
#     perf test)
#     → job: slow-entity-resolve-perf
#
# Removing both heavy atoms from matrix-eligible files keeps the per-shard
# total bounded. With 10 matrix shards the per-shard total drops to ~272s.
# Dedicated jobs run in parallel so total CI wallclock = max(matrix ~4.5min,
# slow-eval ~3.3min, slow-entity-resolve-perf ~2.6min) ≈ 4.5min.
ALL_FILES=$(find test -name '*.test.ts' \
  -not -name '*.serial.test.ts' \
  -not -name 'eval-longmemeval-e2e.slow.test.ts' \
  -not -name 'entity-resolve-perf.slow.test.ts' \
  -not -path 'test/e2e/*' | sort)

if [ -z "$ALL_FILES" ]; then
  echo "no test files found under test/" >&2
  exit 1
fi

# Delegate the LPT partition to scripts/sharding.ts. Stream the file list
# via stdin to keep argv small (676+ files would overflow argv in some
# shells / OSes).
SHARD_FILES=$(printf '%s\n' "$ALL_FILES" | bun run scripts/sharding.ts "$SHARD_INDEX" "$TOTAL_SHARDS")

if [ "$DRY_RUN_LIST" = "1" ]; then
  printf '%s' "$SHARD_FILES"
  [ -n "$SHARD_FILES" ] && echo ""  # trailing newline if non-empty
  exit 0
fi

ALL_COUNT=$(printf '%s\n' "$ALL_FILES" | grep -c '^' || true)
SHARD_COUNT=$(printf '%s\n' "$SHARD_FILES" | grep -c '^' || true)
# grep -c on empty input returns 0 even with trailing newline edge cases
[ -z "$SHARD_FILES" ] && SHARD_COUNT=0

echo "shard $SHARD_INDEX/$TOTAL_SHARDS: ${SHARD_COUNT}/${ALL_COUNT} files (LPT-balanced)"

if [ "$SHARD_COUNT" -eq 0 ]; then
  echo "warning: shard $SHARD_INDEX has no files (total shards may exceed file count)" >&2
  exit 0
fi

# Convert newline-separated file list to argv. xargs handles the
# whitespace correctly without word-splitting on spaces in paths.
printf '%s\n' "$SHARD_FILES" | xargs bun test --timeout=60000
