#!/bin/bash
#
# check-privacy.sh — CLAUDE.md:550 enforcement.
#
# CLAUDE.md forbids the private OpenClaw fork name in public artifacts:
# CHANGELOG.md, README.md, docs/, skills/, PR titles + bodies, commit
# messages, and comments in checked-in code. This script greps for the
# banned name in either the staged index (for pre-commit hooks) or the
# working tree (for CI) and fails loudly if found.
#
# The allow-list below whitelists files where the name is legitimate
# — specifically, this script itself (where we reference the name to
# describe the rule) and upgrade guides that historically referenced
# the pre-rename fork name.
#
# Usage:
#   scripts/check-privacy.sh          # scan working tree
#   scripts/check-privacy.sh --staged # scan git staged index
#   scripts/check-privacy.sh --help
#
# Exit codes:
#   0  clean
#   1  banned name found (or --help printed)
#   2  git / grep not available

set -euo pipefail

BANNED_NAME='wintermute'
# v0.25.1 (codex T7): additional patterns from wintermute-specific filesystem
# layouts that would leak private fork context if they slipped through a port.
# `wintermute_only` already matches via the case-insensitive `wintermute` regex
# above; this list is for orthogonal patterns.
BANNED_PATHS=(
  '/data/brain/'
  '/data/.openclaw/'
)

usage() {
  cat <<EOF
scripts/check-privacy.sh — scan for the banned OpenClaw fork name.

USAGE:
  scripts/check-privacy.sh           Scan all tracked files in the working tree.
  scripts/check-privacy.sh --staged  Scan only files staged for commit.
  scripts/check-privacy.sh --help    Show this message.

The script greps for '${BANNED_NAME}' (case-insensitive) in:
  - CHANGELOG.md, README.md
  - docs/**
  - skills/**
  - src/**
  - test/**
  - scripts/**

Allow-list (references to the name are permitted):
  - scripts/check-privacy.sh itself
  - docs/UPGRADING_DOWNSTREAM_AGENTS.md (historical context for pre-rename upgrades)
  - .git/** (branch names, commit history — not checked in artifacts)

Exit codes: 0 clean, 1 banned name found, 2 setup error.
EOF
}

MODE=working
for arg in "$@"; do
  case "$arg" in
    --staged) MODE=staged ;;
    --help|-h) usage; exit 1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "check-privacy: git not found" >&2
  exit 2
fi

# Build the file list by scanning-mode.
if [ "$MODE" = staged ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
else
  FILES=$(git ls-files 2>/dev/null || true)
fi

if [ -z "$FILES" ]; then
  exit 0
fi

# Allow-list: files in which the banned name is legitimate.
# Meta-rule docs (define the rule itself), auto-generated LLM indexes,
# historical upgrade guides, and the test that enforces the rule
# against recipes/ all reference the banned name by necessity.
ALLOW_LIST=(
  'scripts/check-privacy.sh'
  'CLAUDE.md'
  'llms-full.txt'
  'docs/UPGRADING_DOWNSTREAM_AGENTS.md'
  'test/integrations.test.ts'
  # v0.25.1 (codex T7) BANNED_PATHS allow-list:
  # Historical docs, frozen migration files, test fixtures, and env-var
  # fallbacks where /data/brain/ or /data/.openclaw/ appears legitimately.
  # New skills/, src/, and tests must NOT slip onto this list — extend the
  # banned check above instead.
  'docs/GBRAIN_RECOMMENDED_SCHEMA.md'
  'docs/GBRAIN_V0.md'
  'docs/guides/minions-shell-jobs.md'
  'scripts/smoke-test.sh'
  'skills/migrations/v0.9.0.md'
  'skills/migrations/v0.14.0.md'
  'test/storage-status.test.ts'
  # CHANGELOG.md documents the rule (the v0.25.1 entry references the
  # banned literals in describing what's banned). Same exception status
  # as CLAUDE.md and this script itself: meta-documentation needs to
  # name the patterns it forbids.
  'CHANGELOG.md'
  # skills/migrations/v0.25.1.md is the agent-readable upgrade
  # walkthrough; it explains the privacy-guard extension to the
  # operating agent and references the banned literals while doing so.
  'skills/migrations/v0.25.1.md'
)

is_allowed() {
  local f="$1"
  for a in "${ALLOW_LIST[@]}"; do
    if [ "$f" = "$a" ]; then
      return 0
    fi
  done
  return 1
}

FOUND=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ ! -f "$file" ] && continue
  if is_allowed "$file"; then
    continue
  fi
  # Case-insensitive grep; only specific extensions + known docs.
  case "$file" in
    *.md|*.ts|*.mjs|*.js|*.py|*.sh|*.json|*.yaml|*.yml|*.txt|README*|CHANGELOG*|CLAUDE*|AGENTS*)
      if grep -in "$BANNED_NAME" "$file" >/dev/null 2>&1; then
        echo "[check-privacy] BANNED NAME in $file:" >&2
        grep -in "$BANNED_NAME" "$file" | sed 's|^|  |' >&2
        FOUND=1
      fi
      # Banned wintermute-specific filesystem paths (codex T7).
      for path in "${BANNED_PATHS[@]}"; do
        if grep -nF "$path" "$file" >/dev/null 2>&1; then
          echo "[check-privacy] BANNED PATH '$path' in $file:" >&2
          grep -nF "$path" "$file" | sed 's|^|  |' >&2
          FOUND=1
        fi
      done
      ;;
  esac
done <<< "$FILES"

if [ "$FOUND" -eq 1 ]; then
  echo "" >&2
  echo "The private OpenClaw fork name is banned in public artifacts." >&2
  echo "CLAUDE.md:550. Replace with 'your OpenClaw', 'OpenClaw reference deployment', or 'openclaw-reference'." >&2
  exit 1
fi

exit 0
