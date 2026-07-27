#!/usr/bin/env bash
# v0.41.13.0 — Privacy guard for test/fixtures/conversation-formats/.
#
# Per CLAUDE.md privacy rule: "Never reference real people, companies,
# funds, or private agent names in any public-facing artifact."
# Test fixtures ship in the repo; they ARE public.
#
# This script greps for known real-name signals and fails the build if
# any leak. Add to bun run verify so the gate runs every PR.
#
# Banned tokens (case-insensitive substring match):
#   - 'wintermute' / 'openclaw' (real downstream agent names)
#   - 'palantir' (real company per Garry's history)
#   - common real-fund names (sequoia, andreessen, founders fund, etc.)
#   - 'ycombinator' / 'y combinator' (the org running gbrain)
#
# Allowed (placeholder convention):
#   - alice-example / bob-example / charlie-example / diana-example
#   - widget-co / acme-example
#   - fund-a / fund-b / fund-c

set -euo pipefail

FIXTURE_DIR="test/fixtures/conversation-formats"

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "[check-fixture-privacy] $FIXTURE_DIR does not exist; nothing to check"
  exit 0
fi

# Real-name signals. Add to this list when new banned tokens surface.
BANNED_TOKENS=(
  "wintermute"
  "openclaw"
  "palantir"
  "sequoia"
  "andreessen"
  "founders fund"
  "founders\\.fund"
  "ycombinator"
  "y combinator"
  "garry tan"
  "garrytan"
)

errors=0
for token in "${BANNED_TOKENS[@]}"; do
  matches=$(grep -ril "$token" "$FIXTURE_DIR" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "[check-fixture-privacy] BANNED token '$token' found in:"
    echo "$matches" | sed 's/^/  - /'
    errors=$((errors + 1))
  fi
done

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "[check-fixture-privacy] FAIL: $errors banned token(s) found in fixtures."
  echo "[check-fixture-privacy] Fixtures must use placeholder names (alice-example, widget-co, fund-a, ...)."
  echo "[check-fixture-privacy] See CLAUDE.md \"Privacy rule\" section."
  exit 1
fi

echo "[check-fixture-privacy] OK: no banned tokens found in $FIXTURE_DIR"
