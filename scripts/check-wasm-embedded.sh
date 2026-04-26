#!/usr/bin/env bash
# CI guard: verify that bun --compile binaries ship with embedded tree-sitter
# WASMs and produce real semantic chunks (not recursive-fallback chunks).
#
# This is the #1 silent-failure mode for v0.19.0 code indexing. If the WASM
# import attributes regress or the asset path drifts, the compiled binary
# silently falls through to the recursive text chunker. Users see no error,
# just degraded chunking quality. This script catches that regression.
#
# Fails the build when:
#   - bun build --compile fails
#   - The resulting binary can't parse TypeScript
#   - Chunks come back without real symbol names (fallback signature)
#
# Runs as part of `bun test` via the package.json pre-test pipeline.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_BIN="$(mktemp /tmp/gbrain-wasm-check.XXXXXX)"
trap 'rm -f "$OUT_BIN"' EXIT

# Build a minimal smoketest binary that imports the chunker. We compile this
# instead of the full gbrain CLI so the failure mode is laser-focused on
# chunker + WASM path resolution, not unrelated CLI wiring.
bun build --compile --outfile "$OUT_BIN" scripts/chunker-smoketest.ts >/dev/null 2>&1

# Run it and capture JSON output.
OUTPUT="$("$OUT_BIN" 2>&1)"

# Sanity: JSON parses and has expected shape.
# - has_symbol_names: at least one chunk carries a concrete symbol name
#   (proves tree-sitter AST extraction, not recursive-fallback chunks).
# - has_typescript_header: the structured header is emitted with the
#   correct language tag (proves the language map reached displayLang).
# - calculateScore by name: specific function that MUST appear as a
#   top-level semantic node. If it's missing, the chunker either fell
#   through to recursive or the TypeScript grammar didn't load.
if ! echo "$OUTPUT" | grep -q '"has_symbol_names": true'; then
  echo "[check-wasm-embedded] FAIL: compiled binary returned no symbol names (fallback chunks)." >&2
  echo "[check-wasm-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"has_typescript_header": true'; then
  echo "[check-wasm-embedded] FAIL: chunk header missing TypeScript language tag." >&2
  echo "[check-wasm-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"calculateScore"'; then
  echo "[check-wasm-embedded] FAIL: tree-sitter did not extract the calculateScore function symbol." >&2
  echo "[check-wasm-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

echo "[check-wasm-embedded] OK — compiled binary produced real semantic chunks."
