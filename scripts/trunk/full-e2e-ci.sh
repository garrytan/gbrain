#!/usr/bin/env bash
# Full E2E before a push to rust-engine/main (Ember ruling ~10:00 PM PST Nov 20, after the
# 78d30a2be4 gate passed while CI's full E2E had 2 PG reds the local diff-selected subset never ran).
#
#   full-e2e-ci.sh <sha>
#
# Passes only when the "E2E Tests" workflow has a completed run whose head_sha is exactly <sha> and
# whose conclusion is success. Produce that run first: push <sha> to a staging branch
# (vorflux/trunk-stage-<short>) and run `gh workflow run e2e.yml --repo garrytan/gbrain --ref <branch>`.
# The full corpus runs over CI's 14 shards on Postgres and PGLite (about 17 minutes).
# Exit: 0 green, 1 no green run for the sha (prints what exists), 2 usage.
set -uo pipefail
SHA=${1:?usage: full-e2e-ci.sh <sha>}
[ "${#SHA}" -eq 40 ] || { echo "full-e2e-ci: need a full 40-char sha"; exit 2; }
source /var/tmp/trunk-env.sh >/dev/null 2>&1
runs=$(gh api "repos/garrytan/gbrain/actions/workflows/e2e.yml/runs?head_sha=$SHA&per_page=20" \
  --jq '.workflow_runs[] | "\(.id) \(.status) \(.conclusion) \(.event) \(.head_branch)"' 2>&1) || {
  echo "full-e2e-ci: GitHub query failed: $runs"; exit 1; }
echo "full-e2e-ci: E2E Tests runs for $SHA:"
echo "${runs:-  (none)}" | sed 's/^/  /'
if echo "$runs" | awk '$2=="completed" && $3=="success"' | grep -q .; then
  id=$(echo "$runs" | awk '$2=="completed" && $3=="success" {print $1; exit}')
  echo "full-e2e-ci: PASS run $id https://github.com/garrytan/gbrain/actions/runs/$id"
  echo "Tests: 1 passed, 0 failed"
  exit 0
fi
echo "full-e2e-ci: FAIL no completed successful E2E Tests run for $SHA"
echo "Tests: 0 passed, 1 failed"
exit 1
