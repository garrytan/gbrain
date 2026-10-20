#!/usr/bin/env bash
# Run several unit shards of one partition at once on one runner.
#
# Usage: scripts/test-shard-pack.sh <total-shards> <shard-index>...
#
# test.yml's `test` job runs UNIT_SHARDS_PER_JOB (scripts/sharding.ts) of the
# UNIT_SHARDS shards on one 4-vCPU runner: a shard is one bun process that
# keeps 1.1-1.5 cores busy, so a lone shard leaves most of the runner idle.
# The partition, the coverage lanes and the artifacts stay per shard. Shard s
# writes everything under $GBRAIN_SHARD_PACK_DIR/<s>/:
#   coverage/    its COVERAGE_DIR (lcov and lane-manifest.json, lane shard-<s>)
#   receipts/    its GBRAIN_TEST_RECEIPT_DIR
#   unit.log     its timing capture as job "test (<s>)" (scripts/capture-test-log.ts)
#   console.txt  its console output, printed as soon as the shard ends so two
#                shards never interleave their lines or Bun's annotations
#   exit         its exit code, written when it ends
#
# Exit status: 0 only when every shard exited 0, else the first failing
# shard's code. Each failing shard gets an ::error line naming the command
# that reproduces it. Bash 3.2 compatible (no wait -n, no associative arrays).

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: scripts/test-shard-pack.sh <total-shards> <shard-index>..." >&2
  exit 2
fi
: "${GBRAIN_SHARD_PACK_DIR:?set GBRAIN_SHARD_PACK_DIR to the directory for the per-shard outputs}"

cd "$(dirname "$0")/.."

total="$1"
shift
for s in "$@"; do
  if ! [[ "$s" =~ ^[0-9]+$ ]] || [ "$s" -lt 1 ] || [ "$s" -gt "$total" ]; then
    echo "error: shard index $s out of range 1..$total" >&2
    exit 2
  fi
done

for s in "$@"; do
  dir="$GBRAIN_SHARD_PACK_DIR/$s"
  mkdir -p "$dir"
  rm -f "$dir/exit"
  (
    rc=0
    COVERAGE_DIR="$dir/coverage" GBRAIN_TEST_RECEIPT_DIR="$dir/receipts" \
      bun scripts/capture-test-log.ts --job "test ($s)" --out "$dir/unit.log" -- \
      bash scripts/test-shard.sh "$s" "$total" > "$dir/console.txt" 2>&1 || rc=$?
    echo "$rc" > "$dir/exit"
  ) &
done

status=0
pending=("$@")
while [ "${#pending[@]}" -gt 0 ]; do
  running=()
  for s in "${pending[@]}"; do
    dir="$GBRAIN_SHARD_PACK_DIR/$s"
    if [ ! -f "$dir/exit" ]; then
      running+=("$s")
      continue
    fi
    rc=$(cat "$dir/exit")
    echo "=== unit shard $s/$total exited $rc ==="
    cat "$dir/console.txt"
    echo "=== end of unit shard $s/$total ==="
    if [ "$rc" -ne 0 ]; then
      echo "::error title=unit shard $s/$total failed::exit $rc; reproduce with: bash scripts/test-shard.sh $s $total (full log: artifact timings-unit-$s)"
      [ "$status" -ne 0 ] || status="$rc"
    fi
  done
  pending=(${running[@]+"${running[@]}"})
  [ "${#pending[@]}" -eq 0 ] || sleep 1
done
wait
exit "$status"
