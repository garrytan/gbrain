#!/usr/bin/env bash
# The Rust multi-user access self-check lane (.github/workflows/rust-multiuser-selfcheck.yml): runs this shard's
# share of the engine parity files, one Bun process per file, with the self-check on (the workflow sets the switches).
# Every file of the shard runs, whatever an earlier file did. The run is red when any file fails, when any output
# holds access_self_check_mismatch (the store's derivation differs from the TypeScript policy) or fence_missing (a
# member read without its fence), or when the shard ran no file. The summary names each such file.
#
# Usage: scripts/ci-rust-multiuser-selfcheck.sh <shard> <shards>
#   SELFCHECK_FILES   newline-separated parity files (default: test/engine-parity/*.test.ts, sorted)
#   SELFCHECK_RUNNER  the command each file is passed to (default: bun test --timeout=60000)
#   SELFCHECK_LOG     the combined log (default: $RUNNER_TEMP/selfcheck-parity.log or ./selfcheck-parity.log)
set -uo pipefail
SHARD="${1:?shard}"
SHARDS="${2:?shards}"
RUNNER="${SELFCHECK_RUNNER:-bun test --timeout=60000}"
log="${SELFCHECK_LOG:-${RUNNER_TEMP:-.}/selfcheck-parity.log}"
files="${SELFCHECK_FILES:-$(printf '%s\n' test/engine-parity/*.test.ts | LC_ALL=C sort)}"
one="$(mktemp)"
trap 'rm -f "$one"' EXIT
: > "$log"
position=0
ran=0
failed=""
mismatched=""
fenced=""
nfailed=0
nmismatched=0
nfenced=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  position=$((position + 1))
  [ $(( (position - 1) % SHARDS )) -eq $(( SHARD - 1 )) ] || continue
  if [ ! -f "$file" ]; then
    echo "::error::parity file $file does not exist"
    failed="$failed $file"
    nfailed=$((nfailed + 1))
    continue
  fi
  # shellcheck disable=SC2086
  $RUNNER "$file" > "$one" 2>&1
  status=$?
  tee -a "$log" < "$one"
  ran=$((ran + 1))
  if [ "$status" -ne 0 ]; then failed="$failed $file"; nfailed=$((nfailed + 1)); fi
  if grep -q 'access_self_check_mismatch' "$one"; then mismatched="$mismatched $file"; nmismatched=$((nmismatched + 1)); fi
  if grep -q 'fence_missing' "$one"; then fenced="$fenced $file"; nfenced=$((nfenced + 1)); fi
done <<< "$files"
echo "self-check parity shard $SHARD of $SHARDS: ran $ran of $position files"
red=0
if [ "$ran" -eq 0 ]; then echo "::error::self-check parity shard $SHARD of $SHARDS ran no file"; red=1; fi
for f in $mismatched; do echo "::error file=$f::the access self-check refused a read (access_self_check_mismatch) in $f"; red=1; done
for f in $fenced; do echo "::error file=$f::a member read without its fence (fence_missing) in $f"; red=1; done
for f in $failed; do echo "::error file=$f::parity file failed with the self-check on: $f"; red=1; done
if [ -n "$mismatched" ]; then grep -n 'access_self_check_mismatch' "$log" | head -40; fi
echo "self-check parity shard $SHARD of $SHARDS: failed=$nfailed mismatch=$nmismatched fence_missing=$nfenced"
exit "$red"
