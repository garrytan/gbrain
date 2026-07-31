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
# Sequential bounded Bun batches within a shard; parallel across shards.
# Recycling the Bun process after each batch returns PGLite/WASM high-water
# memory to the OS instead of retaining it for the shard's entire file list.

set -euo pipefail

cd "$(dirname "$0")/.."

# --max-concurrency=N is forwarded to `bun test`. v0.26.4: invoked by
# run-unit-parallel.sh; safe to call without (defaults to bun's default cap).
MAX_CONC=""
BATCH_SIZE="${GBRAIN_TEST_BATCH_SIZE:-10}"
COLD_BATCH_SIZE="${GBRAIN_TEST_COLD_BATCH_SIZE:-2}"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-concurrency) MAX_CONC="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONC="${1#*=}"; shift ;;
    --batch-size) BATCH_SIZE="$2"; shift 2 ;;
    --batch-size=*) BATCH_SIZE="${1#*=}"; shift ;;
    --dry-run-list) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! printf '%s' "$BATCH_SIZE" | grep -qE '^[0-9]+$' || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "ERROR: invalid batch size: $BATCH_SIZE" >&2
  exit 2
fi
if ! printf '%s' "$COLD_BATCH_SIZE" | grep -qE '^[0-9]+$' || [ "$COLD_BATCH_SIZE" -lt 1 ]; then
  echo "ERROR: invalid cold batch size: $COLD_BATCH_SIZE" >&2
  exit 2
fi

# All non-E2E test files, sorted for deterministic shard splits.
# Tier 4: *.slow.test.ts is "always-slow" (cold-path correctness checks);
# *.serial.test.ts is "concurrency-unsafe" (file-wide shared state). Both
# are excluded from the fast loop. Slow runs via `bun run test:slow`; serial
# runs via scripts/run-serial-tests.sh after the parallel pass.
# Use while-read to stay portable to macOS bash 3.2 (no mapfile).
all_files=()
while IFS= read -r f; do
  all_files+=("$f")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' -not -name '*.serial.test.ts' | sort)

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

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

total_files=${#files[@]}
snapshot_files=()
cold_files=()
snapshot_count=0
cold_count=0
for file in "${files[@]}"; do
  cold_path=0
  case "$file" in
    test/*migrat*.test.ts|test/bootstrap.test.ts|test/schema-bootstrap-coverage.test.ts|test/embedding-dim-check.test.ts)
      cold_path=1
      ;;
  esac
  # Some older cold-path contracts carry an in-file opt-out instead of a
  # migration-oriented filename. Detect that exact marker so they run in an
  # isolated cold batch rather than clearing the snapshot for neighboring
  # files in the same Bun process.
  if [ "$cold_path" -eq 0 ] && grep -q 'delete process\.env\.GBRAIN_PGLITE_SNAPSHOT' "$file" 2>/dev/null; then
    cold_path=1
  fi
  if [ "$cold_path" -eq 1 ]; then
    cold_files+=("$file")
    cold_count=$((cold_count + 1))
  else
    snapshot_files+=("$file")
    snapshot_count=$((snapshot_count + 1))
  fi
done

total_batches=$((
  (snapshot_count + BATCH_SIZE - 1) / BATCH_SIZE
  + (cold_count + COLD_BATCH_SIZE - 1) / COLD_BATCH_SIZE
))
echo "[unit-shard ${SHARD:-(unsharded)}] running $total_files files in $total_batches batch(es), batch-size=$BATCH_SIZE, cold-batch-size=$COLD_BATCH_SIZE, cold-path=$cold_count"

batch_n=0
run_group() {
  local mode="$1"
  local limit="$2"
  shift 2
  local group=("$@")
  local group_total=${#group[@]}
  local offset=0
  local batch
  while [ "$offset" -lt "$group_total" ]; do
    batch_n=$((batch_n + 1))
    batch=("${group[@]:offset:limit}")
    echo "[unit-shard ${SHARD:-(unsharded)}] batch $batch_n/$total_batches mode=$mode running ${#batch[@]} files"
    local rc=0
    if [ "$mode" = "cold" ]; then
      if [ -n "$MAX_CONC" ]; then
        GBRAIN_PGLITE_SNAPSHOT= bun test --max-concurrency="$MAX_CONC" --timeout=60000 "${batch[@]}" || rc=$?
      else
        GBRAIN_PGLITE_SNAPSHOT= bun test --timeout=60000 "${batch[@]}" || rc=$?
      fi
    elif [ -n "$MAX_CONC" ]; then
      bun test --max-concurrency="$MAX_CONC" --timeout=60000 "${batch[@]}" || rc=$?
    else
      bun test --timeout=60000 "${batch[@]}" || rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
      echo "[unit-shard ${SHARD:-(unsharded)}] ABORTED after failed batch $batch_n/$total_batches rc=$rc; remaining batches were not run" >&2
      return "$rc"
    fi
    offset=$((offset + limit))
  done
}

if [ "$snapshot_count" -gt 0 ]; then
  run_group snapshot "$BATCH_SIZE" "${snapshot_files[@]}"
fi
if [ "$cold_count" -gt 0 ]; then
  run_group cold "$COLD_BATCH_SIZE" "${cold_files[@]}"
fi
