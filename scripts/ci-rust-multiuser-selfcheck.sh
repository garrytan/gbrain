#!/usr/bin/env bash
# The Rust multi-user access self-check lane (.github/workflows/rust-multiuser-selfcheck.yml): runs this shard's
# share of the engine parity files, one Bun process per file, with the self-check on (the workflow sets the switches).
#
# Usage: scripts/ci-rust-multiuser-selfcheck.sh <shard> <shards>
#   SELFCHECK_FILES   newline-separated parity files (default: test/engine-parity/*.test.ts, sorted)
#   SELFCHECK_RUNNER  the command each file is passed to (default: bun test --timeout=60000)
#   SELFCHECK_LOG     the combined log (default: $RUNNER_TEMP/selfcheck-parity.log or ./selfcheck-parity.log)
set -euo pipefail
SHARD="${1:?shard}"
SHARDS="${2:?shards}"
RUNNER="${SELFCHECK_RUNNER:-bun test --timeout=60000}"
log="${SELFCHECK_LOG:-${RUNNER_TEMP:-.}/selfcheck-parity.log}"
files="${SELFCHECK_FILES:-$(printf '%s\n' test/engine-parity/*.test.ts | LC_ALL=C sort)}"
: > "$log"
position=0
ran=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  position=$((position + 1))
  [ $(( (position - 1) % SHARDS )) -eq $(( SHARD - 1 )) ] || continue
  [ -f "$file" ] || { echo "::error::parity file $file does not exist"; exit 1; }
  # shellcheck disable=SC2086
  $RUNNER "$file" 2>&1 | tee -a "$log"
  ran=$((ran + 1))
done <<< "$files"
echo "self-check parity shard $SHARD of $SHARDS: ran $ran of $position files"
[ "$ran" -gt 0 ] || { echo "::error::self-check parity shard $SHARD of $SHARDS ran no file"; exit 1; }
if grep -q 'access_self_check_mismatch' "$log"; then
  echo "::error::the access self-check refused a read (access_self_check_mismatch); see the lines above"
  grep -n 'access_self_check_mismatch' "$log" | head -40
  exit 1
fi
