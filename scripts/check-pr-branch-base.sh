#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${GBRAIN_PR_BASE_REF:-origin/master}"
FETCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --fetch)
      FETCH=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/check-pr-branch-base.sh [--base origin/master] [--fetch]

Fails when the current branch is not based on the upstream PR base. This
prevents fork-only or stale work-branch commits from leaking into PRs.

Override only for deliberate exceptions:
  GBRAIN_SKIP_PR_BRANCH_BASE_CHECK=1 git push ...
EOF
      exit 0
      ;;
    *)
      echo "check-pr-branch-base: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "${GBRAIN_SKIP_PR_BRANCH_BASE_CHECK:-}" == "1" ]]; then
  echo "check-pr-branch-base: skipped by GBRAIN_SKIP_PR_BRANCH_BASE_CHECK=1" >&2
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "check-pr-branch-base: not inside a git worktree" >&2
  exit 2
fi
cd "$ROOT"

BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "$BRANCH" ]]; then
  echo "check-pr-branch-base: detached HEAD; refusing PR push" >&2
  exit 1
fi

case "$BRANCH" in
  master|main)
    echo "check-pr-branch-base: on $BRANCH; no feature-branch PR base check needed" >&2
    exit 0
    ;;
esac

if [[ "$FETCH" == "1" ]]; then
  git fetch --quiet origin master
fi

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "check-pr-branch-base: missing base ref '$BASE_REF'; run: git fetch origin master" >&2
  exit 2
fi

if git merge-base --is-ancestor "$BASE_REF" HEAD; then
  echo "check-pr-branch-base: ok ($BRANCH contains $BASE_REF)" >&2
  exit 0
fi

BASE_SHA="$(git rev-parse --short "$BASE_REF")"
MERGE_BASE="$(git merge-base HEAD "$BASE_REF" | cut -c1-8)"

cat >&2 <<EOF
check-pr-branch-base: refusing PR branch '$BRANCH'

$BASE_REF ($BASE_SHA) is not an ancestor of HEAD.
Merge base is $MERGE_BASE, so an upstream PR would include fork-only or stale
branch commits in addition to the change you mean to ship.

Commits currently unique to this branch vs $BASE_REF:
EOF

git log --oneline --decorate --no-merges "$BASE_REF"..HEAD >&2 || true

cat >&2 <<'EOF'

Durable fix:
  git fetch origin master
  git switch -c <new-branch> origin/master
  git cherry-pick <only-the-keeper-commits>
  git push fork <new-branch>

If this is a deliberate exception, rerun with:
  GBRAIN_SKIP_PR_BRANCH_BASE_CHECK=1 git push ...
EOF

exit 1
