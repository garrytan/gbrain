#!/usr/bin/env bash
# CI guard: the public exports surface never shrinks silently (v0.21.0).
#
# Precedent: scripts/check-jsonb-pattern.sh + check-progress-to-stdout.sh
# are grep-based structural guards wired into `bun run test`. This one
# counts the entries in package.json "exports" and fails when the count
# drops below the v0.21.0 baseline (17 entries).
#
# Policy (from CLAUDE.md):
#   "Removing any of these is a breaking change going forward."
#
# If you're legitimately removing a public export: bump gbrain's minor
# version, note the removal in CHANGELOG.md under a "Breaking changes"
# bullet, then bump EXPECTED_COUNT below. Anything else is a regression.
#
# Adding a new export: update EXPECTED_COUNT to match AND extend the
# EXPECTED_EXPORTS list in test/public-exports.test.ts so the runtime
# contract test pins the canary symbol.

set -euo pipefail

EXPECTED_COUNT=17

# Count top-level keys in the exports object. `node -e` parses JSON
# reliably without needing jq (which isn't in every CI environment).
ACTUAL=$(node -e "
  const pkg = require('./package.json');
  console.log(Object.keys(pkg.exports || {}).length);
")

if [ "$ACTUAL" -lt "$EXPECTED_COUNT" ]; then
  echo "❌ public-exports guard: package.json exports shrank from $EXPECTED_COUNT to $ACTUAL"
  echo "   Removing a public export is a breaking change (see CLAUDE.md)."
  echo "   If intentional: bump gbrain minor version + update EXPECTED_COUNT in"
  echo "   scripts/check-exports-count.sh and EXPECTED_EXPORTS in"
  echo "   test/public-exports.test.ts, AND add a CHANGELOG 'Breaking changes' bullet."
  exit 1
fi

if [ "$ACTUAL" -gt "$EXPECTED_COUNT" ]; then
  echo "⚠️  public-exports guard: package.json exports grew from $EXPECTED_COUNT to $ACTUAL"
  echo "   Additive public API change. Update EXPECTED_COUNT in this script + the"
  echo "   EXPECTED_EXPORTS list in test/public-exports.test.ts to lock the new"
  echo "   canary symbols."
  exit 1
fi

echo "✓ public-exports guard: $ACTUAL entries (matches baseline $EXPECTED_COUNT)"
