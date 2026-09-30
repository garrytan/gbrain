#!/usr/bin/env bash
# CI guard: fail if any SELECT projection on `pages` that feeds rowToPage()
# drops `source_id`. After v0.32.8, Page.source_id is required at the type
# level; a projection that omits the column makes rowToPage return a Page
# with source_id=undefined, which TypeScript's `: string` then lies about.
#
# This complements the type-system guard. The grep finds the specific 4-tuple
# shape (id, slug, type, title) without source_id — the exact pre-v0.32.8
# pattern that codex's plan review flagged.
#
# Usage: scripts/check-source-id-projection.sh
# Exit:  0 when no matches, 1 when matches found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree.
ROOT="${GBRAIN_GUARD_ROOT:-$ROOT}"
cd "$ROOT"

# Allowlist: SELECT shapes that legitimately don't need source_id (single-col
# `SELECT slug FROM pages` for getAllSlugs / resolveSlugs, SELECT id for
# subqueries, COUNT, etc.) These don't feed rowToPage.
#
# The shape that DOES feed rowToPage starts `SELECT id, ... slug, ... type, ... title`
# (in some order). The pattern below matches "id" + "slug" + "type" + "title"
# in a SELECT projection — that's the rowToPage feeder signature.

FOUND_BAD=0

# Word boundaries are spelled (^|[^A-Za-z0-9_])word([^A-Za-z0-9_]|$) because
# mawk (the default awk on Ubuntu CI runners) has no \b: with \b this guard
# matched nothing and was permanently green there. Recursive graph-walk seed
# rows (`... 0 as depth, ARRAY[p.id] as visited`) feed traversal results, not
# rowToPage, and are skipped.
#
# Use multiline-aware grep so the SELECT can span lines. pcre2grep would be
# cleaner but isn't universally available; do a simple two-pass instead:
# 1. Pull each SELECT-from-pages block.
# 2. For each, check if it has the rowToPage signature WITHOUT source_id.

check_file() {
  local file="$1"
  # Extract every SELECT...FROM pages block (across lines, up to 12 lines)
  # then test each.
  awk '
    /SELECT/ {
      buf = $0
      lines = 1
      while (lines < 12 && (!match(buf, /FROM[[:space:]]+pages([^A-Za-z0-9_]|$)/))) {
        if ((getline next_line) <= 0) break
        buf = buf " " next_line
        lines++
      }
      if (match(buf, /FROM[[:space:]]+pages([^A-Za-z0-9_]|$)/)) {
        # Has id, slug, type, title (rowToPage feeder) but NO source_id?
        if (match(buf, /(^|[^A-Za-z0-9_])id([^A-Za-z0-9_]|$)/) && match(buf, /(^|[^A-Za-z0-9_])slug([^A-Za-z0-9_]|$)/) && match(buf, /(^|[^A-Za-z0-9_])type([^A-Za-z0-9_]|$)/) && match(buf, /(^|[^A-Za-z0-9_])title([^A-Za-z0-9_]|$)/) && !match(buf, /(^|[^A-Za-z0-9_])source_id([^A-Za-z0-9_]|$)/) && !match(buf, /[Aa][Ss] visited/)) {
          print FILENAME ": SELECT projection missing source_id:"
          print "  " buf
          exit 1
        }
      }
    }
  ' "$file" || return 1
  return 0
}

EXIT=0

# The engine surface = the two façade files plus every method module peeled
# into their sibling dirs, plus the shared engine SQL (refactor wave 1,
# src/core/engine-sql/) — SQL moved out of the façades must stay scanned.
ENGINE_FILES=()
for f in src/core/postgres-engine.ts src/core/pglite-engine.ts; do
  [ -f "$f" ] && ENGINE_FILES+=("$f")
done
for d in src/core/postgres-engine src/core/pglite-engine src/core/engine-sql; do
  if [ -d "$d" ]; then
    while IFS= read -r ef; do ENGINE_FILES+=("$ef"); done < <(find "$d" -name '*.ts' | sort)
  fi
done

if [ "${#ENGINE_FILES[@]}" -eq 0 ]; then
  echo "ERROR: no engine files found under $ROOT"
  exit 1
fi

for f in "${ENGINE_FILES[@]}"; do
  if ! check_file "$f"; then
    EXIT=1
  fi
done

# Also check RETURNING clauses (putPage uses INSERT ... RETURNING).
# Same shape: returns a row that feeds rowToPage.
for f in "${ENGINE_FILES[@]}"; do
  awk '
    /RETURNING/ {
      buf = $0
      lines = 1
      while (lines < 6 && !match(buf, /\`/)) {
        if ((getline next_line) <= 0) break
        buf = buf " " next_line
        lines++
      }
      if (match(buf, /(^|[^A-Za-z0-9_])id([^A-Za-z0-9_]|$)/) && match(buf, /(^|[^A-Za-z0-9_])slug([^A-Za-z0-9_]|$)/) && match(buf, /(^|[^A-Za-z0-9_])type([^A-Za-z0-9_]|$)/) && match(buf, /(^|[^A-Za-z0-9_])title([^A-Za-z0-9_]|$)/) && !match(buf, /(^|[^A-Za-z0-9_])source_id([^A-Za-z0-9_]|$)/)) {
        print FILENAME ": RETURNING projection missing source_id:"
        print "  " buf
        exit 1
      }
    }
  ' "$f" || EXIT=1
done

if [ "$EXIT" = 1 ]; then
  echo
  echo "ERROR: SELECT/RETURNING projection on \`pages\` is missing source_id."
  echo "       After v0.32.8, Page.source_id is required at the type level."
  echo "       Add \`source_id\` to the projection or rowToPage will lie."
  echo "       See ~/.claude/plans/gleaming-soaring-mccarthy.md F2 finding."
  exit 1
fi

echo "OK: all rowToPage feeder projections include source_id"
