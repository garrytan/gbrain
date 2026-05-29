#!/usr/bin/env bash
# CI gate: src/admin-embedded.ts must match admin/dist/ contents.
#
# This protects against the v0.36.x #1090 bug class re-emerging — a PR
# that rebuilds admin/dist but forgets to regenerate src/admin-embedded.ts
# would silently break /admin on every fresh install of the compiled
# binary. The Vite build outputs hashed filenames, so a stale embedded
# manifest references nonexistent assets.
#
# How: re-run the generator, then `git diff --exit-code` on the output.
# Exits 0 when in sync, 1 when the generator produces different output
# than what's committed.
#
# Mirrors scripts/check-wasm-embedded.sh's pattern.

set -euo pipefail

cd "$(dirname "$0")/.."

resolve_bun() {
  for candidate in \
    "${BUN_BIN:-}" \
    "$(command -v bun 2>/dev/null || true)" \
    "$(command -v bun.exe 2>/dev/null || true)" \
    "$HOME/.bun/bin/bun" \
    "$HOME/.bun/bin/bun.exe" \
    "/mnt/c/Users/${USER:-}/.bun/bin/bun.exe" \
    "/mnt/c/Users/itzOn/.bun/bin/bun.exe"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [ ! -d admin/dist ]; then
  echo "[check:admin-embedded] no admin/dist (run \`cd admin && bun run build\` first); skipping"
  exit 0
fi

BUN_PATH="$(resolve_bun)" || {
  echo "[check:admin-embedded] bun not found; install Bun or set BUN_BIN=/path/to/bun." >&2
  exit 1
}

BEFORE="$(mktemp)"
trap 'rm -f "$BEFORE"' EXIT

if [ -f src/admin-embedded.ts ]; then
  cp src/admin-embedded.ts "$BEFORE"
else
  : > "$BEFORE"
fi

"$BUN_PATH" run scripts/build-admin-embedded.ts > /dev/null

if ! cmp -s "$BEFORE" src/admin-embedded.ts; then
  echo ""
  echo "[check:admin-embedded] src/admin-embedded.ts is out of sync with admin/dist/."
  echo "  Fix: bun run build:admin && bun run build:admin-embedded"
  echo "  Then re-commit the regenerated src/admin-embedded.ts."
  exit 1
fi

echo "[check:admin-embedded] OK"
