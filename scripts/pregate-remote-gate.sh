#!/usr/bin/env bash
# scripts/pregate-remote-gate.sh — gbrain's remote test gate for gstack-pregate.
#
# .gstack/pregate.json names this script as `remote_gate`. Under 8 cores
# gstack-pregate records the local test tier as a requires-remote obligation
# instead of running thousands of files on the machine;
# `gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands`
# runs this script, and its last line clears the obligation:
#
#   PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n>
#
# It runs the development form of the Ubicloud gate, `bun run ci:ubicloud:diff`:
# a doc-only tree runs the doc checks and gitleaks, any other tree every lane,
# a superset of whatever pregate selected, so PREGATE_FILES_FILE is not read.
# The full gate (`bun run ci:ubicloud`) runs once per PR, at handoff, outside
# pregate (scripts/ubicloud/README.md#how-many-full-gates).
# <tree> is the working-tree content fingerprint this script computes itself
# (tracked plus untracked-unignored files, the set ci:ubicloud packs), taken
# before and after the gate; the line is printed only when both agree and,
# when gstack passed PREGATE_TREE, match it. <tests> and <failed> are summed
# from the gate's summary. No line is printed when the gate printed no
# summary. The exit code is the gate's.
#
# Needs UBI_OWNER (your thread code, lowercase) so the VMs are tagged and torn
# down as yours, plus what ci:ubicloud needs (UBICLOUD_API_KEY or
# UBICLOUD_API_TOKEN). Provider API keys are removed from the gate's
# environment. Extra arguments go to ci:ubicloud (for example --vms 8).
# Spend is not reported (no spent=), so gstack counts it at the cap.
#
# Seam: GBRAIN_PREGATE_GATE_CMD replaces `bun run ci:ubicloud:diff`
# (test/scripts/pregate-remote-gate.test.ts).
set -uo pipefail

fail() { echo "pregate-remote-gate: $1" >&2; exit "${2:-1}"; }

[ -n "${UBI_OWNER:-}" ] || fail "UBI_OWNER is not set; set it to your thread code in lowercase (e.g. UBI_OWNER=gbra106) so the gate's VMs are yours to tear down" 2

TOP=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a git checkout" 2
cd "$TOP" || exit 2

content_tree() {
  local idx real
  idx=$(mktemp "${TMPDIR:-/tmp}/pregate-remote-gate-XXXXXX") || return 1
  real=$(git rev-parse --git-path index)
  if [ -f "$real" ]; then cp "$real" "$idx"; else GIT_INDEX_FILE="$idx" git read-tree HEAD || { rm -f "$idx"; return 1; }; fi
  GIT_INDEX_FILE="$idx" git add -A . && GIT_INDEX_FILE="$idx" git write-tree
  local rc=$?
  rm -f "$idx"
  return $rc
}

before=$(content_tree) || fail "cannot fingerprint the working tree"
if [ -n "${PREGATE_TREE:-}" ] && [ "$before" != "$PREGATE_TREE" ]; then
  fail "the working tree is $before, not the tree pregate selected for ($PREGATE_TREE); rerun gstack-pregate on the current tree"
fi

log=$(mktemp "${TMPDIR:-/tmp}/pregate-remote-gate-log-XXXXXX") || fail "cannot create a log file"
trap 'rm -f "$log"' EXIT

gate_cmd=${GBRAIN_PREGATE_GATE_CMD:-bun run ci:ubicloud:diff}
# shellcheck disable=SC2086
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u VOYAGE_API_KEY -u GEMINI_API_KEY -u JEV_TYPESAFE_API_KEY -u DATABASE_URL \
  bash -c "$gate_cmd \"\$@\"" pregate-remote-gate "$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}

after=$(content_tree) || fail "cannot fingerprint the working tree after the gate"
[ "$after" = "$before" ] || fail "the working tree changed during the gate ($before -> $after); no receipt"

totals=$(awk '
  /^=== ci-ubicloud summary ===$/ { seen = 1; next }
  seen && /^ +[a-z0-9-]+ +[0-9]+ passed, [0-9]+ failed/ { passed += $2; failed += $4; rows++ }
  END { if (rows) print passed + failed, failed }
' "$log")
[ -n "$totals" ] || fail "the gate printed no ci-ubicloud summary (exit $rc); no receipt" "$([ "$rc" -ne 0 ] && echo "$rc" || echo 1)"

read -r tests failed <<<"$totals"
echo "PREGATE_REMOTE: tree=$before tests=$tests failed=$failed"
exit "$rc"
