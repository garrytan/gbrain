#!/usr/bin/env bash
# scripts/ci-doc-checks.sh — the checks a doc-only change can still break.
#
# `ci:local:diff` and `ci:ubicloud:diff` skip every test lane when the diff is
# doc-only (scripts/select-e2e.ts classifies it DOC_ONLY); these checks still
# run, because a doc edit can leave generated or guarded artifacts stale:
# llms.txt freshness, KEY_FILES / TESTING.md byte caps and current-state
# voice, documented repository paths, skill references and the privacy guards.
# Every check runs; the exit code is 1 if any failed, and each failure prints
# its repair command.
set -uo pipefail

cd "$(dirname "$0")/.."

failed=0
check() {
  local name="$1" fix="$2"
  shift 2
  echo "[doc-checks] $name"
  if ! "$@"; then
    echo "[doc-checks] FAIL $name" >&2
    echo "Why: a doc-only change still has to keep this artifact current." >&2
    echo "Fix: $fix" >&2
    echo "Docs: docs/TESTING.md#e2e-selection" >&2
    failed=1
  fi
}

check "llms.txt + llms-full.txt are fresh" "bun run build:llms" bun test --timeout 60000 test/build-llms.test.ts
check "KEY_FILES and TESTING.md byte caps / current-state voice" "follow the check's message, then rerun bun run check:doc-history" bun run check:doc-history
check "documented scripts/ and test/ paths exist" "fix or delete the reference the test names" bun run check:docs-repo-paths
check "skill references resolve" "follow the check's message, then rerun bun run check:skill-refs" bun run check:skill-refs
check "privacy guard" "replace real names with placeholders (alice-example, acme-example), then rerun bun run check:privacy" bun run check:privacy
check "fixture privacy guard" "replace real names with placeholders, then rerun bun run check:fixture-privacy" bun run check:fixture-privacy

exit "$failed"
