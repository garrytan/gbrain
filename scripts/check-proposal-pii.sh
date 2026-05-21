#!/bin/bash
#
# check-proposal-pii.sh — privacy guard for `docs/proposals/*.md`.
#
# Sibling to check-privacy.sh: that script bans the `Wintermute` literal
# everywhere. This one focuses on `docs/proposals/*.md` and the OTHER PII
# classes that have surfaced in past RFC drafts — personal-relationship
# vocabulary, private repo references, etc.
#
# Why two scripts: the patterns this lint flags would be too noisy if
# applied repo-wide (e.g. a test fixture mentioning "trial" is fine).
# Restricting to `docs/proposals/` keeps the lint surgical — proposals are
# public-facing RFC documents that should never contain personal context,
# so the false-positive rate is near zero.
#
# Design note: the denylist names PATTERNS, not real people. Specific
# real names (deceased relatives, therapist names, dealflow contacts)
# would leak PII into the repo just by appearing in this script's
# denylist. The structural patterns below catch the SURROUNDING context
# of personal-event prose. The trade-off: a future RFC that names a real
# person without any of the contextual markers won't be caught — that's
# accepted as a residual risk handled by human review.
#
# Usage:
#   scripts/check-proposal-pii.sh           # scan working tree
#   scripts/check-proposal-pii.sh --staged  # scan git staged index
#   scripts/check-proposal-pii.sh --help
#
# Exit codes:
#   0  clean
#   1  PII pattern found
#   2  setup error

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PROPOSALS_DIR="$REPO_ROOT/docs/proposals"

# Structural patterns. One per line. Matched case-insensitively, fixed-string
# (no regex). Comments start with #. Blank lines OK.
#
# IMPORTANT — design contract: this list MUST NOT contain real personal
# names (deceased relatives, therapist first names, dealflow contacts).
# Naming those would leak PII into scripts/. The patterns below catch the
# SURROUNDING VOCABULARY that always accompanies such content in personal
# RFC prose. Maintainers extending this list: prefer adding a phrase that
# captures the context (e.g. `couples session`) rather than a specific
# person's name.
read -r -d '' PATTERNS <<'EOF' || true
# Private repo references (zero false-positive risk)
garrytan/brain

# Personal relationship vocabulary (extremely unlikely in technical RFCs)
trial separation
permanent separation
couples session
couples therapist
divorce attorney
divorce attorneys

# Death/funeral vocabulary in personal contexts (combined phrases — bare
# "funeral" alone would false-positive in legitimate metaphorical use)
grandmother's funeral
grandmother funeral
aunt's funeral
aunt funeral

# Private agent / fork name (also enforced repo-wide by check-privacy.sh
# but listed here for proposal-scoped clarity)
wintermute
EOF

usage() {
  cat <<EOF
scripts/check-proposal-pii.sh — privacy guard for docs/proposals/*.md.

USAGE:
  scripts/check-proposal-pii.sh           Scan all proposal files.
  scripts/check-proposal-pii.sh --staged  Scan only staged proposal files.
  scripts/check-proposal-pii.sh --help    Show this message.

Flags personal-context vocabulary (e.g. "trial separation", "couples
session", private repo references) inside docs/proposals/*.md. Use
generic placeholders (alice-example, acme-corp, fund-a) in proposals.
See CLAUDE.md "Privacy rule: scrub real names from public docs" for
the canonical name-mapping table.

Sibling to scripts/check-privacy.sh which enforces the "Wintermute"
ban repo-wide; this script catches the broader PII classes that
appeared in past RFC drafts and were corrected at landing time.

Exit codes: 0 clean, 1 pattern found, 2 setup error.
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

if [ ! -d "$PROPOSALS_DIR" ]; then
  # No proposals dir yet — nothing to lint. Not a failure.
  exit 0
fi

# Build the file list. Staged mode filters git's staged set down to
# docs/proposals/*.md; working mode globs the directory directly.
if [ "$MODE" = staged ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "check-proposal-pii: git not found" >&2
    exit 2
  fi
  FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null \
    | grep -E '^docs/proposals/.+\.md$' || true)
else
  FILES=$(find "$PROPOSALS_DIR" -maxdepth 1 -type f -name '*.md' 2>/dev/null \
    | sed "s|^$REPO_ROOT/||")
fi

if [ -z "$FILES" ]; then
  exit 0
fi

FOUND=0
# Iterate patterns; for each non-comment line, scan the file list.
while IFS= read -r raw_line; do
  # Strip leading/trailing whitespace.
  pat="${raw_line#"${raw_line%%[![:space:]]*}"}"
  pat="${pat%"${pat##*[![:space:]]}"}"
  # Skip empty and comment lines.
  [ -z "$pat" ] && continue
  case "$pat" in '#'*) continue ;; esac

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    full="$REPO_ROOT/$file"
    [ ! -f "$full" ] && continue
    # Fixed-string (-F), case-insensitive (-i), with line numbers (-n).
    if matches=$(grep -nFi -- "$pat" "$full" 2>/dev/null); then
      if [ -n "$matches" ]; then
        echo "[check-proposal-pii] PII pattern in $file:" >&2
        echo "  pattern: $pat" >&2
        echo "$matches" | sed 's|^|    |' >&2
        FOUND=$((FOUND + 1))
      fi
    fi
  done <<< "$FILES"
done <<< "$PATTERNS"

if [ "$FOUND" -gt 0 ]; then
  echo "" >&2
  echo "[check-proposal-pii] $FOUND PII pattern hit(s) in docs/proposals/*.md." >&2
  echo "[check-proposal-pii] See CLAUDE.md 'Privacy rule: scrub real names from public docs'." >&2
  echo "[check-proposal-pii] Use generic placeholders: alice-example, acme-corp, fund-a, etc." >&2
  exit 1
fi

exit 0
