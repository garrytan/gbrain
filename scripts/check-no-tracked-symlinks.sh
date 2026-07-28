#!/usr/bin/env bash
# CI guard: fail if any symlink is tracked in git.
#
# A symlink committed from a build sandbox points at a path that exists on
# exactly one machine. Everywhere else the checkout produces a dangling
# link, and anything that opens it fails. That is not hypothetical: commit
# faf5cdba landed `node_modules -> /tmp/fleet/repo/node_modules`, which made
# `bun install` abort with `ENOENT: could not open the "node_modules"
# directory` on every fresh clone, and took `gbrain upgrade`'s bun-link path
# down with it (the auto-upgrade runs `bun install`, so the printed manual
# fallback failed the same way).
#
# .gitignore alone does not prevent this. A `node_modules/` pattern with a
# trailing slash matches directories ONLY, so a symlink of the same name is
# never ignored. Dropping the slash closes that hole, but `git add -f` still
# walks straight past it. This guard is the backstop.
#
# The repo has no legitimate tracked symlinks, so the allowlist starts
# empty. If you ever need one, add its exact repo-relative path to ALLOWLIST
# below and explain why — a relative link that resolves inside the repo is
# defensible; an absolute one almost never is.
#
# Usage: scripts/check-no-tracked-symlinks.sh
# Exit:  0 when clean, 1 when a tracked symlink is found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Paths permitted to be tracked symlinks. Empty by design.
ALLOWLIST=()

# Git records symlinks with mode 120000. Field 4 of `ls-files -s` is the path
# (tab-separated from the stage number), so cut on the tab to keep paths with
# spaces intact.
found="$(git ls-files -s | awk '$1 == "120000"' | cut -f2- || true)"

if [ -n "$found" ]; then
  filtered="$found"
  for f in "${ALLOWLIST[@]:-}"; do
    [ -z "$f" ] && continue
    filtered="$(echo "$filtered" | grep -vxF "$f" || true)"
  done

  if [ -n "$filtered" ]; then
    echo "ERROR: symlink(s) tracked in git:"
    echo
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      target="$(git cat-file blob ":$path" 2>/dev/null || echo '<unreadable>')"
      echo "  $path -> $target"
    done <<< "$filtered"
    echo
    echo "A committed symlink resolves on the machine that created it and"
    echo "nowhere else. Untrack it:"
    echo
    echo "  git rm --cached <path>"
    echo
    echo "If the path is build output (node_modules, dist, bin), also confirm"
    echo "it is covered by .gitignore WITHOUT a trailing slash — a trailing"
    echo "slash matches directories only and lets the symlink through."
    exit 1
  fi
fi

echo "check-no-tracked-symlinks: OK (no tracked symlinks)"
