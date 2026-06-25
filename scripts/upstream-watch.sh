#!/usr/bin/env bash
set -euo pipefail

FETCH=0
UPSTREAM_REMOTE="upstream"
UPSTREAM_BRANCH="master"
ORIGIN_REMOTE="origin"
ORIGIN_BRANCH="master"
SUMMARY_FILE=""
GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-}"
ISSUE_TITLE=""

usage() {
  cat <<'USAGE'
Usage: scripts/upstream-watch.sh [--fetch] [--summary-file <path>] [--github-output <path>] [--upstream-ref upstream/master] [--origin-ref origin/master]

Read-only wrapper around scripts/check-upstream-tracking.sh for scheduled drift
checks. Writes a markdown summary plus optional GitHub Actions outputs.
USAGE
}

render_block() {
  local content="$1"
  if [ -n "$content" ]; then
    printf '%s\n' "$content"
  else
    printf '(none)\n'
  fi
}

truncate_lines() {
  local limit="$1"
  local content="$2"
  local total
  total="$(printf '%s\n' "$content" | wc -l | tr -d ' ')"
  if [ "$total" -le "$limit" ]; then
    printf '%s\n' "$content"
    return
  fi
  printf '%s\n' "$content" | head -n "$limit"
  printf '... truncated %s additional line(s)\n' "$((total - limit))"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fetch)
      FETCH=1
      shift
      ;;
    --summary-file)
      SUMMARY_FILE="${2:-}"
      shift 2
      ;;
    --github-output)
      GITHUB_OUTPUT_FILE="${2:-}"
      shift 2
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

upstream_ref="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
origin_ref="$ORIGIN_REMOTE/$ORIGIN_BRANCH"
ISSUE_TITLE="[upstream-watch] Review $upstream_ref drift"

args=(
  --upstream-ref "$upstream_ref"
  --origin-ref "$origin_ref"
)
if [ "$FETCH" -eq 1 ]; then
  args=(--fetch "${args[@]}")
fi

scripts/check-upstream-tracking.sh "${args[@]}"

branch="$(git branch --show-current)"
head_short="$(git rev-parse --short HEAD)"
timestamp_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

upstream_counts="$(git rev-list --left-right --count "$upstream_ref"...HEAD)"
origin_counts="$(git rev-list --left-right --count "$origin_ref"...HEAD)"
upstream_behind="${upstream_counts%%[[:space:]]*}"
upstream_ahead="${upstream_counts##*[[:space:]]}"
origin_behind="${origin_counts%%[[:space:]]*}"
origin_ahead="${origin_counts##*[[:space:]]}"

upstream_moved="false"
status_line="No upstream-only commits are waiting against $upstream_ref."
if [ "$upstream_behind" -gt 0 ]; then
  upstream_moved="true"
  status_line="Upstream moved: $upstream_behind commit(s) are in $upstream_ref but not in HEAD."
fi

local_commits="$(git log --oneline --decorate --max-count=5 "$upstream_ref"..HEAD || true)"
upstream_commits="$(git log --oneline --decorate --max-count=5 HEAD.."$upstream_ref" || true)"
diffstat="$(git diff --stat "$upstream_ref"...HEAD || true)"
diffstat_for_summary="$(truncate_lines 80 "$(render_block "$diffstat")")"

if [ -n "$SUMMARY_FILE" ]; then
  cat > "$SUMMARY_FILE" <<EOF
<!-- upstream-watch -->
# Upstream watch: $( [ "$upstream_moved" = "true" ] && printf 'drift detected' || printf 'no drift' )

- Checked at: \`$timestamp_utc\`
- Branch: \`${branch:-DETACHED}\` (\`$head_short\`)
- Upstream ref: \`$upstream_ref\`
- Origin ref: \`$origin_ref\`
- Status: $status_line
- Counts vs \`$upstream_ref\`: behind $upstream_behind, ahead $upstream_ahead
- Counts vs \`$origin_ref\`: behind $origin_behind, ahead $origin_ahead

This is a read-only watch. It did not merge, rebase, or rewrite anything.

## Recent upstream commits not in HEAD

\`\`\`text
$(render_block "$upstream_commits")
\`\`\`

## Recent local commits not in $upstream_ref

\`\`\`text
$(render_block "$local_commits")
\`\`\`

## Diffstat for $upstream_ref...HEAD

\`\`\`text
$(printf '%s\n' "$diffstat_for_summary")
\`\`\`

## Manual adoption path

1. \`bun run check:upstream -- --fetch\`
2. Inspect \`$upstream_ref...HEAD\` on a clean branch.
3. Carry over only the needed upstream fix and run targeted tests before landing.
EOF
fi

if [ -n "$GITHUB_OUTPUT_FILE" ]; then
  {
    printf 'upstream_moved=%s\n' "$upstream_moved"
    printf 'upstream_behind=%s\n' "$upstream_behind"
    printf 'upstream_ahead=%s\n' "$upstream_ahead"
    printf 'origin_behind=%s\n' "$origin_behind"
    printf 'origin_ahead=%s\n' "$origin_ahead"
    printf 'issue_title=%s\n' "$ISSUE_TITLE"
  } >> "$GITHUB_OUTPUT_FILE"
fi
