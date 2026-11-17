#!/usr/bin/env bash
# Runs the agent-voice recipe's vitest unit suite (recipes/agent-voice/tests/unit).
#
# The recipe is copied into an operator's host agent repo and is not a foresights
# runtime dependency, so its tests run under node + vitest, not bun test, and
# no foresights lane collected them. This installs exact pins of the two packages
# the unit tests load (vitest, ws) into a temporary prefix, links it as the
# recipe's node_modules for the run, and removes both afterwards. The e2e
# voice tests (puppeteer + a live server) and the paid evals stay manual.
#
# Run: bun run test:agent-voice   (CI: test.yml verify job)
# Needs: node + npm on PATH and registry access for the pinned install.
# --legacy-peer-deps: npm 10 (the CI runner image) crashes resolving vitest 4's
# optional peer set ("reading 'edgesOut'"); the unit tests load no peer package.
set -euo pipefail

VITEST_VERSION=4.1.4
WS_VERSION=8.18.3

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RECIPE="$ROOT/recipes/agent-voice"
if [ -e "$RECIPE/node_modules" ] && [ ! -L "$RECIPE/node_modules" ]; then
  echo "agent-voice: $RECIPE/node_modules already exists and is not this script's link." >&2
  echo "Why: the run links a pinned temporary install there and would shadow or clobber your install." >&2
  echo "Fix: rm -rf recipes/agent-voice/node_modules && bun run test:agent-voice" >&2
  exit 2
fi

PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/gbrain-agent-voice.XXXXXX")"
cleanup() { rm -f "$RECIPE/node_modules"; rm -rf "$PREFIX"; }
trap cleanup EXIT

printf '{"name":"gbrain-agent-voice-tests","private":true,"dependencies":{"vitest":"%s","ws":"%s"}}\n' \
  "$VITEST_VERSION" "$WS_VERSION" > "$PREFIX/package.json"
(cd "$PREFIX" && npm install --no-audit --no-fund --ignore-scripts --no-package-lock --legacy-peer-deps --loglevel=error >/dev/null)
ln -sfn "$PREFIX/node_modules" "$RECIPE/node_modules"
cd "$RECIPE"
"$PREFIX/node_modules/.bin/vitest" run tests/unit
