#!/usr/bin/env bash
# CI guard: every `bun test` invocation in workflows and runner scripts must
# pass an explicit --timeout.
#
# Why: bun ignores bunfig.toml's `timeout` key (verified on 1.3.14), so a bare
# `bun test` gets the 5000ms default for BOTH tests and beforeAll/beforeEach/
# afterAll/afterEach hooks. Hooks do NOT inherit a test's third-arg timeout —
# a file whose tests all declare `}, 30_000)` still has a 5s hook budget, and
# slow setup (Postgres connect + migrations, PGLite cold start) flakes on
# loaded CI runners with the signature `(unnamed) [5001ms] ... hook timed out`
# (the #3545 jsonb-parity failure). The CLI --timeout flag is the one measured
# mechanism that raises the hook budget uniformly; per-hook second-arg
# timeouts work too but don't scale to ~400 slow hooks.
#
# Usage: scripts/check-bun-test-timeout.sh
# Exit:  0 when clean, 1 when a bare `bun test` invocation is found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Match executable `bun test` invocations. Exclude comment lines (#, //, *)
# and lines that already carry --timeout anywhere.
# Scope: workflows + runner scripts (the surfaces CI executes). package.json
# script bodies route through scripts/ already; editing it is out of scope here.
violations="$(grep -rnE '\bbun test\b' .github/workflows scripts 2>/dev/null \
  | grep -v -- '--timeout' \
  | grep -vE ':[[:space:]]*(#|//|\*)' \
  | grep -v 'check-bun-test-timeout' \
  || true)"

if [ -n "$violations" ]; then
  echo "FAIL: bare 'bun test' without --timeout (5s default kills slow setup hooks):" >&2
  echo "$violations" >&2
  echo "" >&2
  echo "Add --timeout=60000 (see scripts/run-unit-shard.sh for the convention)." >&2
  exit 1
fi

echo "OK: every bun test invocation passes an explicit --timeout."
