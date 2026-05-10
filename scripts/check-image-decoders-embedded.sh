#!/usr/bin/env bash
# CI guard: verify that bun --compile binaries can decode HEIC + AVIF.
#
# heic-decode bundles its libheif WASM as base64 inside libheif-bundle.js, which
# bun --compile preserves correctly out of the box. @jsquash/avif loads
# avif_dec.wasm via a path relative to its own JS file, which FAILS inside a
# compiled binary — the workaround is to pre-init the module with bytes loaded
# via `with { type: 'file' }`. This guard ensures both paths actually work in
# the compiled artifact, not just in dev mode.
#
# Mirrors scripts/check-wasm-embedded.sh from v0.19.0 (tree-sitter pattern).
#
# Wired into `bun run verify` (which `/ship` and `bun run test:full` call).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_BIN="$(mktemp /tmp/gbrain-img-decoders-check.XXXXXX)"
trap 'rm -f "$OUT_BIN"' EXIT

bun build --compile --outfile "$OUT_BIN" scripts/image-decoders-smoketest.ts >/dev/null 2>&1

OUTPUT="$("$OUT_BIN" 2>&1 || true)"

# The smoketest writes a JSON line on stdout. Look for ok=true on each decoder.
if ! echo "$OUTPUT" | grep -q '"heic":{"ok":true'; then
  echo "[check-image-decoders-embedded] FAIL: heic-decode failed in compiled binary." >&2
  echo "[check-image-decoders-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "Likely cause: libheif-bundle.js was upgraded to a non-bundle variant," >&2
  echo "or wasm-bundle.js stopped inlining the WASM as base64. Check the" >&2
  echo "heic-decode + libheif-js versions in package.json." >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"avif":{"ok":true'; then
  echo "[check-image-decoders-embedded] FAIL: @jsquash/avif failed in compiled binary." >&2
  echo "[check-image-decoders-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "Likely cause: the import attribute path for avif_dec.wasm changed in" >&2
  echo "@jsquash/avif, or initAvif() no longer accepts a WebAssembly.Module" >&2
  echo "directly. Check scripts/image-decoders-smoketest.ts for the WASM" >&2
  echo "pre-init pattern, then mirror it in src/core/import-file.ts." >&2
  exit 1
fi

# Final guard: top-level "ok":true.
if ! echo "$OUTPUT" | grep -q '"ok":true}$'; then
  echo "[check-image-decoders-embedded] FAIL: probe returned ok:false." >&2
  echo "$OUTPUT" >&2
  exit 1
fi

echo "[check-image-decoders-embedded] HEIC + AVIF decoders embed and decode correctly in compiled binary."
