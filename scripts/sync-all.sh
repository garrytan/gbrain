#!/bin/bash
# Manual sync: Apple Notes + Obsidian vault → gbrain
# Usage: bash scripts/sync-all.sh [--dry-run]

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

OB_VAULT='/Users/ryan/Library/Mobile Documents/iCloud~md~obsidian/Documents/Fun'
APPLE_EXPORT_DIR="${HOME}/.gbrain/apple-notes-export"

echo "=== gbrain sync-all ==="
echo ""

# ── 1. Apple Notes ──────────────────────────────────────────────
echo "[1/2] Apple Notes"
bash "$(dirname "$0")/export-apple-notes.sh" ${DRY_RUN:+--dry-run}
echo ""

# ── 2. Obsidian vault ───────────────────────────────────────────
echo "[2/2] Obsidian vault → $OB_VAULT"
if $DRY_RUN; then
  echo "  [dry-run] Would run: gbrain import \"$OB_VAULT\""
  FILE_COUNT=$(find "$OB_VAULT" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  echo "  Found $FILE_COUNT .md files"
else
  gbrain import "$OB_VAULT"
fi

echo ""
echo "=== Done ==="
