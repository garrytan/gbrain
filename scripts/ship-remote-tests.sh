#!/usr/bin/env bash
# ship-remote-tests.sh — run the unit suite on GitHub's on-demand cloud
# runners instead of locally, and block until it finishes with a real
# pass/fail exit code.
#
# WHY: a local machine running many Conductor agents at once gets CPU/memory
# saturated (observed: load avg 120 on 16 cores, ~15 sibling `bun test`
# processes). The PGLite WASM test suite then OOMs (8-shard) or crawls
# (~12min for 1/3 of files vs ~85s normally). The suite already runs on
# GitHub's ephemeral runners on every PR push; this script makes a local
# caller (human or agent, e.g. /ship Step 5) AWAIT that cloud run exactly
# like a local `bun run test` — push, dispatch, `gh run watch --exit-status`.
#
# USAGE:
#   scripts/ship-remote-tests.sh [--workflow test.yml] [--branch <name>]
#                                [--no-push] [--ref <sha>]
#
# EXIT: mirrors the GitHub run — 0 on success, non-zero on failure (so it
# drops into a test gate unchanged). 2 = usage/precondition error.
#
# REQUIRES: `gh` authenticated; the workflow must declare `workflow_dispatch:`
# (test.yml does as of v0.41.32.0).
set -euo pipefail

WORKFLOW="test.yml"
BRANCH=""
DO_PUSH=1
REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --workflow) WORKFLOW="$2"; shift 2 ;;
    --branch)   BRANCH="$2"; shift 2 ;;
    --ref)      REF="$2"; shift 2 ;;
    --no-push)  DO_PUSH=0; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "ship-remote-tests: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || { echo "ship-remote-tests: gh CLI not found" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "ship-remote-tests: gh not authenticated — run 'gh auth login'" >&2; exit 2; }

[ -n "$BRANCH" ] || BRANCH="$(git branch --show-current 2>/dev/null || true)"
[ -n "$BRANCH" ] || { echo "ship-remote-tests: could not determine branch (detached HEAD?) — pass --branch" >&2; exit 2; }

if [ "$DO_PUSH" = "1" ]; then
  echo "ship-remote-tests: pushing $BRANCH ..." >&2
  git push -u origin "$BRANCH"
fi

# Dispatch against the branch (or an explicit ref). Requires workflow_dispatch
# on the workflow. The HEAD sha lets us disambiguate OUR run from any
# concurrent pull_request run on the same branch.
HEAD_SHA="$(git rev-parse "${REF:-HEAD}")"
echo "ship-remote-tests: dispatching $WORKFLOW on $BRANCH @ ${HEAD_SHA:0:8} ..." >&2
gh workflow run "$WORKFLOW" --ref "${REF:-$BRANCH}" >/dev/null

# Poll for the dispatched run to register (cli/cli#8194: `gh run watch` can
# skip a not-yet-registered run, so we resolve the databaseId ourselves first).
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" \
    --event workflow_dispatch --limit 10 \
    --json databaseId,headSha,status \
    -q "[.[] | select(.headSha==\"$HEAD_SHA\")] | sort_by(.databaseId) | last | .databaseId" 2>/dev/null || true)"
  [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && break
  sleep 3
done

if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "ship-remote-tests: could not find the dispatched run after 90s." >&2
  echo "  Check manually: gh run list --workflow $WORKFLOW --branch $BRANCH" >&2
  exit 2
fi

RUN_URL="$(gh run view "$RUN_ID" --json url -q .url 2>/dev/null || echo "")"
echo "ship-remote-tests: watching run $RUN_ID  $RUN_URL" >&2

# Block until the cloud run finishes; mirror its pass/fail as our exit code.
if gh run watch "$RUN_ID" --exit-status; then
  echo "ship-remote-tests: PASS  $RUN_URL" >&2
  exit 0
else
  rc=$?
  echo "ship-remote-tests: FAIL (exit $rc)  $RUN_URL" >&2
  echo "--- failed logs ---" >&2
  gh run view "$RUN_ID" --log-failed 2>/dev/null | tail -120 >&2 || true
  exit "$rc"
fi
