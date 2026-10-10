#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# tree-sitter-grammars/tree-sitter-lua v0.3.0: the newest release built at language ABI 14,
# which the pinned web-tree-sitter@0.22.6 runtime accepts (v0.4.0 and later are ABI 15).
curl --fail --location --silent --show-error \
  https://github.com/tree-sitter-grammars/tree-sitter-lua/releases/download/v0.3.0/tree-sitter-lua.wasm \
  -o "$WORK/tree-sitter-lua.wasm"
printf '%s  %s\n' \
  8fe0afe3238dad43a1dd541ba3024c28d3cd23466b031fe0a39d8f9d7e81ee0d \
  "$WORK/tree-sitter-lua.wasm" | shasum -a 256 --check
cp "$WORK/tree-sitter-lua.wasm" "$REPO_ROOT/src/assets/wasm/grammars/tree-sitter-lua.wasm"
