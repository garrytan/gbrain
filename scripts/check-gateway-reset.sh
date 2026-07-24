#!/usr/bin/env bash
# CI guard: fail if a test file calls configureGateway()/__setEmbedTransportForTests()
# without resetting it in an afterAll (#3066 class). Thin wrapper so this guard
# fits the scripts/check-*.sh invocation convention every other guard in this
# repo uses (wired into package.json + run-verify-parallel.sh by name); the
# actual scanner is scripts/check-gateway-reset.mjs (see that file's header for
# the full rationale and heuristic scope).
#
# node/bun fallback mirrors scripts/check-jsonb-pattern.sh's invocation of
# scripts/check-jsonb-params.mjs.
#
# Usage: scripts/check-gateway-reset.sh
# Exit:  0 when clean, 1 when violations found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if command -v node >/dev/null 2>&1; then
  node scripts/check-gateway-reset.mjs
elif command -v bun >/dev/null 2>&1; then
  bun scripts/check-gateway-reset.mjs
else
  echo "WARN: neither node nor bun on PATH; skipping check-gateway-reset.mjs" >&2
fi
