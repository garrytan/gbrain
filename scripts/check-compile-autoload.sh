#!/usr/bin/env bash
# CI guard: every `bun build --compile` invocation must carry
# `--no-compile-autoload-bunfig`.
#
# Why: a compiled Bun binary auto-loads a `bunfig.toml` from the CURRENT
# DIRECTORY at startup and runs its `preload` scripts BEFORE any of the
# binary's own code — before cli-preflight.ts, before the cwd-.env quarantine.
# gbrain is a globally installed CLI that runs from arbitrary checkouts, so a
# hostile repository carrying `bunfig.toml` + `preload = ["./x.ts"]` would get
# code execution from a plain `gbrain --version` (verified on Bun 1.3.13). The
# flag makes a cwd bunfig.toml inert for the compiled binary. The dev runtime
# (`bun src/cli.ts`) stays bun-native: a contributor's cwd is trusted.
#
# Invocation shapes checked (one line each):
#   (a) shell / YAML / markdown: `bun build --compile … --outfile …`
#   (b) TS/JS spawn arrays:       ['build', '--compile', …] / ["build", "--compile", …]
# Prose that merely names `bun build --compile` (no --outfile) is not an
# invocation and is ignored.
#
# Scan set: package.json, CLAUDE.md, CONTRIBUTING.md, .github/, scripts/, docs/
# (relative to the guard root). test/ compile helpers are deliberately out of
# scope here — they build throwaway binaries run from temp dirs.
#
# Self-test seam: GBRAIN_GUARD_ROOT (fixture tree root) — guard-self-test.sh
# runs this against test/fixtures/guards/check-compile-autoload.sh/{bad,good}.
#
# Usage: scripts/check-compile-autoload.sh
# Exit:  0 when every invocation carries the flag, 1 otherwise.

set -uo pipefail

ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 1

FLAG='--no-compile-autoload-bunfig'
SELF="scripts/$(basename "$0")"

TARGETS=()
for t in package.json CLAUDE.md CONTRIBUTING.md .github scripts docs; do
  [ -e "$t" ] && TARGETS+=("$t")
done
if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "FAIL: nothing to scan under $ROOT (expected package.json / .github / scripts / docs)" >&2
  exit 1
fi

# (a) one-line CLI invocation: `bun build --compile` followed later on the line by `--outfile`
# (b) spawn-array form: 'build', '--compile' (either quote style, optional whitespace)
SHAPE_A='bun build --compile[^`]*--outfile'
SHAPE_B="['\"]build['\"],[[:space:]]*['\"]--compile['\"]"

hits="$(grep -rnE --exclude="$(basename "$SELF")" -e "$SHAPE_A" -e "$SHAPE_B" "${TARGETS[@]}" 2>/dev/null | grep -v -- "$FLAG" || true)"

if [ -n "$hits" ]; then
  echo "ERROR: bun build --compile invocation(s) without $FLAG:" >&2
  echo "$hits" >&2
  echo >&2
  echo "       A compiled binary auto-loads a cwd bunfig.toml and runs its preload scripts" >&2
  echo "       before any gbrain code. Add $FLAG to every compile invocation" >&2
  echo "       (CLI form: right after --compile; spawn arrays: as the element after '--compile')." >&2
  exit 1
fi

echo "OK: every bun build --compile invocation carries $FLAG"
