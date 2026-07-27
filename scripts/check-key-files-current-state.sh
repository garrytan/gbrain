#!/usr/bin/env bash
# scripts/check-key-files-current-state.sh — the anti-disease guard.
#
# CLAUDE.md grew to ~592KB / ~147k tokens (auto-loaded every session) once its
# per-file index became append-only: one `**vX.Y.Z (#NNN):**` clause per release
# per file. This guard makes that recurrence structurally impossible. A written
# rule caused the disease; a CI guard cures it.
#
# TWO HARD GATES (fail the build):
#   1. Bolded-release-clause ban — the reference docs (docs/architecture/KEY_FILES.md,
#      docs/architecture/thin-client.md, docs/TESTING.md) describe CURRENT behavior
#      only. Release history lives in CHANGELOG.md + git. The bolded `**v0.<digit>`
#      marker is the disease signature; it must not appear in those docs. Plain prose
#      ("as of pgvector 0.7", "Postgres 11+") is fine — only the bolded release
#      marker is banned, so this never false-fires on legitimate version mentions.
#   2. CLAUDE.md size cap — the structural backstop. Even if someone ignores the
#      prose rule and pads CLAUDE.md, the size gate catches it.
#
# SOFT WARNS (stderr, non-fatal): prose history markers that suggest narration
# creeping back ("pre-fix", ", then v0.", "superseded by") in the reference docs.
#
# Usage:
#   bash scripts/check-key-files-current-state.sh
#
# Env overrides (for the guard's own test):
#   GBRAIN_DOC_GUARD_ROOT        repo root to scan (default: script's ../)
#   GBRAIN_CLAUDE_MD_MAX_BYTES   CLAUDE.md hard cap (default: 60000; post-restructure
#                                CLAUDE.md is ~39KB, so this leaves headroom while
#                                staying far below the ~592KB disease state)
#
# Exit codes:
#   0   clean
#   1   a hard gate failed

set -uo pipefail

ROOT="${GBRAIN_DOC_GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
MAX_BYTES="${GBRAIN_CLAUDE_MD_MAX_BYTES:-60000}"

# Reference docs that MUST stay current-state (history-free).
REFERENCE_DOCS=(
  "docs/architecture/KEY_FILES.md"
  "docs/architecture/thin-client.md"
  "docs/TESTING.md"
)

fail=0

# ── Gate 1: bolded release-clause ban ──────────────────────────────────────
for rel in "${REFERENCE_DOCS[@]}"; do
  doc="$ROOT/$rel"
  [ -f "$doc" ] || continue
  hits=$(grep -nE '\*\*v0\.[0-9]' "$doc" || true)
  if [ -n "$hits" ]; then
    fail=1
    echo "FAIL: $rel contains bolded release-clause markers (append-only history is the disease this guard prevents)." >&2
    echo "      Reference docs describe CURRENT behavior only; release history goes in CHANGELOG.md + git." >&2
    echo "      Collapse each version-clause chain into the single current truth. Offending lines:" >&2
    printf '%s\n' "$hits" | sed 's/^/        /' | cut -c1-140 >&2
  fi
done

# ── Gate 2: CLAUDE.md size cap ─────────────────────────────────────────────
claude="$ROOT/CLAUDE.md"
if [ -f "$claude" ]; then
  bytes=$(wc -c < "$claude" | tr -d ' ')
  if [ "$bytes" -gt "$MAX_BYTES" ]; then
    fail=1
    echo "FAIL: CLAUDE.md is $bytes bytes, over the $MAX_BYTES cap." >&2
    echo "      CLAUDE.md is orientation + resolver, not the implementation spec. Per-file/" >&2
    echo "      per-command/per-test detail belongs in the on-demand reference docs" >&2
    echo "      (docs/architecture/KEY_FILES.md, docs/TESTING.md, docs/RELEASING.md), not here." >&2
  fi
fi

# ── Soft warns: prose history markers creeping into reference docs ──────────
for rel in "${REFERENCE_DOCS[@]}"; do
  doc="$ROOT/$rel"
  [ -f "$doc" ] || continue
  warns=$(grep -cnE ', then v0\.|superseded by|pre-fix|post-fix' "$doc" || true)
  if [ "${warns:-0}" -gt 0 ]; then
    echo "WARN: $rel has $warns prose history marker(s) ('pre-fix' / ', then v0.' / 'superseded by'). Prefer current-state phrasing." >&2
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-key-files-current-state: ok (reference docs history-free; CLAUDE.md within cap)"
