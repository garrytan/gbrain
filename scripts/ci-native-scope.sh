#!/usr/bin/env bash
# Classify a pull request's changed files (one path per line on stdin) for the
# native writer-lock workflow. Prints `primary` when any path can change native
# lock, IPC, publication, backup, export or sync behavior (every native target
# runs on the primary Bun version), otherwise `smoke` (only the Linux x64 glibc
# cell runs). An empty or unreadable list prints `primary`: an unknown diff
# never narrows validation. Pushes, schedules and manual runs never call this;
# they always run the full matrix.
set -euo pipefail

NATIVE_PATHS='^(native/|scripts/native/|src/core/persistence/|src/core/context/|test/fixtures/native|\.github/workflows/(native-locks|test)\.yml$|package\.json$|bun\.lock$|openclaw\.plugin\.json$|docker-compose\.ci\.yml$)|^src/core/(pglite-[^/]*|engine|postgres-engine|sync[^/]*|export-[^/]*|import-file|markdown|write-through|page-lock)\.ts$|^src/commands/(backup|export|restore|sync)[^/]*\.ts$|openclaw|native|-lock|local-ipc-path|persistence-(publication|git-publication|sync-origin)|backup-portability|export-publication'

files=$(cat)
if [ -z "$files" ] || printf '%s\n' "$files" | grep -Eq "$NATIVE_PATHS"; then
  echo primary
else
  echo smoke
fi
