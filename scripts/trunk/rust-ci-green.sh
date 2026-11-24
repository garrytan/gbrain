#!/usr/bin/env bash
# rust-ci-green.sh <sha> <workflow-file>  (Minder CI rule, 8:18 AM PST Nov 23, PR 10131 c7106926275)
# Replaces the gate's test.yml / e2e.yml steps: trunk heads may not hand-dispatch those. Passes only when
# <workflow-file> (rust-engine.yml or rust-cli-parity.yml) has a completed successful run on exactly <sha>.
# Waits up to RUST_CI_WAIT seconds (default 10800) while a run is queued or in progress. Exit 0 green, 1 not green.
set -uo pipefail
SHA=${1:?sha}; WF=${2:?workflow file}
[ "${#SHA}" -eq 40 ] || { echo "rust-ci-green: need a full 40-char sha"; exit 2; }
source /var/tmp/trunk-env.sh >/dev/null 2>&1
deadline=$(( $(date +%s) + ${RUST_CI_WAIT:-10800} ))
while :; do
  runs=$(gh api "repos/garrytan/gbrain/actions/workflows/$WF/runs?head_sha=$SHA&per_page=20" \
    --jq '.workflow_runs[] | "\(.id) \(.status) \(.conclusion) \(.event) \(.head_branch)"' 2>&1) || { echo "rust-ci-green: query failed: $runs"; runs=""; }
  id=$(echo "$runs" | awk '$2=="completed" && $3=="success" {print $1; exit}')
  if [ -n "$id" ]; then echo "rust-ci-green: PASS $WF run $id https://github.com/garrytan/gbrain/actions/runs/$id"; echo "Tests: 1 passed, 0 failed"; exit 0; fi
  if ! echo "$runs" | awk '$2!="completed"' | grep -q . || [ "$(date +%s)" -ge "$deadline" ]; then
    echo "rust-ci-green: FAIL no successful $WF run for $SHA"; echo "${runs:-  (none)}" | sed 's/^/  /'; echo "Tests: 0 passed, 1 failed"; exit 1
  fi
  sleep 60
done
