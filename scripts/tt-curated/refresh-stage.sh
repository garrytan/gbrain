#!/usr/bin/env bash
set -euo pipefail
source /home/tt/workspace/tools/gbrain/scripts/tt-curated/common.sh

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

mapfile -t INCLUDE_PATHS < <(/usr/bin/python3 - <<'PY' "$CURATED_INCLUDE_PATHS_JSON"
import json, sys
for item in json.loads(sys.argv[1]):
    print(item)
PY
)

mapfile -t INCLUDE_FILES < <(/usr/bin/python3 - <<'PY' "$CURATED_INCLUDE_FILES_JSON"
import json, sys
for item in json.loads(sys.argv[1]):
    print(item)
PY
)

for rel in "${INCLUDE_PATHS[@]}"; do
  copy_if_exists "$VAULT_ROOT/$rel" "$TMP_STAGE"
done

for rel in "${INCLUDE_FILES[@]}"; do
  copy_if_exists "$VAULT_ROOT/$rel" "$TMP_STAGE"
done

rm -rf "$CURATED_STAGE"
mv "$TMP_STAGE" "$CURATED_STAGE"

count=$(find "$CURATED_STAGE" -type f -name '*.md' | wc -l | tr -d ' ')
echo "curated stage refreshed: $CURATED_STAGE ($count markdown files)"
