#!/usr/bin/env bash
# CI guard: fail if any new code emits \r-progress to stdout.
#
# Since v0.14.2, bulk-action progress lives on stderr via the shared
# src/core/progress.ts reporter. \r-rewriting on stdout breaks every
# piped-output scenario: agents that capture stdout for structured
# results see progress garbage mixed with the data, and CI logs show
# a single line per command because everything after the last \r
# is truncated by the terminal emulator when played back.
#
# This script greps for the anti-pattern. Legitimate uses of \r inside
# string literals (e.g. Windows line-ending normalization, regex
# patterns) are expected to contain \r without being preceded by
# `process.stdout.write`. We match the full write-call form only.
#
# Usage: scripts/check-progress-to-stdout.sh
# Exit:  0 when clean, 1 when a banned pattern is found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# The banned pattern: process.stdout.write('\r... or process.stdout.write("\r...
# Greedy quote character class so both quote styles match.
PATTERN="process\.stdout\.write\([\`'\"]\\\\r"

# Files allowed to use this pattern historically. Empty allowlist — the point
# of v0.14.2 was to remove every one of them. Add entries only if you really
# need a \r on stdout (if so, add the rationale as a comment at the call site
# and list the file here).
ALLOWLIST=()

matches=""
if command -v rg >/dev/null 2>&1; then
  matches="$(rg -n --no-heading "$PATTERN" src/ 2>/dev/null || true)"
else
  matches="$(grep -rEn "$PATTERN" src/ 2>/dev/null || true)"
fi

if [ -n "$matches" ]; then
  # Filter out allowlisted files.
  filtered="$matches"
  for f in "${ALLOWLIST[@]:-}"; do
    [ -z "$f" ] && continue
    filtered="$(echo "$filtered" | grep -v "^${f}:" || true)"
  done

  if [ -n "$filtered" ]; then
    echo "ERROR: found process.stdout.write('\\r…') pattern(s) in src/:"
    echo
    echo "$filtered"
    echo
    echo "Bulk-action progress must go through src/core/progress.ts"
    echo "(writes to stderr, handles TTY vs non-TTY, honors --quiet /"
    echo " --progress-json / --progress-interval). If you genuinely"
    echo "need a \\r on stdout, add the file to the ALLOWLIST at the"
    echo "top of this script and explain why at the call site."
    exit 1
  fi
fi

echo "check-progress-to-stdout: OK (no banned stdout \\r patterns)"
