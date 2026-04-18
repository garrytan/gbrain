#!/usr/bin/env bash
set -euo pipefail
source /home/tt/workspace/tools/gbrain/scripts/tt-curated/common.sh

VAULT_ROOT="/home/tt/obsidian-vault"
TMP_STAGE="$CURATED_STAGE.tmp"

rm -rf "$TMP_STAGE"
mkdir -p "$TMP_STAGE"

copy_if_exists() {
  local src="$1"
  local dst_dir="$2"
  if [[ -e "$src" ]]; then
    mkdir -p "$dst_dir"
    cp -R "$src" "$dst_dir/"
  fi
}

copy_if_exists "$VAULT_ROOT/knowledge" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/docs" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/agents" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/hackathons" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/plans" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/reviews" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/README.md" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/TAG_STRATEGY.md" "$TMP_STAGE"
copy_if_exists "$VAULT_ROOT/ZETTELKASTEN_GUIDE.md" "$TMP_STAGE"

rm -rf "$CURATED_STAGE"
mv "$TMP_STAGE" "$CURATED_STAGE"

count=$(find "$CURATED_STAGE" -type f -name '*.md' | wc -l | tr -d ' ')
echo "curated stage refreshed: $CURATED_STAGE ($count markdown files)"
