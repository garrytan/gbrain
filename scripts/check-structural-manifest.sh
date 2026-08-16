#!/usr/bin/env bash
# CI guard: scripts/structural-suites.tsv (the behavioral-vs-structural test
# inventory) must match a fresh regeneration. Suites drift constantly; a stale
# inventory silently lies in the coverage report, so freshness is enforced the
# same way as skills.lock / TOOL_CATALOG (generate-then-diff).
#
# Regenerate: bun scripts/classify-tests.ts
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

exec bun scripts/classify-tests.ts --check
