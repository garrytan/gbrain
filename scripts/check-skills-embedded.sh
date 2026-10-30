#!/usr/bin/env bash
# CI guard (GBRA-194): a `bun build --compile` binary serves gbrain's bundled
# skills byte-identical to skills/. `gbrain bundled-skill` and the spring-loaded
# skills index read them from src/core/skills/bundled-skills.generated.ts, so a
# compiled binary must carry every file as text: no host skills/ dir exists
# beside a release binary. Fails when compile fails, a file is missing or not
# text, or any file's bytes differ from the source tree.
# Mirrors scripts/check-pglite-embedded.sh. Registered in scripts/guards-manifest.tsv.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BUILD_DIR="$(mktemp -d /tmp/gbrain-skills-check.XXXXXX)"
OUT_BIN="$BUILD_DIR/skills-embedded-smoketest"
trap 'rm -rf "$BUILD_DIR"' EXIT
mkdir -p "$BUILD_DIR/scripts"
cp -R "$REPO_ROOT/src" "$BUILD_DIR/src"
cp -R "$REPO_ROOT/skills" "$BUILD_DIR/skills"
cp "$REPO_ROOT/package.json" "$BUILD_DIR/package.json"
cp "$REPO_ROOT/scripts/skills-embedded-smoketest.ts" "$BUILD_DIR/scripts/skills-embedded-smoketest.ts"
ln -s "$REPO_ROOT/node_modules" "$BUILD_DIR/node_modules"

if ! (cd "$BUILD_DIR" && bun build --compile --no-compile-autoload-bunfig --outfile "$OUT_BIN" scripts/skills-embedded-smoketest.ts >"$BUILD_DIR/compile.log" 2>&1); then
  if grep -qiE 'not (found|available)|permission denied|Could not download|ETIMEDOUT|network' "$BUILD_DIR/compile.log"; then
    echo "[check-skills-embedded] SKIP: bun build --compile unavailable in this sandbox." >&2
    echo "GBRAIN_CHECK_SKIPPED: bun build --compile unavailable"
    exit 0
  fi
  echo "[check-skills-embedded] FAIL: bun could not compile the smoketest binary." >&2
  sed -n '1,40p' "$BUILD_DIR/compile.log" >&2 || true
  exit 1
fi

# Run it away from the checkout and the build copy: the binary must not need skills/.
rm -rf "$BUILD_DIR/skills" "$BUILD_DIR/src"
if ! (cd / && HOME="$BUILD_DIR" "$OUT_BIN" >"$BUILD_DIR/embedded.tsv" 2>"$BUILD_DIR/run.log"); then
  echo "[check-skills-embedded] FAIL: compiled binary could not read its embedded skills." >&2
  cat "$BUILD_DIR/embedded.tsv" "$BUILD_DIR/run.log" >&2 || true
  exit 1
fi

: >"$BUILD_DIR/expected.tsv"
while IFS=$'\t' read -r path _; do
  printf '%s\t%s\n' "$path" "$(sha256sum "$REPO_ROOT/skills/$path" | cut -d' ' -f1)" >>"$BUILD_DIR/expected.tsv"
done <"$BUILD_DIR/embedded.tsv"

COUNT="$(wc -l <"$BUILD_DIR/embedded.tsv" | tr -d ' ')"
if [ "$COUNT" -lt 50 ]; then
  echo "[check-skills-embedded] FAIL: only $COUNT embedded skill files." >&2
  exit 1
fi
if ! diff -u "$BUILD_DIR/expected.tsv" "$BUILD_DIR/embedded.tsv" >&2; then
  echo "[check-skills-embedded] FAIL: compiled binary's skill files differ from skills/ (see diff above)." >&2
  exit 1
fi
echo "[check-skills-embedded] OK — compiled binary serves $COUNT bundled skill files byte-identical to skills/."
