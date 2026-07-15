#!/usr/bin/env bash
# scripts/check-fuzz-purity.sh
# CI guard: verify that every fuzz target in `test/fuzz/pure-validators.test.ts`
# is genuinely PURE — no transitive imports of `node:fs`, `node:child_process`,
# the engine layer, or `node:net` / `node:http` / `node:https`.
#
# Mechanism: bundle each target file with `bun build --target=bun` (which
# resolves the full transitive import graph) then grep the bundle for forbidden
# imports. Bun surfaces transitively-imported node builtins in the bundle output
# even when the indirect-importing file is only reached through several layers,
# so the grep catches what require.cache / source-grep approaches miss. This is
# the "isolated Bun subprocess with import-trace probe" design from the T2
# plan revision.
#
# Smoke-tested 2026-05-19: adding `import { lstatSync } from 'node:fs'` to a
# target file makes this script fail loudly with the offending file + matched
# pattern.
#
# Failure modes the guard catches:
#   - Direct import of a banned builtin in a target file
#   - Transitive import through a helper (the failure mode my v1 require.cache
#     proposal couldn't catch in Bun's ESM loader)
#   - Re-export from a barrel module
#
# What this DOESN'T catch:
#   - Runtime-only `require('fs')` constructed via string concatenation
#     (intentional escape hatch is rare and would surface in code review)
#   - Native addon dynamic imports
#
# Usage: scripts/check-fuzz-purity.sh
# Exit:  0 = all targets pure, 1 = any target imports a banned module.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Targets — keep in sync with `test/fuzz/pure-validators.test.ts` imports.
# Only files whose bundle is bundle-pure live here. The original T2 plan listed
# more files; the bundle disproved their purity (validator-shaped functions
# living in modules that transitively import fs). Those validators still get
# property-tested in `test/fuzz/mixed-validators.test.ts` — same fuzz coverage,
# no purity guarantee. Filesystem-touching validators live in
# `test/fuzz/filesystem-validators.test.ts`.
TARGET_FILES=(
  "src/core/cjk.ts"                    # escapeLikePattern
  "src/core/facts-fence.ts"            # parseFactsFence
)

# Banned imports. Bun's bundler emits a mix of forms in the output JS:
#   - `from "fs"` / `from "node:fs"` (named + namespace imports preserve this)
#   - `__require("fs")` / `require("fs")` (CJS-style or dynamic-import lowering)
#   - `from "fs/promises"` / `from "node:fs/promises"` (subpaths — promises API)
#   - `import("fs")` (raw dynamic import that may survive bundling)
# /review codex pass caught the subpath + dynamic-import gaps; this list closes
# them. Subpath patterns use trailing-slash matches so `fs/promises` and any
# future `fs/<subpath>` all trip the guard.
BANNED_PATTERNS=(
  'from "node:fs"'
  'from "fs"'
  'from "node:fs/'
  'from "fs/'
  'from "node:child_process"'
  'from "child_process"'
  'from "node:net"'
  'from "node:http"'
  'from "node:https"'
  'from "node:dns"'
  'from "node:cluster"'
  'require("node:fs")'
  'require("fs")'
  'require("node:fs/'
  'require("fs/'
  'require("node:child_process")'
  'require("child_process")'
  '__require("fs")'
  '__require("node:fs")'
  '__require("child_process")'
  '__require("node:child_process")'
  'import("fs")'
  'import("node:fs")'
  'import("child_process")'
  'import("node:child_process")'
)

# Engine-layer imports — these are the OTHER thing fuzz targets must not touch.
# A fuzz harness that pulls in `engine.ts` could trigger DB connections through
# transitive imports of engine-factory.
BANNED_PATH_PATTERNS=(
  'src/core/engine.ts'
  'src/core/postgres-engine.ts'
  'src/core/pglite-engine.ts'
  'src/core/db.ts'
  'src/core/engine-factory.ts'
)

TMP_BUNDLE_DIR=$(mktemp -d -t gbrain-fuzz-purity-XXXXXX)
trap 'rm -rf "$TMP_BUNDLE_DIR"' EXIT

violations=0

for target in "${TARGET_FILES[@]}"; do
  if [ ! -f "$target" ]; then
    echo "[check-fuzz-purity] WARN: target not found: $target" >&2
    continue
  fi

  # Bundle the target into a fresh subdir. --outdir handles the case where a
  # target's bundle includes side-asset files (WASM, etc) — --outfile fails on
  # those with "cannot write multiple output files." A pure target should
  # produce exactly one .js file, but we route through --outdir for safety.
  SUB="$TMP_BUNDLE_DIR/$(basename "$target" .ts)"
  mkdir -p "$SUB"
  if ! bun build --target=bun "$target" --outdir="$SUB" >"$SUB/build.log" 2>&1; then
    echo "[check-fuzz-purity] FAIL: $target failed to bundle." >&2
    sed 's/^/  /' "$SUB/build.log" >&2
    violations=$((violations + 1))
    continue
  fi

  # A bundle that emits asset files (.wasm, etc) is itself a smell — pure
  # targets shouldn't ship binary assets.
  assets=$(find "$SUB" -maxdepth 1 -type f ! -name '*.js' ! -name 'build.log' | wc -l | tr -d ' ')
  if [ "$assets" -gt 0 ]; then
    echo "[check-fuzz-purity] FAIL: $target bundle emitted $assets side-asset file(s); pure targets must be JS-only." >&2
    find "$SUB" -maxdepth 1 -type f ! -name '*.js' ! -name 'build.log' | head -5 >&2
    violations=$((violations + 1))
    continue
  fi

  BUNDLE_JS="$SUB/$(basename "$target" .ts).js"
  if [ ! -f "$BUNDLE_JS" ]; then
    echo "[check-fuzz-purity] FAIL: $target bundle produced no .js output." >&2
    violations=$((violations + 1))
    continue
  fi

  # Check each banned import pattern against the bundled output.
  for pattern in "${BANNED_PATTERNS[@]}"; do
    if grep -F -q -- "$pattern" "$BUNDLE_JS"; then
      echo "[check-fuzz-purity] FAIL: $target bundle contains banned import: $pattern" >&2
      grep -n -F -- "$pattern" "$BUNDLE_JS" | head -3 >&2
      violations=$((violations + 1))
    fi
  done

  # Check engine-path patterns (these appear as `// <path>` comments in Bun's
  # bundle output when a transitively-imported module is bundled in).
  for path_pat in "${BANNED_PATH_PATTERNS[@]}"; do
    if grep -F -q -- "$path_pat" "$BUNDLE_JS"; then
      echo "[check-fuzz-purity] FAIL: $target transitively pulls in: $path_pat" >&2
      violations=$((violations + 1))
    fi
  done
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "[check-fuzz-purity] $violations violation(s). Move impure validators to" >&2
  echo "  test/fuzz/filesystem-validators.test.ts (no purity guard there)." >&2
  exit 1
fi

echo "[check-fuzz-purity] OK — ${#TARGET_FILES[@]} pure-fuzz target(s) verified clean."
