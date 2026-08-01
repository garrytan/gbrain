#!/usr/bin/env bash
# CI guard for skills/skills.lock.json freshness (#159).
#
# Mirrors scripts/check-eval-glossary-fresh.sh: regenerate the manifest into
# a tmp file, diff against the committed version, fail the build if they
# drift. Tamper-evidence, not a signature system — the point is that any
# change under skills/ ships with an explicit manifest diff.
#
# Run: bash scripts/check-skills-manifest-fresh.sh
# Wired through `bun run verify` (scripts/run-verify-parallel.sh) so PRs that
# edit skills/ without regenerating the manifest are caught before review.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMITTED="$REPO_ROOT/skills/skills.lock.json"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$COMMITTED" ]; then
  echo "ERROR: $COMMITTED not found." >&2
  echo "Run: bun run scripts/generate-skills-manifest.ts" >&2
  exit 1
fi

cd "$REPO_ROOT"
# Render directly via bun + a one-liner that exposes the module function.
bun -e "import { renderSkillsManifest } from './src/core/skills-integrity.ts'; process.stdout.write(renderSkillsManifest('skills'));" > "$TMP"

if ! diff -q "$COMMITTED" "$TMP" >/dev/null 2>&1; then
  echo "ERROR: skills/skills.lock.json is stale." >&2
  echo "" >&2
  echo "Diff between committed and freshly-generated:" >&2
  echo "" >&2
  diff -u "$COMMITTED" "$TMP" >&2 || true
  echo "" >&2
  echo "To regenerate: bun run scripts/generate-skills-manifest.ts" >&2
  exit 1
fi

echo "✓ skills/skills.lock.json is fresh"
