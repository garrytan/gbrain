#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl --fail --location --silent --show-error \
  https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.23.3/tree-sitter-bash.wasm \
  -o "$WORK/tree-sitter-bash.wasm"
printf '%s  %s\n' \
  d1844429a58620f306b6f42aebe92298243ca8120cd833a3ab5d87c7a2e7b9fd \
  "$WORK/tree-sitter-bash.wasm" | shasum -a 256 --check
cp "$WORK/tree-sitter-bash.wasm" "$REPO_ROOT/src/assets/wasm/grammars/tree-sitter-bash.wasm"
