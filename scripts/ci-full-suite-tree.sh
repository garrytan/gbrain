#!/usr/bin/env bash
# Record the tree a full-profile run tested and the test files it executed
# (docs/ci-event-parity.md#full-ci-on-pull-requests, #remote-gate-reuse).
# Called by test.yml `full-suite` and e2e.yml `e2e-full-suite` after their
# aggregate succeeded. scripts/ci-reuse.ts reads the artifact on a push to master;
# `gstack-pregate clear --run` reads it as run evidence for the remote gate.
# Input (environment): ARTIFACT_DIR, RUN_ID, RUN_ATTEMPT, WORKFLOW, EVENT, and
# optionally MANIFEST, the run's ci-manifest.json (scripts/ci-manifest.ts), and
# RUNNER_OS, which GitHub Actions sets on every runner.
# Output: $ARTIFACT_DIR/tree.json and step-summary lines.
# `os` is the runner's OS (Linux, macOS or Windows) when RUNNER_OS is set.
# gstack refuses a run under a .gstack/pregate.json run profile that sets `os`
# unless tree.json records that OS (gstack docs/pregate.md#run-evidence).
# `files` (every test file the run loaded, repo-relative, across lanes and
# arms; a file whose tests all skipped counts, because the remote gate's
# inventory lists the same env- and platform-gated files) and `tests` (its
# executed test count) come only from a complete manifest of this run, attempt
# and commit. Otherwise both are left out with a warning: the record still says
# the full suite passed, but gstack cannot take it as run evidence. After a
# re-run of only the failed jobs, each job's newest attempt counts (the manifest
# covers every file across attempts), and the files whose newest receipt came
# from the re-run are named in `rerun_files`, with the run's `attempts`. A
# manifest that still lists a failing test is never evidence.
set -euo pipefail

mkdir -p "$ARTIFACT_DIR"
tree=$(git rev-parse 'HEAD^{tree}')
sha=$(git rev-parse HEAD)
evidence="$ARTIFACT_DIR/evidence.json"
echo '{}' > "$evidence"
problem=""
if [ -z "${MANIFEST:-}" ] || [ ! -s "$MANIFEST" ]; then
  problem="no ci-manifest.json from this run"
else
  problem=$(jq -r --argjson id "$RUN_ID" --argjson attempt "$RUN_ATTEMPT" --arg sha "$sha" '
    if .schema != "gbrain-ci-manifest/v1" then "ci-manifest.json has schema \(.schema)"
    elif .run_id != $id or .run_attempt != $attempt then "ci-manifest.json belongs to run \(.run_id) attempt \(.run_attempt), not run \($id) attempt \($attempt) (re-run the whole workflow, not only its failed jobs)"
    elif .sha != $sha then "ci-manifest.json belongs to commit \(.sha), not \($sha)"
    elif .complete != true then "ci-manifest.json is incomplete: \(.problems | join("; "))"
    elif ((.failures // []) | length) > 0 then "ci-manifest.json lists \(.failures | length) failing test(s) in the newest attempt of each job"
    else "" end' "$MANIFEST" 2>&1) || problem="ci-manifest.json is unreadable: $problem"
  if [ -z "$problem" ]; then
    if ! jq -c '{files: ([.files[].file | select(test("\\.test\\.[cm]?[jt]sx?$"))] | unique), tests: ([.files[].executed] | add // 0)}
      + (if any(.files[]; .rerun == true) then {rerun_files: ([.files[] | select(.rerun == true) | .file | select(test("\\.test\\.[cm]?[jt]sx?$"))] | unique), attempts: .attempts} else {} end)' "$MANIFEST" > "$evidence" 2>/dev/null; then
      problem="ci-manifest.json has no readable files list"; echo '{}' > "$evidence"
    elif [ "$(jq '.files | length' "$evidence")" -eq 0 ]; then
      problem="ci-manifest.json lists no test file"; echo '{}' > "$evidence"
    fi
  fi
fi
jq -n --arg tree "$tree" --arg sha "$sha" --arg workflow "$WORKFLOW" --arg event "$EVENT" \
  --argjson run_id "$RUN_ID" --argjson run_attempt "$RUN_ATTEMPT" --slurpfile evidence "$evidence" --arg os "${RUNNER_OS:-}" \
  '{tree: $tree, sha: $sha, workflow: $workflow, event: $event, run_id: $run_id, run_attempt: $run_attempt, profile: "full"}
    + (if $os == "" then {} else {os: $os} end) + $evidence[0]' \
  > "$ARTIFACT_DIR/tree.json"
rm -f "$evidence"
jq -c 'del(.files)' "$ARTIFACT_DIR/tree.json"
echo "$WORKFLOW full suite passed on tree $tree (commit $sha, run $RUN_ID attempt $RUN_ATTEMPT)." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
if [ -n "$problem" ]; then
  echo "::warning::tree.json records no executed test files: $problem. The full suite still counts for merge, but not as gstack run evidence."
  echo "No executed-file list: $problem." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
else
  echo "Run evidence: $(jq '.files | length' "$ARTIFACT_DIR/tree.json") test files, $(jq .tests "$ARTIFACT_DIR/tree.json") executed tests." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
