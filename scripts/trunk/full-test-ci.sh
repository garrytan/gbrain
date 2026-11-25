#!/usr/bin/env bash
# Full Test (unit) CI before a push to rust-engine/main (Ember ruling ~10:00 PM PST Nov 20, after the
# 78d30a2be4 gate passed while CI's full E2E had 2 PG reds the local diff-selected subset never ran).
#
#   full-test-ci.sh <sha>
#
# Passes only when the "Test" workflow has a completed run whose head_sha is exactly <sha> and
# whose conclusion is success. Produce that run first: push <sha> to a staging branch
# (vorflux/trunk-stage-<short>) and run `gh workflow run test.yml --repo garrytan/gbrain --ref <branch>`.
# The full unit corpus runs over test.yml shards (about 25 minutes). Added 2026-11-21 after sync 7: the gate unit-lane subset missed test/serve-cli-socket-off.test.ts (Test 44912109708).
# Exit: 0 green, 1 no green run for the sha (prints what exists), 2 usage.
set -uo pipefail
SHA=${1:?usage: full-test-ci.sh <sha>}
[ "${#SHA}" -eq 40 ] || { echo "full-test-ci: need a full 40-char sha"; exit 2; }
source /var/tmp/trunk-env.sh >/dev/null 2>&1
runs=$(gh api "repos/garrytan/gbrain/actions/workflows/test.yml/runs?head_sha=$SHA&per_page=20" \
  --jq '.workflow_runs[] | "\(.id) \(.status) \(.conclusion) \(.event) \(.head_branch)"' 2>&1) || {
  echo "full-test-ci: GitHub query failed: $runs"; exit 1; }
echo "full-test-ci: Test runs for $SHA:"
echo "${runs:-  (none)}" | sed 's/^/  /'
if echo "$runs" | awk '$2=="completed" && $3=="success"' | grep -q .; then
  id=$(echo "$runs" | awk '$2=="completed" && $3=="success" {print $1; exit}')
  echo "full-test-ci: PASS run $id https://github.com/garrytan/gbrain/actions/runs/$id"
  echo "Tests: 1 passed, 0 failed"
  exit 0
fi
echo "full-test-ci: FAIL no completed successful Test run for $SHA"
echo "Tests: 0 passed, 1 failed"
exit 1
