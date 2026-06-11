export const CLAUDE_MBRAIN_SKIP_DIRS = `# mbrain Stop-hook skip list (one absolute path per line)
#
# Add directories where you do not want Claude Code to prompt for
# a mbrain assertion-pipeline reminder at session end.
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

_mbrain_gate_common() {
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

mbrain_is_relevant() {
  if [ "\${MBRAIN_STOP_HOOK:-1}" = "0" ]; then
    return 1
  fi

  _mbrain_gate_common
}

mbrain_prompt_is_relevant() {
  if [ "\${MBRAIN_PROMPT_HOOK:-1}" = "0" ]; then
    return 1
  fi

  _mbrain_gate_common
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
SESSION_ID="\${SESSION_ID%%$'\\n'*}"
STOP_ACTIVE="$(extract_stop_active "$RAW_INPUT")"

if [ "$STOP_ACTIVE" = "true" ]; then
  log_line "reentry" "$SESSION_ID" "stop_hook_active=true"
  exit 0
fi

if ! mbrain_is_relevant; then
  log_line "skip" "$SESSION_ID" "relevance-gate"
  exit 0
fi

MODE="\${MBRAIN_STOP_HOOK_MODE:-silent}"

if [ "$MODE" = "block" ]; then
  log_line "block" "$SESSION_ID" "gate-passed"
  printf '%s\n' '{"decision":"block","reason":"MBrain memory check (not a crash): route durable signals through route_memory_writeback and the assertion pipeline; eligible writes become governed canonical memory, ambiguous ones become candidates. Otherwise reply exactly MBRAIN-PASS: <short reason>."}'
  exit 0
fi

if [ "$MODE" = "capture" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    log_line "capture-skip" "$SESSION_ID" "jq-missing"
    exit 0
  fi
  TRANSCRIPT_PATH="$(printf '%s' "$RAW_INPUT" | jq -r 'try .transcript_path // empty' 2>/dev/null)"
  if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    log_line "capture-skip" "$SESSION_ID" "transcript-missing"
    exit 0
  fi
  FILE_SIZE="$(stat -f%z "$TRANSCRIPT_PATH" 2>/dev/null || stat -c%s "$TRANSCRIPT_PATH" 2>/dev/null || echo 0)"
  if [ "$FILE_SIZE" -gt 52428800 ]; then
    log_line "capture-skip" "$SESSION_ID" "transcript-too-large size=$FILE_SIZE"
    exit 0
  fi
  CAPTURE_LOG="\${MBRAIN_CAPTURE_LOG:-$HOME/.claude/logs/mbrain-session-capture.log}"
  mkdir -p "$(dirname "$CAPTURE_LOG")" 2>/dev/null || true
  # Background the capture so session exit never blocks on the database.
  # write_mode candidate_only: captured signals only ever become Memory Inbox
  # candidates; injection-flagged signals are suppressed inside the pipeline.
  nohup mbrain agent-session capture \\
    --transcript-path "$TRANSCRIPT_PATH" \\
    --session-id "$SESSION_ID" \\
    --apply --write-mode candidate_only \\
    >> "$CAPTURE_LOG" 2>&1 &
  log_line "capture" "$SESSION_ID" "backgrounded pid=$!"
  exit 0
fi

if [ "$MODE" != "silent" ]; then
  log_line "unknown-mode" "$SESSION_ID" "MBRAIN_STOP_HOOK_MODE=$MODE treated-as-silent"
  exit 0
fi

# Default silent mode emits nothing: Claude Code renders blocking Stop reasons
# as "Stop hook error" and forces an extra reply turn, so the routine memory
# duty is injected per prompt by prompt-mbrain-context.sh instead.
log_line "silent" "$SESSION_ID" "non-blocking-default"
exit 0
`;

export const CLAUDE_MBRAIN_PROMPT_HOOK = `#!/bin/bash
set -u

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="\${MBRAIN_PROMPT_HOOK_LOG:-$HOME/.claude/logs/mbrain-prompt-hook.log}"
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

# UserPromptSubmit treats plain stdout as model context, so this hook prints
# either the structured JSON below or nothing at all. Never echo RAW_INPUT.
RAW_INPUT="$(cat)"
SESSION_ID="$(extract_session_id "$RAW_INPUT")"
SESSION_ID="\${SESSION_ID%%$'\\n'*}"

if ! mbrain_prompt_is_relevant; then
  log_line "skip" "$SESSION_ID" "relevance-gate"
  exit 0
fi

log_line "inject" "$SESSION_ID" "context-injected"

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"MBrain is connected. If the request involves a named person, company, project, meeting, technical concept, internal system, or a prior decision, check MBrain before answering from general knowledge: call retrieve_context first, then read_context for the returned required_reads. If MBrain has nothing relevant, say so rather than guessing. Route durable new knowledge surfaced this turn through route_memory_writeback before finishing; ambiguous signals become Memory Inbox candidates."}}'
exit 0
`;
