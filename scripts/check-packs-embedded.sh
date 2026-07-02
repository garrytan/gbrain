#!/usr/bin/env bash
# CI guard: verify that `bun build --compile` binaries ship with the bundled
# schema-pack YAMLs EMBEDDED and that they load + parse in the compiled
# binary.
#
# This is the #1 silent-failure mode that degraded the whole filing/taxonomy
# layer (v0.42.51 and earlier): the bundled pack YAMLs were resolved via an
# on-disk `import.meta.url` path that points at `/$bunfs/root/...` in a
# compiled binary where the YAML is NOT on disk. `gbrain schema active`
# returned "unknown schema pack: gbrain-base", put_page silently degraded
# (skipped type validation), and brain-taxonomist was neutered. The active
# pack `extends: gbrain-base`, so the bundled parent failing to load took the
# whole resolution down.
#
# The fix embeds each pack as a Bun file asset (`with { type: 'file' }`) via
# the central registry (src/core/schema-pack/bundled-packs.ts). This guard is
# FUNCTIONAL — it compiles a probe and actually loads every bundled pack
# THROUGH the compiled binary (not a `strings | grep`, which can't tell an
# embedded-but-unparseable asset from a working one).
#
# Fails the build when:
#   - bun build --compile fails
#   - any bundled pack fails to load inside the compiled binary
#   - gbrain-base loads but declares zero page types (empty/corrupt asset)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_BIN="$(mktemp /tmp/gbrain-packs-check.XXXXXX)"
trap 'rm -f "$OUT_BIN"' EXIT

# Compile a minimal probe that loads every bundled pack through the real
# loadActivePack boundary. We compile this instead of the full gbrain CLI so
# the failure mode is laser-focused on pack embedding + path resolution.
bun build --compile --outfile "$OUT_BIN" scripts/packs-smoketest.ts >/dev/null 2>&1

# Run it and capture JSON output.
OUTPUT="$("$OUT_BIN" 2>&1)"

# all_bundled_loaded: every bundled pack resolved without throwing inside the
# compiled binary (the extends walk loaded embedded parents too).
if ! echo "$OUTPUT" | grep -q '"all_bundled_loaded": true'; then
  echo "[check-packs-embedded] FAIL: a bundled schema pack did not load from the compiled binary." >&2
  echo "[check-packs-embedded] This is the silent compile bug — bundled pack YAMLs are not embedded." >&2
  echo "[check-packs-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

# base_page_types: gbrain-base must declare a non-zero set of page types.
# A 0 here means the YAML embedded but parsed empty (asset-path drift).
if echo "$OUTPUT" | grep -q '"base_page_types": 0'; then
  echo "[check-packs-embedded] FAIL: gbrain-base loaded but declared 0 page types (empty/corrupt embedded asset)." >&2
  echo "[check-packs-embedded] Output was:" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

echo "[check-packs-embedded] OK — compiled binary loaded all bundled schema packs."
