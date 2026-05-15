#!/usr/bin/env bash
# v0.32.2 CI guard: enforce the system-of-record invariant.
#
# The rule: user-knowledge writes to derived DB tables (facts, takes,
# links, timeline_entries) must go through the extract / reconcile /
# migration layer, never directly from arbitrary code paths. Direct
# calls would bypass the markdown source-of-truth contract — the next
# `gbrain rebuild` (v0.32.3) would lose the data because the fence
# wasn't updated.
#
# This script grep-bans the direct-write surface across src/ and
# scripts/ (NOT test/ — tests legitimately seed fixtures via direct
# inserts, per Codex R2-#8). A function-scoped allow-list lets the
# legitimate extract / reconcile / migration call sites pass: add
# `// gbrain-allow-direct-insert: <reason>` on the SAME LINE as the
# banned call. The grep parses the trailing comment.
#
# Usage: scripts/check-system-of-record.sh
# Exit:  0 when no violations, 1 when violations found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Banned direct-call patterns. Each is a method on BrainEngine that
# writes to a derived table. Pre-v0.32.2 callers used these freely;
# post-v0.32.2 every call site must either route through the
# reconcile layer OR carry an explicit allow-direct-insert comment.
PATTERNS=(
  'engine\.insertFact\('
  'engine\.insertFacts\('
  'engine\.addLink\('
  'engine\.addLinksBatch\('
  'engine\.addTimelineEntry\('
  'engine\.upsertTake\('
  'engine\.expireFact\('
)

# Build an OR-regex for one grep pass.
COMBINED=""
for p in "${PATTERNS[@]}"; do
  if [ -z "$COMBINED" ]; then
    COMBINED="$p"
  else
    COMBINED="$COMBINED|$p"
  fi
done

# Scan src/ and scripts/ only. test/ is deliberately excluded per Codex
# R2-#8: tests legitimately call these methods to seed fixtures, and
# gating tests would break the test surface without protecting any
# invariant.
SCOPE_DIRS=("src" "scripts")

# Collect violations. A violation is a line that:
#   1. Matches one of the banned patterns
#   2. Does NOT contain the `gbrain-allow-direct-insert:` comment
#   3. Is NOT a pure-comment line (JSDoc, line-comment, backtick mention)
# Comment-line exclusions stop the grep from false-positiving on
# docstrings/comments that mention the method names. The runtime
# regression coverage lives in the unit + E2E tests.
violations=$(
  for dir in "${SCOPE_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    grep -rEn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sh' \
      "$COMBINED" "$dir" 2>/dev/null || true
  done \
    | grep -vE 'gbrain-allow-direct-insert:' \
    | grep -vE ':[[:space:]]*\*[[:space:]]+' \
    | grep -vE ':[[:space:]]*//' \
    | grep -vE '`[^`]*\\.\w+\(' \
    || true
)

if [ -n "$violations" ]; then
  echo
  echo "ERROR: direct writes to derived tables found outside the reconcile layer."
  echo "       Every call to engine.insertFact / insertFacts / addLink /"
  echo "       addLinksBatch / addTimelineEntry / upsertTake / expireFact must"
  echo "       either route through the extract / cycle / migration path OR"
  echo "       carry an explicit \`// gbrain-allow-direct-insert: <reason>\`"
  echo "       comment on the SAME LINE. See docs/architecture/system-of-record.md."
  echo
  echo "Violations:"
  echo "$violations"
  echo
  exit 1
fi

echo "OK: no direct derived-table writes outside the reconcile layer in src/ + scripts/"
