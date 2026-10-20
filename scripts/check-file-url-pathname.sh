#!/usr/bin/env bash
# Guard (#6845): no `.pathname` of a file URL in test code.
#
# `new URL(rel, import.meta.url).pathname` keeps the URL percent-encoding, so
# a checkout under a path with a space (or any other escaped character) turns
# `/tmp/gb space/` into `/tmp/gb%20space/` and the file is not found. Use
# `fileURLToPath(new URL(rel, import.meta.url))` from node:url, or
# `import.meta.dir` / `import.meta.path`.
#
# Scans test/ (*.ts, *.mts, *.js, *.mjs), except the guard fixtures under
# test/fixtures/guards/. Flags `import.meta.url).pathname`,
# `import.meta.url.pathname` and `pathToFileURL(...).pathname` on one line.
#
# Usage: bash scripts/check-file-url-pathname.sh
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree.
# Exit: 0 when clean, 1 with one line per finding.

set -uo pipefail

ROOT="${GBRAIN_GUARD_ROOT:-$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))}"
cd "$ROOT" || exit 1
if [ ! -d test ]; then
  echo "check-file-url-pathname: no test/ directory under $ROOT" >&2
  exit 1
fi

PATTERN='import\.meta\.url\)?\.pathname|pathToFileURL\([^)]*\)\.pathname'
hits=$(grep -rnE --include='*.ts' --include='*.mts' --include='*.js' --include='*.mjs' "$PATTERN" test | grep -v '^test/fixtures/guards/' || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo "check-file-url-pathname: FAIL. A file URL's .pathname keeps %20 and other escapes, so the path breaks under a directory with a space."
  echo "Fix: fileURLToPath(new URL(rel, import.meta.url)) from node:url, or import.meta.dir / import.meta.path (#6845)."
  exit 1
fi
echo "check-file-url-pathname: ok"
