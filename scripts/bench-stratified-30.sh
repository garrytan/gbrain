#!/usr/bin/env bash
# Loop /tmp/sample-pages.jsonl through bench-batched-synopsis.ts for 3 top models
# at B=1 + B=16. Writes per-page-per-model output to a stratified-30 subdir tree.
#
# Each model runs ALL pages before the next (avoids LM Studio model-swap thrash).
# Skip-if-exists logic: pages with both B=1 and B=16 outputs are skipped.
#
# Output: /tmp/bench-synopsis-out/{model_slug}/{bucket_pageN}-B{N}.json
# bucket_pageN = bucket name (xs/s/m/l) + page index (so files don't clash)
#
# Usage: ./scripts/bench-stratified-30.sh

set -euo pipefail
cd "$(dirname "$0")/.."

SAMPLE_FILE=${SAMPLE_FILE:-/tmp/sample-pages.jsonl}
MODELS=(
  "mistralai/devstral-small-2-2512"
  "qwen3-omni-30b-a3b-instruct@q4_k_m"
  "qwen/qwen3-coder-30b"
)
SIZES="1,16"

if [ ! -f "$SAMPLE_FILE" ]; then
  echo "ERROR: $SAMPLE_FILE not found" >&2
  echo "Generate via the SQL stratified-sample query that populates page slugs." >&2
  exit 1
fi

NUM_PAGES=$(wc -l < "$SAMPLE_FILE" | tr -d ' ')
NUM_MODELS=${#MODELS[@]}
echo "[stratified] $NUM_PAGES pages × $NUM_MODELS models × 2 sizes = $((NUM_PAGES * NUM_MODELS * 2)) bench runs"

for MODEL in "${MODELS[@]}"; do
  echo ""
  echo "============================================================"
  echo "============ MODEL: $MODEL"
  echo "============================================================"
  # Slugify the model id the same way bench-batched-synopsis.ts:outDir() does
  MODEL_SLUG=$(echo "lmstudio:$MODEL" | sed -E 's/[^a-zA-Z0-9-]+/_/g')
  MODEL_OUT_DIR="/tmp/bench-synopsis-out/$MODEL_SLUG"
  PAGE_IDX=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    PAGE_IDX=$((PAGE_IDX + 1))
    SLUG=$(echo "$line" | jq -r '.slug')
    SOURCE=$(echo "$line" | jq -r '.source_id')
    BUCKET=$(echo "$line" | jq -r '.bucket')
    CHUNKS=$(echo "$line" | jq -r '.text_chunks')
    PAGE_LABEL="${BUCKET}_p${PAGE_IDX}"

    # Skip if BOTH B=1 and B=16 outputs already exist for this page (no force re-run)
    B1_FILE="$MODEL_OUT_DIR/${PAGE_LABEL}-B1.json"
    B16_FILE="$MODEL_OUT_DIR/${PAGE_LABEL}-B16.json"
    if [ -f "$B1_FILE" ] && [ -f "$B16_FILE" ]; then
      echo "######### [$MODEL] page $PAGE_IDX/$NUM_PAGES [$BUCKET ${CHUNKS}ch] SKIP (output exists)"
      continue
    fi

    echo ""
    echo "######### [$MODEL] page $PAGE_IDX/$NUM_PAGES [$BUCKET ${CHUNKS}ch]"
    echo "######### slug: $SLUG"
    LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1 \
    GBRAIN_BENCH_CONTEXT_BUDGET=64000 \
    bun run scripts/bench-batched-synopsis.ts \
      --model "lmstudio:$MODEL" \
      --page "$SLUG" \
      --source "$SOURCE" \
      --bucket "$PAGE_LABEL" \
      --sizes "$SIZES" 2>&1 | tail -4 || echo "  [page failed, continuing]"
  done < "$SAMPLE_FILE"
done

echo ""
echo "[stratified] DONE. Output in /tmp/bench-synopsis-out/{model_slug}/*"
