#!/usr/bin/env bash
set -euo pipefail

FETCH=0
UPSTREAM_REMOTE="upstream"
UPSTREAM_BRANCH="master"
ORIGIN_REMOTE="origin"
ORIGIN_BRANCH="master"

usage() {
  cat <<'USAGE'
Usage: scripts/check-upstream-tracking.sh [--fetch] [--upstream-ref upstream/master] [--origin-ref origin/master]

Checks that this checkout is shaped as a downstream fork that tracks upstream.
It reports fork/upstream drift and fails only on remote-shape problems.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fetch)
      FETCH=1
      shift
      ;;
    --upstream-ref)
      ref="${2:-}"
      if [[ "$ref" != */* ]]; then
        echo "ERROR: --upstream-ref must look like remote/branch" >&2
        exit 2
      fi
      UPSTREAM_REMOTE="${ref%%/*}"
      UPSTREAM_BRANCH="${ref#*/}"
      shift 2
      ;;
    --origin-ref)
      ref="${2:-}"
      if [[ "$ref" != */* ]]; then
        echo "ERROR: --origin-ref must look like remote/branch" >&2
        exit 2
      fi
      ORIGIN_REMOTE="${ref%%/*}"
      ORIGIN_BRANCH="${ref#*/}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ "$FETCH" -eq 1 ]; then
  git fetch --all --prune
fi

upstream_ref="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
origin_ref="$ORIGIN_REMOTE/$ORIGIN_BRANCH"

if ! git remote get-url "$ORIGIN_REMOTE" >/dev/null 2>&1; then
  echo "ERROR: missing '$ORIGIN_REMOTE' remote" >&2
  exit 1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "ERROR: missing '$UPSTREAM_REMOTE' remote" >&2
  exit 1
fi

origin_fetch="$(git remote get-url "$ORIGIN_REMOTE")"
origin_push="$(git remote get-url --push "$ORIGIN_REMOTE" 2>/dev/null || true)"
upstream_fetch="$(git remote get-url "$UPSTREAM_REMOTE")"
upstream_push="$(git remote get-url --push "$UPSTREAM_REMOTE" 2>/dev/null || true)"

if ! git rev-parse --verify --quiet "$upstream_ref" >/dev/null; then
  echo "ERROR: missing upstream ref '$upstream_ref'. Run with --fetch." >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "$origin_ref" >/dev/null; then
  echo "ERROR: missing origin ref '$origin_ref'. Run with --fetch." >&2
  exit 1
fi

if [ "$upstream_push" != "DISABLED" ] && [ "$upstream_push" != "no_push" ]; then
  echo "ERROR: upstream push URL is enabled: $upstream_push" >&2
  echo "       Set it to DISABLED for downstream fork work." >&2
  exit 1
fi

branch="$(git branch --show-current)"
dirty="$(git status --short)"
upstream_counts="$(git rev-list --left-right --count "$upstream_ref"...HEAD)"
origin_counts="$(git rev-list --left-right --count "$origin_ref"...HEAD)"
upstream_behind="${upstream_counts%%[[:space:]]*}"
upstream_ahead="${upstream_counts##*[[:space:]]}"
origin_behind="${origin_counts%%[[:space:]]*}"
origin_ahead="${origin_counts##*[[:space:]]}"

echo "Fork/upstream tracking readback"
echo
echo "branch: ${branch:-DETACHED}"
echo "origin fetch: $origin_fetch"
echo "origin push:  $origin_push"
echo "upstream fetch: $upstream_fetch"
echo "upstream push:  $upstream_push"
echo
echo "against $upstream_ref: behind $upstream_behind, ahead $upstream_ahead"
echo "against $origin_ref: behind $origin_behind, ahead $origin_ahead"
echo

echo "local commits not in $upstream_ref:"
git log --oneline --decorate --max-count=12 "$upstream_ref"..HEAD || true
echo

echo "upstream commits not in HEAD:"
git log --oneline --decorate --max-count=12 HEAD.."$upstream_ref" || true
echo

echo "diffstat for $upstream_ref...HEAD:"
git diff --stat "$upstream_ref"...HEAD || true
echo

if [ -n "$dirty" ]; then
  echo "working tree: dirty"
  echo "$dirty"
else
  echo "working tree: clean"
fi

echo
echo "policy: track upstream, pin runtime to the fork only for proved local patches."
