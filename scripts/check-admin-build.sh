#!/usr/bin/env bash
# CI gate: admin React app must compile.
#
# Catches missing-symbol bugs (e.g., calling loadApiKeys() when only
# loadAgents is defined) before they reach E2E. Codex flagged this gap
# during the PR #586 review pass — five Claude review passes missed
# the loadApiKeys reference because the bash test pipeline doesn't run
# Vite builds. This script runs `bun install` in admin/ to ensure
# react/vite/etc. are present, then runs Vite's build which performs
# TypeScript type-check + bundle.
#
# Skip with GBRAIN_SKIP_ADMIN_BUILD=1 (e.g., for fast inner-loop test
# runs that don't touch admin/src). Production CI must NOT skip.
set -euo pipefail

if [ "${GBRAIN_SKIP_ADMIN_BUILD:-0}" = "1" ]; then
  echo "[check:admin-build] GBRAIN_SKIP_ADMIN_BUILD=1, skipping"
  exit 0
fi

cd "$(dirname "$0")/.."

if [ ! -d admin ]; then
  echo "[check:admin-build] no admin/ directory, skipping"
  exit 0
fi

cd admin

# Idempotent install. Skip the install path when the checked-in admin deps are
# already present; under parallel verify, a redundant `bun install` can contend
# with other checks and burn the whole per-check timeout.
if [ ! -x node_modules/vite/bin/vite.js ] || [ ! -f node_modules/typescript/bin/tsc ]; then
  bun install --silent >/dev/null 2>&1 || bun install
fi

# Run TypeScript explicitly; Vite's production build transpiles and bundles but
# does not reliably surface admin/src type errors on its own.
node node_modules/typescript/bin/tsc -b --pretty false

# Run Vite through Node directly. `bun run build` can leave the Vite wrapper
# process alive after a successful bundle on this admin app, which makes the
# verify gate time out even though the build itself is done.
node node_modules/vite/bin/vite.js build
