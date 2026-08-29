#!/usr/bin/env bash
# Rebuild src/assets/wasm/grammars/tree-sitter-dart.wasm at tree-sitter ABI 14.
#
# Why this script exists and the other 35 grammars have none: every other
# grammar is vendored from the `tree-sitter-wasms` npm package, whose Dart build
# is ABI 15. web-tree-sitter is pinned at 0.22.6, which accepts 13-14 only, so
# that artifact loads and then throws at setLanguage — see #3356. Bumping the
# runtime instead is not a one-line change: the 0.26 loader rejects the whole
# vendored grammar set with a dylink metadata error, so it would require
# rebuilding all 36 at once.
#
# The fix keeps the runtime pinned and regenerates the SAME upstream grammar
# with `--abi 14`. Verified against 214 real Dart files (Flutter app + package):
# 0 parse errors, where the npm-published tree-sitter-dart@1.0.0 — an older
# grammar that predates Dart 3 — produced 760 across 79 files (`library;`,
# `abstract interface class`, switch expressions).
#
# Requires: git, npm, and podman or docker. Emits the wasm on stdout's last line.
set -euo pipefail

GRAMMAR_REPO="${GRAMMAR_REPO:-https://github.com/UserNobody14/tree-sitter-dart}"
# Pin the grammar commit so the artifact is reproducible; bump deliberately.
GRAMMAR_REF="${GRAMMAR_REF:-be07cf7}"
TS_CLI="${TS_CLI:-tree-sitter-cli@0.24.7}"
EMSDK_IMAGE="${EMSDK_IMAGE:-docker.io/emscripten/emsdk:3.1.64}"
ABI="${ABI:-14}"

RUNNER="$(command -v podman || command -v docker)"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/assets/wasm/grammars"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet "$GRAMMAR_REPO" "$WORK/dart"
git -C "$WORK/dart" checkout --quiet "$GRAMMAR_REF"

# Generate on the HOST, not in the container: the emsdk image is amd64 and
# npm segfaults under qemu on an arm64 host.
( cd "$WORK/dart" && npm install --silent --no-audit --no-fund "$TS_CLI" \
  && ./node_modules/.bin/tree-sitter generate --abi "$ABI" )

grep -q "#define LANGUAGE_VERSION $ABI" "$WORK/dart/src/parser.c" \
  || { echo "generate did not emit ABI $ABI" >&2; exit 1; }

"$RUNNER" run --rm -v "$WORK/dart":/g:z -w /g "$EMSDK_IMAGE" \
  emcc -Os -fno-exceptions -fvisibility=hidden \
    -s WASM=1 -s SIDE_MODULE=2 -s TOTAL_MEMORY=33554432 -s NODEJS_CATCH_EXIT=0 \
    -s EXPORTED_FUNCTIONS='["_tree_sitter_dart"]' \
    -I src -o tree-sitter-dart.wasm src/parser.c src/scanner.c

cp "$WORK/dart/tree-sitter-dart.wasm" "$OUT_DIR/tree-sitter-dart.wasm"
echo "$OUT_DIR/tree-sitter-dart.wasm"
