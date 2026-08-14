#!/usr/bin/env bash
# E6 — CI guard for docs/TOOL_CATALOG.md freshness.
#
# Mirrors scripts/check-eval-glossary-fresh.sh: regenerate the doc into a tmp
# file, diff against the committed version, fail the build if they drift.
# The renderer is config-independent + deterministic (no timestamps), so a
# diff means someone changed operations/surface metadata without running the
# generator.
#
# Run: bash scripts/check-tool-catalog-fresh.sh
# Wired into `bun run verify` via package.json `check:tool-catalog`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMITTED="$REPO_ROOT/docs/TOOL_CATALOG.md"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$COMMITTED" ]; then
  echo "ERROR: $COMMITTED not found." >&2
  echo "Run: bun run scripts/generate-tool-catalog.ts" >&2
  exit 1
fi

cd "$REPO_ROOT"
bun -e "import { renderToolCatalogMarkdown } from './src/mcp/tool-catalog.ts'; process.stdout.write(renderToolCatalogMarkdown() + '\n');" > "$TMP"

if ! diff -q "$COMMITTED" "$TMP" >/dev/null 2>&1; then
  echo "ERROR: docs/TOOL_CATALOG.md is stale." >&2
  echo "" >&2
  echo "Diff between committed and freshly-generated:" >&2
  echo "" >&2
  diff -u "$COMMITTED" "$TMP" >&2 || true
  echo "" >&2
  echo "To regenerate: bun run scripts/generate-tool-catalog.ts" >&2
  exit 1
fi

echo "✓ docs/TOOL_CATALOG.md is fresh"
