#!/usr/bin/env bash
# Check that admin/src/lib/scope-constants.ts ALLOWED_SCOPES_LIST matches
# src/core/scope.ts ALLOWED_SCOPES_LIST. The admin SPA's tsconfig include
# scopes to admin/src/ so we can't import the source list directly; instead
# this script extracts both lists and diffs them.
#
# Wired into `bun run verify` and `bun run check:all`.
#
# Exits 0 on match, 1 on drift, 2 on internal error (file missing, parse fail).
#
# Usage:  scripts/check-admin-scope-drift.sh
set -euo pipefail

SRC=src/core/scope.ts
ADMIN=admin/src/lib/scope-constants.ts

[ -f "$SRC" ] || { echo "[check-admin-scope-drift] missing $SRC" >&2; exit 2; }
[ -f "$ADMIN" ] || { echo "[check-admin-scope-drift] missing $ADMIN" >&2; exit 2; }

# Extract the contents of ALLOWED_SCOPES_LIST = [...] from each file.
# The list spans multiple lines, terminated by ']'. awk pulls it cleanly.
extract_list() {
  awk '
    /ALLOWED_SCOPES_LIST/ && /\[/ { capture = 1 }
    capture {
      print
      if (/\]/) { capture = 0; exit }
    }
  ' "$1"
}

src_block=$(extract_list "$SRC")
admin_block=$(extract_list "$ADMIN")

if [ -z "$src_block" ]; then
  echo "[check-admin-scope-drift] could not find ALLOWED_SCOPES_LIST in $SRC" >&2
  exit 2
fi
if [ -z "$admin_block" ]; then
  echo "[check-admin-scope-drift] could not find ALLOWED_SCOPES_LIST in $ADMIN" >&2
  exit 2
fi

# Strip everything that isn't a quoted scope string and emit one per line.
strip_to_scopes() {
  printf '%s\n' "$1" \
    | tr ',' '\n' \
    | grep -oE "'[a-z_]+'" \
    | tr -d "'" \
    | sort -u
}

src_scopes=$(strip_to_scopes "$src_block")
admin_scopes=$(strip_to_scopes "$admin_block")

if [ "$src_scopes" != "$admin_scopes" ]; then
  echo "[check-admin-scope-drift] DRIFT detected between:" >&2
  echo "  $SRC" >&2
  echo "  $ADMIN" >&2
  echo "" >&2
  echo "src/core/scope.ts has:" >&2
  printf '  %s\n' $src_scopes >&2
  echo "" >&2
  echo "admin/src/lib/scope-constants.ts has:" >&2
  printf '  %s\n' $admin_scopes >&2
  echo "" >&2
  echo "Update admin/src/lib/scope-constants.ts to match, then 'cd admin && bun run build'." >&2
  exit 1
fi

echo "[check-admin-scope-drift] ok: $(echo "$src_scopes" | wc -l | tr -d ' ') scopes match"
