#!/usr/bin/env bash
# Classify a pull request's changed files (one path per line on stdin) for the
# managed-sync convergence gate (persistence-validation.yml `convergence`,
# test/sync-convergence.serial.test.ts). Prints `run` when any path can change
# how a managed sync converges: persistence, the sync commands and sync core,
# page projections and storage, the Postgres driver (bun.lock and the vendored
# vendor/postgres), the harness and its workflows. Otherwise prints
# `skip`. An empty or unreadable list prints `run`: an unknown diff never
# narrows validation. package.json is deliberately not a selector, so a
# release-stamp-only PR does not run the gate. Pushes, schedules and manual
# runs never call this; they always run the gate.
set -euo pipefail

CONVERGENCE_PATHS='^(bun\.lock$|vendor/postgres/|src/core/persistence/|src/commands/sync/|src/core/page-state/|src/core/engine-sql/|src/core/storage/|test/fixtures/convergence-fault-kill\.ts$|test/sync-convergence\.serial\.test\.ts$|scripts/ci-convergence-scope\.sh$|\.github/workflows/(persistence-validation|convergence-nightly)\.yml$)|^src/commands/sync[^/]*\.ts$|^src/core/(sync[^/]*|import-file|markdown|write-through|timeline-write-through|storage|storage-config|page-lock|ghost-pages|postgres-engine)\.ts$'

files=$(cat) || { echo run; exit 0; }
# Consume the full input: grep -q closes an early match's pipe and printf
# then fails with SIGPIPE under pipefail, incorrectly selecting skip.
if [ -z "$files" ] || grep -E "$CONVERGENCE_PATHS" >/dev/null <<< "$files"; then
  echo run
else
  status=$?
  if [ "$status" -eq 1 ]; then echo skip; else echo run; fi
fi
