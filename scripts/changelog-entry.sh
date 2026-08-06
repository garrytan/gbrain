#!/usr/bin/env bash
# Print the CHANGELOG.md body for one version (Keep-a-Changelog format),
# without its `## [X.Y.Z.W] - date` header line. Used by
# .github/workflows/release.yml as the GitHub release notes; tested by
# test/release-workflow.test.ts.
#
# Usage: changelog-entry.sh <version> [changelog-file]
# Exits 1 when the version has no entry (caller falls back to a link stub).
set -euo pipefail

ver="${1:?usage: changelog-entry.sh <version> [changelog-file]}"
file="${2:-CHANGELOG.md}"

# Exact-string prefix match on "## [<ver>]" — no regex, so dots in the
# version can't glob and a 3-segment version can't match a 4-segment header.
awk -v ver="$ver" '
  index($0, "## [" ver "]") == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
  END { exit found ? 0 : 1 }
' "$file"
