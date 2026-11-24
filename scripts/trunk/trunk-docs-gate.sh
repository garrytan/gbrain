#!/bin/bash
# trunk-docs-gate.sh <sha> <base>
# Docs-only lane of the trunk push gate (Ember ruling, 2026-11-21 4:47 AM PST: a docs-only push to
# rust-engine/main is gated by docs-repo-paths + build-llms, then CI on the exact pushed head).
# It passes only when:
#   1. <base> has a full GATE PASS in /var/tmp/trunk/pushgate-logs/<base>/summary.txt (the code tree was gated),
#   2. <base> is an ancestor of <sha>,
#   3. every path changed in <base>..<sha> is a doc path (docs/, changelog.d/, TODOS.md, llms.txt, llms-full.txt),
#   4. check:docs-repo-paths, build:llms (no drift) and test/build-llms.test.ts are green at <sha>.
# Output: /var/tmp/trunk/pushgate-logs/<sha>/summary.txt ending in `GATE PASS <sha> <s>` (what pre-push checks),
# with a `lane docs-only` line naming the base, or `GATE FAIL <sha> <reason>`.
set -u
export PATH="$HOME/.bun/bin:$PATH"
REPO=/code/garrytan/gbrain
SHA=$(git -C "$REPO" rev-parse --verify --quiet "$1^{commit}") || { echo "unknown sha $1" >&2; exit 2; }
BASE=$(git -C "$REPO" rev-parse --verify --quiet "$2^{commit}") || { echo "unknown base $2" >&2; exit 2; }
G=/var/tmp/trunk/pushgate-logs/$SHA; mkdir -p "$G"; S=$G/summary.txt; : > "$S"
say() { echo "$*" | tee -a "$S"; }
fail() { say "GATE FAIL $SHA $*"; exit 1; }
W0=$(date +%s)
say "HEAD $SHA"; say "BASE $BASE"; say "lane docs-only (trunk-docs-gate.sh)"
grep -Eq "^GATE PASS $BASE [0-9]+$" "/var/tmp/trunk/pushgate-logs/$BASE/summary.txt" 2>/dev/null || fail "base has no full GATE PASS"
say "base full gate: $(grep -E '^GATE PASS' /var/tmp/trunk/pushgate-logs/$BASE/summary.txt)"
git -C "$REPO" merge-base --is-ancestor "$BASE" "$SHA" || fail "base is not an ancestor"
BAD=$(git -C "$REPO" diff --name-only "$BASE" "$SHA" | grep -vE '^(docs/|changelog\.d/|TODOS\.md$|llms\.txt$|llms-full\.txt$)')
[ -z "$BAD" ] || fail "non-doc paths changed: $(echo $BAD | tr '\n' ' ')"
say "changed paths: $(git -C "$REPO" diff --name-only "$BASE" "$SHA" | tr '\n' ' ')"
WT=/var/tmp/trunk/docsgate
[ -d "$WT" ] || git -C "$REPO" worktree add -q --detach "$WT" "$SHA" || fail "worktree add"
git -C "$WT" checkout -q --detach "$SHA" || fail "checkout"
[ -e "$WT/node_modules" ] || ln -s /var/tmp/trunk/sync7/node_modules "$WT/node_modules"
cd "$WT" || fail "cd"
flock /var/tmp/trunk/bun.lock bun run check:docs-repo-paths > "$G/docs-repo-paths.log" 2>&1; rc=$?
say "docs-repo-paths rc=$rc $(grep -E '^ *[0-9]+ (pass|fail)$' "$G/docs-repo-paths.log" | tr '\n' ' ')"; [ $rc -eq 0 ] || fail docs-repo-paths
flock /var/tmp/trunk/bun.lock bun run build:llms > "$G/build-llms.log" 2>&1; rc=$?
DRIFT=$(git status --short | grep -v ' node_modules$')
say "build:llms rc=$rc drift=[${DRIFT}]"; git checkout -q -- . ; [ $rc -eq 0 ] && [ -z "$DRIFT" ] || fail build-llms
flock /var/tmp/trunk/bun.lock bun test --timeout=60000 test/build-llms.test.ts > "$G/build-llms-test.log" 2>&1; rc=$?
say "build-llms.test rc=$rc $(grep -E '^ *[0-9]+ (pass|fail)$' "$G/build-llms-test.log" | tr '\n' ' ')"; [ $rc -eq 0 ] || fail build-llms-test
say "GATE PASS $SHA $(( $(date +%s) - W0 ))"
