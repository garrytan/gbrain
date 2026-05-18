#!/usr/bin/env bash
# CI guard: fail if any test fixture references a real person's name.
#
# CLAUDE.md's "Privacy rule" section is unambiguous: never reference real
# people, companies, funds, or private agent names in any public-facing
# artifact. Tests are checked-in code distributed with every release and
# indexed by GitHub search. This guard catches the patterns the rule names.
#
# Design (post-Codex F4 review):
#   - Banned names: exact-string allowlist of known real identifiers. Adding
#     a name when CLAUDE.md flags one is a one-line edit.
#   - Banned emails: specific addresses that identify real contacts. NOT a
#     broad corporate-email regex — those would catch legitimate fixture
#     domains in billing/auth tests (`customer@stripe.com` etc.).
#   - Allowlist: exact "file:offending-string" pairs that are intentional
#     and pre-existing (e.g., the user's own email is not a "contact").
#
# Scope: test/**/*.test.ts only. Historical CHANGELOG entries, doc examples,
# and skill READMEs each have their own scrub status and are out of scope
# for this guard.
#
# Usage: scripts/check-test-real-names.sh
# Exit:  0 clean, 1 banned reference found, 2 setup error (rg + grep missing).

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Banned real-name strings (matched as whole words, case-insensitive).
# Add an entry when CLAUDE.md flags a new real-person name.
BANNED_NAMES=(
  'Diana'           # Diana Hu, named in CLAUDE.md privacy example
  'Wintermute'      # private OpenClaw fork name (CLAUDE.md rule)
  'Hermes'          # downstream agent fork name
  'Technium'        # real GP handle
  'McGrew'          # ex-OpenAI exec
  'YC Labs'         # internal team name
)

# Banned specific email addresses. NOT a generic corporate-email regex —
# those would catch legitimate fixture domains in billing/auth tests
# (`customer@stripe.com`, `account@openai.com` etc).
BANNED_EMAILS=(
  'diana@ycombinator.com'
)

# Exact "file:offending-string" pairs that are intentional and pre-existing.
# These pre-date the rule, the file's own author confirmed the use, the
# string identifies the user themselves (not a contact), OR the reference
# is structural (e.g., a regression test that ASSERTS the banned name does
# NOT appear in production code — the name MUST be in the test file as a
# literal).
ALLOWLIST=(
  "test/writer.test.ts:garry@ycombinator.com"          # user's own email — CLAUDE.md rule does not apply
  "test/integrations.test.ts:Wintermute"               # regex pattern in personal-info filter test (structural)
  "test/recency-decay.test.ts:Wintermute"              # regression-prevention test asserting wintermute is absent (structural)
  "test/scripts/check-proposal-pii.test.ts:Wintermute" # privacy-guard test asserting docs/proposals/ rejects wintermute (structural; same meta-rule exception as check-privacy.sh)
  "test/scripts/check-proposal-pii.test.ts:WINTERMUTE" # case-insensitive sentinel literal for the same privacy-guard test
  "test/serve-stdio-lifecycle.test.ts:Hermes"          # comment naming a downstream-agent scenario — pre-existing, low signal
  "test/extract.test.ts:Hermes"                        # markdown-link extraction test fixture — pre-existing, ambiguous (Greek god vs fork)
  # v0.36.0.0: skillpack-harvest privacy linter tests structurally
  # require the literal "Wintermute" to verify the linter catches it.
  # Same meta-rule exception as integrations.test.ts and the proposal-pii
  # privacy guard test above.
  "test/skillpack-harvest.test.ts:Wintermute"
  "test/skillpack-harvest-lint.test.ts:Wintermute"
  "test/e2e/skillpack-flow.test.ts:Wintermute"
)

# Build the combined regex. Names matched as whole words (\b), emails matched
# literally with dot escapes.
PATTERN_PARTS=()
for n in "${BANNED_NAMES[@]}"; do
  # Escape any regex metacharacters in the name (defensive — most are bare
  # words but YC Labs has a space).
  escaped="${n//./\\.}"
  escaped="${escaped// /\\s}"
  PATTERN_PARTS+=("\\b${escaped}\\b")
done
for e in "${BANNED_EMAILS[@]}"; do
  escaped="${e//./\\.}"
  PATTERN_PARTS+=("${escaped}")
done

# Join with |.
IFS='|' eval 'PATTERN="${PATTERN_PARTS[*]}"'

# Find tool.
if command -v rg >/dev/null 2>&1; then
  matches="$(rg -niH --no-heading -t ts "$PATTERN" test/ 2>/dev/null || true)"
elif command -v grep >/dev/null 2>&1; then
  matches="$(grep -rniE --include='*.test.ts' "$PATTERN" test/ 2>/dev/null || true)"
else
  echo "check-test-real-names: ERROR: neither rg nor grep available." >&2
  exit 2
fi

if [ -z "$matches" ]; then
  exit 0
fi

# Apply allowlist. Each line is "file:lineno:content"; check whether
# "file:<needle>" appears in ALLOWLIST for any needle in BANNED_EMAILS+NAMES
# that matches the content.
filtered=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # Extract filename and content (everything after second :).
  file="${line%%:*}"
  rest="${line#*:}"
  # rest is "lineno:content" — strip lineno.
  content="${rest#*:}"

  matched_needle=""
  for needle in "${BANNED_EMAILS[@]}" "${BANNED_NAMES[@]}"; do
    if echo "$content" | grep -qi -- "$needle"; then
      matched_needle="$needle"
      break
    fi
  done

  allow_key="${file}:${matched_needle}"
  allowed=0
  for allow_entry in "${ALLOWLIST[@]}"; do
    if [ "$allow_entry" = "$allow_key" ]; then
      allowed=1
      break
    fi
  done

  if [ "$allowed" = "0" ]; then
    filtered+="${line}"$'\n'
  fi
done <<< "$matches"

if [ -z "$filtered" ]; then
  exit 0
fi

echo "check-test-real-names: banned real-name references found in test/ fixtures." >&2
echo "" >&2
echo "$filtered" >&2
echo "" >&2
echo "Fix: replace with canonical placeholders per CLAUDE.md 'Name mapping' table." >&2
echo "  alice-example / @alice-example      for people" >&2
echo "  bob-example / charlie-example       for additional people" >&2
echo "  alice@example.com                   for emails (example.com is RFC 6761 reserved)" >&2
echo "  acme-example / widget-co            for companies" >&2
echo "  fund-a / fund-b                     for funds" >&2
echo "  a-team / agent-fork                 for teams / OpenClaw forks" >&2
echo "" >&2
echo "If the match is intentional (e.g., the user's own identifier, not a contact)," >&2
echo "add an exact 'file:string' entry to ALLOWLIST in scripts/check-test-real-names.sh." >&2
exit 1
