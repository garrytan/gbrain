#!/usr/bin/env bash
# The typecheck step of test.yml and macos-validation.yml: run the incremental
# tsc, and if it aborts, run it once more from cold.
#
# Usage: scripts/ci-typecheck.sh <command>...   (test.yml: bun run typecheck)
#
# The job restores node_modules/.cache/gbrain-typecheck.tsbuildinfo from this
# head's cache entry or, failing that, from the newest entry of any head with
# the same bun.lock and tsconfig.json. Seeded from a distant head, an
# incremental tsc holds the old and the new program at once and dies at the
# heap cap (V8 "Ineffective mark-compacts near heap limit", exit 134) while a
# cold run of the same tree fits. Rerunning the job restores the same stale
# file, so it fails the same way every time.
#
# So: an attempt that ends by abort or signal (exit status above 128) deletes
# the buildinfo and runs once more, cold. Any other status ends the step at
# once with that status, so a type error (tsc exits 1 or 2) is never retried,
# and neither is an attempt cut off by its own time limit (timeout exits 124).
#
# Writes state_written=true|false to $GITHUB_OUTPUT: false when the last
# attempt aborted or hit its time limit, because tsc then wrote no state. The
# cache-save step saves only on true; saving the restored file under this
# head's key would make every rerun restore it again.
#
# GBRAIN_TYPECHECK_ATTEMPT_SECONDS bounds each attempt (default 360, the
# measured bound test.yml's step had before the retry), through timeout(1)
# or, on macOS, gtimeout. With neither, only the step's own timeout applies.
set -uo pipefail

[ "$#" -gt 0 ] || { echo "usage: scripts/ci-typecheck.sh <command>..." >&2; exit 64; }
BUILDINFO=node_modules/.cache/gbrain-typecheck.tsbuildinfo
SECONDS_PER_ATTEMPT="${GBRAIN_TYPECHECK_ATTEMPT_SECONDS:-360}"

record() {
  local written=true
  { [ "$1" -gt 128 ] || [ "$1" -eq 124 ]; } && written=false
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "state_written=$written" >> "$GITHUB_OUTPUT"
  return 0
}

LIMIT=()
if command -v timeout >/dev/null 2>&1; then LIMIT=(timeout "$SECONDS_PER_ATTEMPT")
elif command -v gtimeout >/dev/null 2>&1; then LIMIT=(gtimeout "$SECONDS_PER_ATTEMPT")
fi

${LIMIT[@]+"${LIMIT[@]}"} "$@"
status=$?
if [ "$status" -le 128 ]; then
  record "$status"
  exit "$status"
fi

echo "::warning title=typecheck aborted::tsc ended by abort or signal (exit $status) without a type error; deleting $BUILDINFO and running it once more from cold"
rm -f "$BUILDINFO"
${LIMIT[@]+"${LIMIT[@]}"} "$@"
status=$?
record "$status"
if [ "$status" -gt 128 ]; then
  echo "::error title=typecheck aborted twice::tsc ended by abort or signal (exit $status) on the cold run too; this is not a type error"
fi
exit "$status"
