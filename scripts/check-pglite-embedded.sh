#!/usr/bin/env bash
# CI guard: verify that a `bun build --compile` binary can actually serve a
# PGLite brain — i.e. that PGLite's runtime payload (pglite.wasm, initdb.wasm,
# pglite.data, vector.tar.gz, pg_trgm.tar.gz) is embedded and reachable inside
# the compiled binary's read-only vfs (`/$bunfs/root`).
#
# This is the Bun-vfs #1340 failure mode: `bun build --compile` bundles our JS
# but does NOT embed PGLite's assets, so a compiled `gbrain serve`/`init` on a
# PGLite brain used to die with a bunfs ENOENT. src/core/pglite-embedded-assets.ts
# embeds them via `with { type: 'file' }` and feeds them to PGLite via
# PGliteOptions. If that regresses (asset path drifts, option names change, the
# extension bundlePath stops pointing at a materialized file), a compiled binary
# silently stops opening PGLite brains. This guard catches that.
#
# Fails the build when:
#   - bun build --compile fails
#   - the resulting binary cannot boot a real PGLiteEngine on a persistent dir
#   - the seeded page doesn't round-trip back out of the query
#
# Mirrors scripts/check-wasm-embedded.sh (tree-sitter WASM pattern, v0.19.0).
# Wired into `bun run verify` (CHECKS array) and package.json `check:pglite-embedded`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Build from a container-local copy under /tmp. On Docker Desktop, Bun
# canonicalizes a bind-mounted input to /run/host_virtiofs but keeps /app as the
# output path; its final atomic rename then fails with ENOENT even though both
# names refer to the same mount. Keeping inputs and output under /tmp avoids that
# alias (same rationale as check-wasm-embedded.sh).
BUILD_DIR="$(mktemp -d /tmp/gbrain-pglite-check.XXXXXX)"
OUT_BIN="$BUILD_DIR/pglite-embedded-smoketest"
GBRAIN_HOME_DIR="$BUILD_DIR/home"
trap 'rm -rf "$BUILD_DIR"' EXIT
mkdir -p "$BUILD_DIR/scripts" "$GBRAIN_HOME_DIR"
cp -R "$REPO_ROOT/src" "$BUILD_DIR/src"
cp "$REPO_ROOT/scripts/pglite-embedded-smoketest.ts" "$BUILD_DIR/scripts/pglite-embedded-smoketest.ts"
ln -s "$REPO_ROOT/node_modules" "$BUILD_DIR/node_modules"

# Compile a focused smoketest (imports PGLiteEngine, not the whole CLI) so the
# failure mode is laser-focused on PGLite asset embedding, not unrelated wiring.
if ! (cd "$BUILD_DIR" && bun build --compile --outfile "$OUT_BIN" scripts/pglite-embedded-smoketest.ts >"$BUILD_DIR/compile.log" 2>&1); then
  # In some sandboxes `bun build --compile` is unavailable (no network for the
  # baseline download, seccomp, etc). Fail SOFT there — like the compiled-binary
  # e2e — so local dev without compile support isn't blocked. CI has compile.
  if grep -qiE 'not (found|available)|permission denied|Could not download|ETIMEDOUT|network' "$BUILD_DIR/compile.log"; then
    echo "[check-pglite-embedded] SKIP: bun build --compile unavailable in this sandbox." >&2
    sed -n '1,20p' "$BUILD_DIR/compile.log" >&2 || true
    exit 0
  fi
  echo "[check-pglite-embedded] FAIL: bun could not compile the smoketest binary." >&2
  sed -n '1,40p' "$BUILD_DIR/compile.log" >&2 || true
  exit 1
fi

# Run it against a temp GBRAIN_HOME. The smoketest boots a persistent PGLite
# brain, upserts a page, and reads it back; it prints one JSON line and exits 0
# only on a successful round-trip.
OUTPUT="$(GBRAIN_HOME="$GBRAIN_HOME_DIR" HOME="$GBRAIN_HOME_DIR" GBRAIN_SKIP_STARTUP_HOOKS=1 "$OUT_BIN" 2>&1 || true)"

if echo "$OUTPUT" | grep -qE '\$bunfs|Extension bundle not found|PGLite failed to initialize|pglite\.data'; then
  echo "[check-pglite-embedded] FAIL: compiled binary hit a Bun-vfs asset error (assets not embedded)." >&2
  echo "[check-pglite-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"pageFound":true'; then
  echo "[check-pglite-embedded] FAIL: compiled binary did not find the seeded page." >&2
  echo "[check-pglite-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

if ! echo "$OUTPUT" | grep -q '"ok":true'; then
  echo "[check-pglite-embedded] FAIL: PGLite embedded smoketest returned ok:false." >&2
  echo "[check-pglite-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

echo "[check-pglite-embedded] OK — compiled binary served a PGLite query (assets embedded)."
