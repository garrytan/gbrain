#!/usr/bin/env bash
# CI guard: scan agent-voice shipped surface for privacy leaks.
#
# Catches three classes of leak:
#   1. SHAPE regex: phone, email, SSN, JWT, bearer token, Luhn-valid credit card.
#      Mirrors the patterns in src/core/eval-capture-scrub.ts.
#   2. PATH patterns: hardcoded private filesystem prefixes (e.g. private agent home dirs).
#   3. OPERATOR blocklist: pipe-separated word list from $AGENT_VOICE_PII_BLOCKLIST.
#      Operator/CI sets this to ban specific private names without committing them
#      to a public file. See recipes/agent-voice/code/lib/personas/private-name-blocklist.json
#      for the contract.
#
# Exit 0 on no matches; exit 1 on any match. Wired into `bun run verify`.
#
# Test fixtures under recipes/agent-voice/tests/fixtures/scrub-{dirty,clean}.txt are
# the deliberate dirty inputs used by test/check-no-pii.test.ts. They contain the
# token FORBIDDEN_PLACEHOLDER_NAME_1 (NOT real names) and the test sets
# AGENT_VOICE_PII_BLOCKLIST=FORBIDDEN_PLACEHOLDER_NAME_1 to verify the mechanism.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

SCAN_PATHS=(
  "recipes/agent-voice"
  "recipes/agent-voice.md"
  "scripts/import-from-upstream.sh"
  "scripts/upstream-scrub-table.txt"
)

# Exception list: files the guard deliberately skips. These are test fixtures that
# carry placeholder tokens to exercise the guard's own behavior.
EXCEPTION_PATHS=(
  "recipes/agent-voice/tests/fixtures/scrub-dirty.txt"
  "recipes/agent-voice/tests/fixtures/scrub-clean.txt"
)

# Build a single grep --exclude argument list from EXCEPTION_PATHS.
EXCLUDES=()
for p in "${EXCEPTION_PATHS[@]}"; do
  EXCLUDES+=("--exclude=$(basename "$p")")
done

# SHAPE regex — keep in sync with src/core/eval-capture-scrub.ts. Each pattern
# is wrapped in (?: ... ) so we can OR them into one combined regex.
# Note: we use grep -E (POSIX ERE), which doesn't support lookbehind. The
# patterns here are slightly looser than the JS RegExps in eval-capture-scrub.ts
# because lookbehind is unavailable; that loosening errs on the side of catching
# more, which is the safer failure mode for a privacy guard.
PHONE='(\+[0-9]{1,3}[ .-]?)?(\([0-9]{3}\)[ ]?|[0-9]{3}[ .-])[0-9]{3}[ .-]?[0-9]{4}'
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
SSN='[0-9]{3}-[0-9]{2}-[0-9]{4}'
JWT='\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b'
BEARER='([Bb]earer)[ ]+[A-Za-z0-9._~+/-]{10,}=*'
# Credit card: 13-19 digits with optional space/dash separators. Luhn check NOT
# implemented in this guard (the grep is shape-only). False positives expected
# on long numeric sequences; treat as "investigate, this is privacy-shaped."
CC='([0-9][ -]?){12,18}[0-9]'

# PATH patterns — hardcoded private filesystem prefixes. Add new ones here as
# new private deployment patterns emerge.
PATH_PATTERNS='(/data/\.openclaw/|/private/[a-z0-9_-]+/workspace/)'

# Combine SHAPE + PATH into one ERE.
COMBINED_REGEX="($PHONE)|($EMAIL)|($SSN)|($JWT)|($BEARER)|($CC)|($PATH_PATTERNS)"

# Track any failure across the script.
FAILED=0

scan_pattern() {
  local label="$1"
  local pattern="$2"
  local hits
  # -r recursive, -E extended regex, -n line numbers, -I skip binary files.
  # ${SCAN_PATHS[@]} is intentionally unquoted (we want word-splitting for
  # path-list expansion). Existing-path filter via test -e.
  local existing=()
  for p in "${SCAN_PATHS[@]}"; do
    if [ -e "$p" ]; then existing+=("$p"); fi
  done
  if [ ${#existing[@]} -eq 0 ]; then
    return 0
  fi
  if hits=$(grep -rEnI "${EXCLUDES[@]}" "$pattern" "${existing[@]}" 2>/dev/null); then
    echo
    echo "ERROR: $label leak detected in agent-voice surface:"
    echo "$hits"
    FAILED=1
  fi
}

scan_pattern "shape/path PII" "$COMBINED_REGEX"

# Operator blocklist via env var. If set, run a second scan.
if [ -n "${AGENT_VOICE_PII_BLOCKLIST:-}" ]; then
  # The env var is pipe-separated. Build a case-insensitive grep -E pattern.
  # \b word boundaries to avoid matching substrings ("garrison" matching inside
  # a longer benign word).
  OPERATOR_PATTERN="\\b(${AGENT_VOICE_PII_BLOCKLIST})\\b"
  scan_pattern "operator blocklist match" "$OPERATOR_PATTERN"
else
  echo "WARN: AGENT_VOICE_PII_BLOCKLIST env var is unset; running shape-only PII scan." >&2
  echo "      For full enforcement, set the env var to a pipe-separated word list." >&2
  echo "      See recipes/agent-voice/code/lib/personas/private-name-blocklist.json." >&2
fi

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "FAIL: agent-voice privacy guard found leaks. Scrub before commit."
  exit 1
fi

echo "OK: agent-voice surface is clean (shape + path + operator blocklist)"
