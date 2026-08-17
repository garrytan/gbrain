#!/usr/bin/env bash
# scripts/check-plugin-tree.sh — drift gate for the committed `plugin/` tree.
#
# Regenerates the codex/claude plugin skill tree into a tmpdir via
# scripts/generate-plugin-tree.ts and byte-diffs it against the committed
# `plugin/` dir (same offline byte-diff posture as
# check-bootstrap-templates.sh part (c)). The generator itself also enforces
# the curation-record invariants (skills/plugin-lanes.json reasons, no
# overlap, starter_gaps snapshot freshness) and fails this gate on violation.
#
# SKIP-GRACEFUL: if the committed tree does not exist yet (mid-landing), print
# SKIP and exit 0 so parallel tasks can land in any order.
#
# Exit codes: 0 clean/skip, 1 drift or curation violation, 2 setup error.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "check-plugin-tree: bun not found" >&2
  exit 2
fi

if [ ! -d "$ROOT/plugin" ]; then
  # plugin/ has landed; a missing tree now means a bad merge or a script that
  # deleted it wholesale — FAIL loudly rather than fail-open green.
  echo "check-plugin-tree: FAILED — committed plugin/ tree is missing. Regenerate: bun run scripts/generate-plugin-tree.ts --out plugin" >&2
  exit 1
fi

TMP="$(mktemp -d /tmp/gbrain-plugin-tree-XXXXXX)"
[ -n "$TMP" ] || { echo "check-plugin-tree: mktemp failed" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT

if ! bun run "$ROOT/scripts/generate-plugin-tree.ts" --out "$TMP/plugin" --variants-out "$TMP/plugin-variants" >/dev/null; then
  echo "check-plugin-tree: FAILED — generator reported a curation/gap violation (see above)" >&2
  exit 1
fi

if ! diff -r "$TMP/plugin" "$ROOT/plugin" >/dev/null 2>&1; then
  echo "check-plugin-tree: FAILED — committed plugin/ tree is stale." >&2
  echo "  Regenerate:  bun run scripts/generate-plugin-tree.ts --out plugin --variants-out plugin-variants" >&2
  echo "  Then stage:  git add plugin/ plugin-variants/" >&2
  diff -rq "$TMP/plugin" "$ROOT/plugin" 2>&1 | head -20 >&2
  exit 1
fi

# Persona variant trees (cathedral-7): same byte-diff posture. A missing
# committed plugin-variants/ after landing means a bad merge — fail loudly.
if [ ! -d "$ROOT/plugin-variants" ]; then
  echo "check-plugin-tree: FAILED — committed plugin-variants/ tree is missing. Regenerate: bun run scripts/generate-plugin-tree.ts --out plugin --variants-out plugin-variants" >&2
  exit 1
fi
if ! diff -r "$TMP/plugin-variants" "$ROOT/plugin-variants" >/dev/null 2>&1; then
  echo "check-plugin-tree: FAILED — committed plugin-variants/ tree is stale." >&2
  echo "  Regenerate:  bun run scripts/generate-plugin-tree.ts --out plugin --variants-out plugin-variants" >&2
  echo "  Then stage:  git add plugin/ plugin-variants/" >&2
  diff -rq "$TMP/plugin-variants" "$ROOT/plugin-variants" 2>&1 | head -20 >&2
  exit 1
fi

echo "check-plugin-tree: OK (committed plugin/ + plugin-variants/ trees match the generator)"
