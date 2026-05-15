#!/usr/bin/env bash
# v0.32.3 — CI guard for docs/eval/METRIC_GLOSSARY.md freshness.
#
# Mirrors the scripts/check-jsonb-pattern.sh / check-progress-to-stdout.sh
# discipline: regenerate the doc into a tmp file, diff against the committed
# version, fail the build if they drift.
#
# Run: bash scripts/check-eval-glossary-fresh.sh
# CI wires this through `bun run test` so PRs that bump the glossary module
# without regenerating the doc are caught before review.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMITTED="$REPO_ROOT/docs/eval/METRIC_GLOSSARY.md"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ ! -f "$COMMITTED" ]; then
  echo "ERROR: $COMMITTED not found." >&2
  echo "Run: bun run scripts/generate-metric-glossary.ts" >&2
  exit 1
fi

# Regenerate into TMP without touching the committed file. We can't easily
# point the generator at a different path; trick it by redirecting cwd to
# a sandbox and post-comparing.
cd "$REPO_ROOT"
# Render directly via bun + a one-liner that exposes the module function.
bun -e "import { renderMetricGlossaryMarkdown } from './src/core/eval/metric-glossary.ts'; process.stdout.write(renderMetricGlossaryMarkdown());" > "$TMP"

if ! diff -q "$COMMITTED" "$TMP" >/dev/null 2>&1; then
  echo "ERROR: docs/eval/METRIC_GLOSSARY.md is stale." >&2
  echo "" >&2
  echo "Diff between committed and freshly-generated:" >&2
  echo "" >&2
  diff -u "$COMMITTED" "$TMP" >&2 || true
  echo "" >&2
  echo "To regenerate: bun run scripts/generate-metric-glossary.ts" >&2
  exit 1
fi

echo "✓ docs/eval/METRIC_GLOSSARY.md is fresh"
