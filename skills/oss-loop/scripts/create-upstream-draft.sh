#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: create-upstream-draft.sh --target OWNER/REPO --head OWNER:BRANCH --title TITLE [--body-file PATH]" >&2
  exit 2
}

target=""
head=""
title=""
body_file=""
while (($#)); do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --head) head="${2:-}"; shift 2 ;;
    --title) title="${2:-}"; shift 2 ;;
    --body-file) body_file="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$target" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ "$head" =~ ^[A-Za-z0-9_.-]+:[^:[:space:]]+$ ]] || usage
[[ -n "$title" ]] || usage
if [[ -n "$body_file" && ! -f "$body_file" ]]; then
  echo "ERROR: body file does not exist: $body_file" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$script_dir/verify-target.sh" --target "$target"

args=(pr create --repo "$target" --head "$head" --draft --title "$title")
if [[ -n "$body_file" ]]; then
  args+=(--body-file "$body_file")
else
  args+=(--body '')
fi

echo "Creating Draft PR on canonical target $target from $head" >&2
exec gh "${args[@]}"
