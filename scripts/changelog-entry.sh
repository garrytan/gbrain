#!/usr/bin/env bash
# Print the CHANGELOG.md body for one version (Keep-a-Changelog format),
# without its `## [X.Y.Z.W] - date` header line. Used by
# .github/workflows/release.yml as the GitHub release notes; tested by
# test/release-workflow.test.ts.
#
# With --pr-list, run in a git checkout of the release commit, the body opens
# with one line per change: for every changelog.d fragment a release commit
# deleted since the newest v* tag before HEAD, in fold order (oldest release
# first, then path order), the fragment's first bold line plus the "(#N)" of
# the master commit that added it. The list goes on the GitHub release only;
# CHANGELOG.md never carries it.
#
# Usage: changelog-entry.sh [--pr-list] <version> [changelog-file]
# Exits 1 when the version has no entry (caller falls back to a link stub).
set -euo pipefail

pr_list=0
if [ "${1:-}" = "--pr-list" ]; then pr_list=1; shift; fi
ver="${1:?usage: changelog-entry.sh [--pr-list] <version> [changelog-file]}"
file="${2:-CHANGELOG.md}"

# Exact-string prefix match on "## [<ver>]" — no regex, so dots in the
# version can't glob and a 3-segment version can't match a 4-segment header.
entry() {
  awk -v ver="$ver" '
    index($0, "## [" ver "]") == 1 { found = 1; next }
    found && /^## \[/ { exit }
    found { print }
    END { exit found ? 0 : 1 }
  ' "$file"
}

# One "- <headline> (#N)" line per folded fragment. Prints nothing when there is
# no earlier release tag or no history (a shallow checkout).
list_changes() {
  local prev release path headline subject pr
  prev="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD^ 2>/dev/null)" || return 0
  for release in $(git log --reverse --first-parent --format=%H "$prev..HEAD" -- VERSION); do
    while IFS= read -r path; do
      case "$path" in changelog.d/*.md) ;; *) continue ;; esac
      [ "$path" = "changelog.d/README.md" ] && continue
      headline="$(git show "$release^:$path" | awk '
        NR == 1 && /^---[[:space:]]*$/ { fm = 1; next }
        fm { if (/^---[[:space:]]*$/) fm = 0; next }
        /^\*\*/ { sub(/^\*\*/, ""); sub(/\*\*[[:space:]]*$/, ""); print; exit }
      ')"
      [ -n "$headline" ] || continue
      subject="$(git log --first-parent --diff-filter=A --format=%s -1 "$release^" -- "$path")"
      pr="$(printf '%s\n' "$subject" | sed -nE 's/.*\(#([0-9]+)\)[[:space:]]*$/\1/p; s/^Merge pull request #([0-9]+).*/\1/p' | head -n1)"
      headline="${headline%.}"
      if [ -n "$pr" ]; then
        headline="${headline% (#$pr)}"
        printf -- '- %s (#%s)\n' "$headline" "$pr"
      else
        printf -- '- %s\n' "$headline"
      fi
    done < <(git diff-tree --no-commit-id -r --diff-filter=D --name-only "$release^" "$release" -- changelog.d | LC_ALL=C sort)
  done
}

entry > /dev/null
if [ "$pr_list" = 1 ]; then
  list="$(list_changes)"
  if [ -n "$list" ]; then printf '%s\n\n' "$list"; fi
fi
entry
