export const CLAUDE_MBRAIN_SKIP_DIRS = `# mbrain Stop-hook skip list (one absolute path per line)
#
# Add directories where you do not want Claude Code to prompt for
# a mbrain writeback check at session end.
#
# Example:
# /tmp/throwaway-experiment
# /home/me/scratch
`;

export const CLAUDE_MBRAIN_RELEVANCE_LIB = `# mbrain-relevance.sh

_mbrain_normalize_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    (
      cd "$dir" 2>/dev/null && pwd -P
    )
    return 0
  fi

  printf '%s\n' "$dir"
}

_mbrain_skip_dir_match() {
  local cwd="$1"
  local file="$2"
  [ -f "$file" ] || return 1
  local normalized_cwd
  normalized_cwd="$(_mbrain_normalize_dir "$cwd")"

  while IFS= read -r line || [ -n "$line" ]; do
    line="\${line#"\${line%%[![:space:]]*}"}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    if [ "$line" = "$cwd" ]; then
      return 0
    fi
    if [ "$(_mbrain_normalize_dir "$line")" = "$normalized_cwd" ]; then
      return 0
    fi
  done < "$file"

  return 1
}

mbrain_is_relevant() {
  if [ "\${MBRAIN_STOP_HOOK:-1}" = "0" ]; then
    return 1
  fi

  local cwd="$(pwd)"
  local skipfile="\${MBRAIN_SKIP_DIRS_FILE:-$HOME/.claude/mbrain-skip-dirs}"
  if _mbrain_skip_dir_match "$cwd" "$skipfile"; then
    return 1
  fi

  if ! command -v mbrain >/dev/null 2>&1; then
    return 1
  fi

  return 0
}
`;

export const CLAUDE_MBRAIN_STOP_HOOK = `#!/bin/bash
set -u

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="\${MBRAIN_STOP_HOOK_LOG:-$HOME/.claude/logs/mbrain-stop-hook.log}"
# shellcheck source=lib/mbrain-relevance.sh
source "$HOOK_DIR/lib/mbrain-relevance.sh"

log_line() {
  local decision="$1"
  local session_id="$2"
  local reason="\${3:-}"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  printf '%s %s %s %s\n' "$ts" "$session_id" "$decision" "$reason" >> "$LOG_FILE" 2>/dev/null || true
}

extract_session_id() {
  local raw="$1"
  printf '%s' "$raw" | jq -r 'try .session_id // "unknown"' 2>/dev/null || printf 'unknown'
}

extract_stop_active() {
  local raw="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$raw" | jq -r 'try .stop_hook_active // false' 2>/dev/null && return 0
  fi
  if printf '%s' "$raw" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
    printf 'true'
  else
    printf 'false'
  fi
}

RAW_INPUT="$(cat)"
SESSION_ID="$(extract_session_id "$RAW_INPUT")"
STOP_ACTIVE="$(extract_stop_active "$RAW_INPUT")"

if [ "$STOP_ACTIVE" = "true" ]; then
  log_line "reentry" "$SESSION_ID" "stop_hook_active=true"
  printf '%s' "$RAW_INPUT"
  exit 0
fi

if ! mbrain_is_relevant; then
  log_line "skip" "$SESSION_ID" "relevance-gate"
  printf '%s' "$RAW_INPUT"
  exit 0
fi

REASON='MBrain memory check (not a crash): if durable knowledge emerged, write it with sources/backlinks and sync; otherwise reply exactly MBRAIN-PASS: <short reason>.'

log_line "block" "$SESSION_ID" "gate-passed"

printf '%s\n' '{"decision":"block","reason":"MBrain memory check (not a crash): if durable knowledge emerged, write it with sources/backlinks and sync; otherwise reply exactly MBRAIN-PASS: <short reason>."}'
`;
