#!/usr/bin/env bash
# scripts/ci-cache-hash.sh — deterministic content hash of all test-
# affecting files for the CI auto-cache.
#
# Outputs a 16-character hex prefix of sha256(sorted list of
# `<git-blob-sha> <path>` lines for every tracked file EXCEPT the
# deny-list below). Same tree → same hash. Different code → different
# hash. Doc-only changes → same hash (cache hit).
#
# Used by .github/workflows/test.yml's cache-check job. Cache key is
# `ci-pass-<hash>`. When the hash matches a prior green run, the test
# matrix skips and reports green immediately.
#
# DESIGN: deny-list NOT allowlist. New files default to "include in
# hash" — worst case, cache miss (waste 8min). Allowlist would default
# to "exclude", risking false-pass (broken code shipped under green
# check) when someone adds a new file type that tests read.
#
# WHAT'S DENY-LISTED (genuinely test-irrelevant):
#   - CHANGELOG.md, TODOS.md   pure documentation
#   - README.md, LICENSE        marketing / metadata, no test reads them
#   - docs/**/*.md, *.txt       all docs/ subtree is doc-only
#
# WHAT'S DELIBERATELY NOT DENY-LISTED (affects test outcomes):
#   - CLAUDE.md     8+ test files reference it (resolver-merge, schema-cli,
#                   public-exports, eval-cross-modal-batch, etc.)
#   - AGENTS.md     same — referenced by resolver tests; counterpart to
#                   CLAUDE.md for OpenClaw hosts
#   - skills/**     SKILL.md files are read by skill conformance tests
#   - everything else under src/, test/, scripts/, .github/, package.json,
#     bun.lock, tsconfig*.json, the schema files — obviously test-affecting
#
# Locale-stable: LC_ALL=C on the sort step so byte-order is identical
# across runners (different default locales would re-order the line list
# and change the final hash).
#
# Usage:
#   bash scripts/ci-cache-hash.sh                # print hash
#   bash scripts/ci-cache-hash.sh --verbose      # print hash + diagnostics to stderr
#
# Exit codes:
#   0   printed a 16-char hex hash
#   1   internal error (git failure, etc.)
#   2   usage error

set -euo pipefail

VERBOSE=0
if [ "${1:-}" = "--verbose" ]; then
  VERBOSE=1
  shift
fi
if [ "$#" -gt 0 ]; then
  echo "usage: bash scripts/ci-cache-hash.sh [--verbose]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# Deny-list as an extended regex matched against full paths emitted by
# `git ls-files`. -x makes the match anchored (full-line). Each pattern
# is a path predicate, not a glob — `\.` to literal-match dots.
#
# To add a new deny entry: add another `-e '<regex>'` line below. To
# REMOVE a deny entry (= include the path back in hash): delete its line.
# Either change invalidates the cache for everyone on next run (different
# hash output), which is the correct behavior.
DENY_PATTERNS=(
  -e '^CHANGELOG\.md$'
  -e '^TODOS\.md$'
  -e '^README\.md$'
  -e '^LICENSE$'
  -e '^docs/.*\.md$'
  -e '^docs/.*\.txt$'
)

# Use `git ls-files -s` for one-shot enumeration of tracked files + their
# index blob shas. Output shape: `<mode> <sha> <stage>\t<path>` per line.
# Far faster than per-file `git hash-object` (~30ms vs ~9s on 2000 files).
#
# Trade-off: this reflects the INDEX (committed/staged state), not the
# working tree. CI always works against a committed tree so this matches
# what tests actually run. Local dev with uncommitted edits sees the
# committed-side hash (close enough — the hash is for CI's cache lookup,
# not a tree-state diagnostic).
LS_FILES=$(git ls-files -s)
if [ -z "$LS_FILES" ]; then
  echo "error: git ls-files -s returned empty (are we in a git repo?)" >&2
  exit 1
fi

# Apply deny-list. Each line ends in `\t<path>` so the deny patterns
# anchor on a tab boundary. Compose the alternation regex from
# DENY_PATTERNS — each entry is `^<pat>$`; strip the `^` (since `\t`
# acts as our anchor in `git ls-files -s` output) and the trailing `$`
# stays as-is.
DENY_ALT=""
i=1
while [ $i -lt ${#DENY_PATTERNS[@]} ]; do
  p="${DENY_PATTERNS[$i]}"
  p="${p#^}"
  if [ -z "$DENY_ALT" ]; then
    DENY_ALT="$p"
  else
    DENY_ALT="$DENY_ALT|$p"
  fi
  i=$((i + 2))
done
DENY_RE=$(printf '\t(%s)' "$DENY_ALT")
# Note: each $p already ends in `$` to anchor end-of-line, so the full
# regex is `\t(^CHANGELOG\.md$|^TODOS\.md$|...)`. Wait — we stripped `^`
# from each but kept `$`, so the composed regex is `\t(CHANGELOG\.md$|
# TODOS\.md$|docs/.*\.md$|...)`. Each alternative anchors its own end.
INCLUDED=$(printf '%s\n' "$LS_FILES" | grep -vE "$DENY_RE" || true)

if [ -z "$INCLUDED" ]; then
  echo "error: every tracked file is deny-listed — refusing to hash empty set" >&2
  exit 1
fi

# Sort by full line (LC_ALL=C for byte-order stability across locales),
# hash the concatenation. Each line carries (mode, sha, path) so any
# change to content (sha), mode (executable bit), or path (rename) flips
# the final hash.
HASH=$(printf '%s\n' "$INCLUDED" \
  | LC_ALL=C sort \
  | sha256sum \
  | cut -c1-16)

if [ "$VERBOSE" = "1" ]; then
  included_count=$(printf '%s\n' "$INCLUDED" | wc -l | tr -d ' ')
  all_count=$(printf '%s\n' "$LS_FILES" | wc -l | tr -d ' ')
  denied_count=$((all_count - included_count))
  {
    echo "ci-cache-hash: $included_count/$all_count files in hash ($denied_count deny-listed)"
  } >&2
fi

echo "$HASH"
