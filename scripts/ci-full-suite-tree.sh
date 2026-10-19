#!/usr/bin/env bash
# Record the tree a full-profile run tested (docs/ci-event-parity.md#full-ci-on-pull-requests).
# Called by test.yml `full-suite` and e2e.yml `e2e-full-suite` after their
# aggregate succeeded. scripts/ci-reuse.ts reads the artifact on a push to master.
# Input (environment): ARTIFACT_DIR, RUN_ID, RUN_ATTEMPT, WORKFLOW, EVENT.
# Output: $ARTIFACT_DIR/tree.json and one step-summary line.
set -euo pipefail

mkdir -p "$ARTIFACT_DIR"
tree=$(git rev-parse 'HEAD^{tree}')
jq -n --arg tree "$tree" --arg sha "$(git rev-parse HEAD)" --arg workflow "$WORKFLOW" --arg event "$EVENT" \
  --argjson run_id "$RUN_ID" --argjson run_attempt "$RUN_ATTEMPT" \
  '{tree: $tree, sha: $sha, workflow: $workflow, event: $event, run_id: $run_id, run_attempt: $run_attempt, profile: "full"}' \
  | tee "$ARTIFACT_DIR/tree.json"
echo "$WORKFLOW full suite passed on tree $tree (commit $(git rev-parse HEAD), run $RUN_ID attempt $RUN_ATTEMPT)." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
