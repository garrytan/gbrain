#!/usr/bin/env bash
# Fail when a test reads a named changelog.d fragment from the repository.
#
# A release folds every changelog.d/<fragment>.md into CHANGELOG.md and deletes
# it, so a test that opens one by name passes on its PR and fails on the release
# commit (v0.60.726.0 never published for this). Read CHANGELOG.md, or build the
# fragment in a temporary fixture directory, instead.
#
# A line counts when it names changelog.d, a .md file other than README.md and
# the repository root (ROOT, REPO, REPO_ROOT, import.meta.dir, __dirname or
# process.cwd()). Fixture paths built under a temporary directory don't.
set -euo pipefail

cd "$(dirname "$0")/.."

hits="$(grep -rnE 'changelog\.d' test/ \
  | grep -E '[A-Za-z0-9_.-]+\.md' \
  | grep -vE "changelog\.d['\"/, ]+README\.md" \
  | grep -E '\b(ROOT|REPO|REPO_ROOT)\b|import\.meta\.dir|__dirname|process\.cwd\(\)' || true)"

if [ -n "$hits" ]; then
  echo "FAIL: a test reads a changelog.d fragment from the repository; the next release deletes it and the test breaks:"
  echo "$hits"
  echo "Fix:  read the entry from CHANGELOG.md (it holds the text once the release folds it), or write the fragment into a temporary fixture."
  exit 1
fi
echo "OK: no test reads a changelog.d fragment from the repository."
