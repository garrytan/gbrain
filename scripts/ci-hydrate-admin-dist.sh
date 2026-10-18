#!/usr/bin/env bash
# #6756: ci:local mounts the named volume gbrain-ci-admin-dist over
# /app/admin/dist (so the container's builds never write the host checkout),
# and a new named volume starts empty: a fresh checkout's `bun run build` then
# failed on the hashed bundles src/admin-embedded.ts imports. The runner calls
# this before the build to make the volume an exact copy of the worktree's
# admin/dist (mounted read-only at /ci-src/admin-dist): the current worktree
# bytes, uncommitted changes included, with stale hashed files from an older
# build removed. It refuses only when a file git tracks under admin/dist
# cannot be read from the worktree, naming the file and the admin build.
# Run from the repository root (the tracked list comes from git ls-files).
# Usage: ci-hydrate-admin-dist.sh <worktree admin/dist> <volume admin/dist>
set -euo pipefail
src="${1:?usage: ci-hydrate-admin-dist.sh <worktree admin/dist> <volume admin/dist>}"
dest="${2:?usage: ci-hydrate-admin-dist.sh <worktree admin/dist> <volume admin/dist>}"
tracked=$(git ls-files admin/dist)
if [ -z "$tracked" ]; then
  echo "[runner] ERROR: git tracks no files under admin/dist, so there is nothing to hydrate the admin/dist volume from. Build it with bun run build:admin, or restore it with git checkout -- admin/dist, and rerun ci:local." >&2
  exit 1
fi
while IFS= read -r path; do
  if [ ! -r "$src/${path#admin/dist/}" ]; then
    echo "[runner] ERROR: $path is tracked but cannot be read from the worktree ($src/${path#admin/dist/}), so the admin/dist volume was not hydrated. Restore it with git checkout -- $path, or rebuild the bundle with bun run build:admin, and rerun ci:local." >&2
    exit 1
  fi
done <<< "$tracked"
mkdir -p "$dest"
find "$dest" -mindepth 1 -delete
cp -R "$src/." "$dest/"
echo "[runner] admin/dist hydrated from the worktree ($(find "$dest" -type f | wc -l | tr -d ' ') files)"
