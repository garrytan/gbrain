#!/usr/bin/env bash
# v0.41.13.0 — Privacy guard for committed fixtures, eval corpora and audit
# evidence: test/fixtures/conversation-formats/, test/fixtures/transcripts/,
# evals/, docs/test-audit/ and skills/.
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
#
# evals/ and docs/test-audit/ are scanned with the real-entity tokens only:
# the product and repository names (openclaw, garrytan/gbrain) are
# legitimate there. evals/ carries generated corpora and qrels, where a real
# person's brain-page slug once shipped in a public repo; docs/test-audit/
# carries audit evidence that quotes eval data. skills/ ships in every
# install and once carried a real downstream agent's name in
# skillpack-harvest's SKILL.md and routing evals; it may name the product
# (OpenClaw) but not real people, companies, funds or private agents.
#
# Seam: GBRAIN_GUARD_ROOT (fixture tree root, used by scripts/guard-self-test.sh).

set -euo pipefail

cd "${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# cathedral-4: the transcripts-import fixtures (raw harness/export shapes)
# carry the same placeholder-names-only contract as conversation-formats.
FIXTURE_DIRS=("test/fixtures/conversation-formats" "test/fixtures/transcripts")
# Single-file fixtures under the same contract. The LongMemEval mixed-case
# fixture mirrors the public dataset's ID SHAPE (sharegpt_yywfIrx_0-style)
# but every session body is hand-written placeholder text.
FIXTURE_FILES=("test/fixtures/longmemeval-mixedcase.jsonl")

EXISTING_DIRS=()
for d in "${FIXTURE_DIRS[@]}"; do
  [ -d "$d" ] && EXISTING_DIRS+=("$d")
done
for f in "${FIXTURE_FILES[@]}"; do
  [ -f "$f" ] && EXISTING_DIRS+=("$f")
done
# Eval corpora, audit evidence and bundled skills: real-entity tokens only (see header).
SCOPED_DIRS=("evals" "docs/test-audit" "skills")
EXISTING_SCOPED=()
for d in "${SCOPED_DIRS[@]}"; do
  [ -d "$d" ] && EXISTING_SCOPED+=("$d")
done
if [ ${#EXISTING_DIRS[@]} -eq 0 ] && [ ${#EXISTING_SCOPED[@]} -eq 0 ]; then
  echo "[check-fixture-privacy] no fixture dirs exist; nothing to check"
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
  "garry-tan"
  "garrytan"
)
# Real people, companies and funds (no product or repository names).
REAL_ENTITY_TOKENS=(
  "wintermute"
  "palantir"
  "sequoia"
  "andreessen"
  "founders fund"
  "founders\\.fund"
  "ycombinator"
  "y combinator"
  "garry tan"
  "garry-tan"
)

errors=0
scan() {
  local token="$1"; shift
  [ "$#" -gt 0 ] || return 0
  local matches
  matches=$(grep -ril -- "$token" "$@" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "[check-fixture-privacy] BANNED token '$token' found in:"
    echo "$matches" | sed 's/^/  - /'
    errors=$((errors + 1))
  fi
}
for token in "${BANNED_TOKENS[@]}"; do
  scan "$token" ${EXISTING_DIRS[@]+"${EXISTING_DIRS[@]}"}
done
for token in "${REAL_ENTITY_TOKENS[@]}"; do
  scan "$token" ${EXISTING_SCOPED[@]+"${EXISTING_SCOPED[@]}"}
done

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "[check-fixture-privacy] FAIL: $errors banned token(s) found in fixtures, eval corpora or audit evidence."
  echo "Why: these files are public; CLAUDE.md's privacy rule forbids real people, companies and funds in them."
  echo "Fix: replace each match with a placeholder (alice-example, acme-example, widget-co, fund-a) or delete the file, then re-run: bun run check:fixture-privacy"
  echo "Docs: CLAUDE.md (Privacy rule)"
  exit 1
fi

echo "[check-fixture-privacy] OK: no banned tokens found in ${EXISTING_DIRS[*]-} ${EXISTING_SCOPED[*]-}"
