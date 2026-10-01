#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: verify-target.sh --target OWNER/REPO" >&2
  exit 2
}

target=""
while (($#)); do
  case "$1" in
    --target)
      target="${2:-}"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$target" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
command -v git >/dev/null || { echo "ERROR: git is unavailable" >&2; exit 1; }
command -v gh >/dev/null || { echo "ERROR: gh is unavailable" >&2; exit 1; }

target_info="$(gh repo view "$target" --json nameWithOwner,defaultBranchRef --jq '[.nameWithOwner, .defaultBranchRef.name] | @tsv' 2>/dev/null || true)"
if [[ -z "$target_info" ]]; then
  echo "ERROR: GitHub CLI cannot access the requested upstream repository" >&2
  exit 1
fi
IFS=$'\t' read -r target_repo default_branch <<< "$target_info"

branch="$(git branch --show-current)"
[[ -n "$branch" ]] || { echo "ERROR: detached HEAD" >&2; exit 1; }
origin="$(git remote get-url origin 2>/dev/null || true)"
upstream="$(git remote get-url upstream 2>/dev/null || true)"
source_repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
status="$(git status --short)"

printf 'target=%s\ndefault_branch=%s\nsource=%s\nbranch=%s\norigin=%s\nupstream=%s\n' "$target_repo" "$default_branch" "${source_repo:-<unknown>}" "$branch" "${origin:-<none>}" "${upstream:-<none>}"
if [[ -n "$status" ]]; then
  echo "working_tree=dirty"
  printf '%s\n' "$status"
else
  echo "working_tree=clean"
fi
