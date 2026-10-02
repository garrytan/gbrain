#!/usr/bin/env bash
# System One LongMemEval matched arms (S1 recall experiment, S2, S3, S3+S5, S4).
#
#   bash docs/eval/system-one/runners/lme-arms.sh <phase>
#
# Phases: data | s-retrieval | s-decide | m-retrieval | s-judged
# Same commit, same questions, same embed cache per shard, same seedless
# deterministic retrieval; only the arm flags differ. Output under $OUT.
# Needs OPENAI_API_KEY (embeddings, judge), VOYAGE_API_KEY (today's
# reranker), JEV_TYPESAFE_API_KEY or TYPESAFE_API_KEY (Jev), ANTHROPIC_API_KEY
# (expansion, reader).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
OUT="${OUT:-$HOME/lme-out}"
DS="${DS:-$HOME/datasets}"
SHARDS="${SHARDS:-8}"
CAL="${CAL:-$ROOT/docs/eval/system-one/receipts/calibrations}"
LISTS="$ROOT/docs/eval/system-one/datasets/longmemeval"
export GBRAIN_HOME="${GBRAIN_HOME:-$HOME/gbhome}"
mkdir -p "$OUT" "$DS"
G="bun src/cli.ts"
COMMON=(--top-k 5 --by-type --no-trajectory --mode balanced --autocut off --capture-pool)

shard_ids() { # list-name -> $OUT/shards/<list>.<k>
  local list=$1
  mkdir -p "$OUT/shards"
  [ -f "$OUT/shards/$list.00" ] || split -n "r/$SHARDS" -d -a 2 "$LISTS/$list.txt" "$OUT/shards/$list."
}

run_arm() { # arm-name list dataset-file embed-model -- flags...
  local name=$1 list=$2 file=$3 emb=$4; shift 5
  shard_ids "$list"
  if [ -f "$OUT/$name.done" ]; then echo "[$name] already done"; return; fi
  echo "[$name] start $(date -u +%T)"
  local start=$(date +%s)
  for f in "$OUT/shards/$list".*; do
    local k=${f##*.}
    GBRAIN_EMBEDDING_MODEL="$emb" GBRAIN_EMBEDDING_DIMENSIONS=1536 \
      $G eval longmemeval "$file" "${COMMON[@]}" --question-ids "$f" --embed-cache "$OUT/cache-$list-$k.sqlite" "$@" \
      --output "$OUT/$name.$k.ndjson" > "$OUT/$name.$k.log" 2>&1 &
  done
  wait
  echo "$(( $(date +%s) - start ))" > "$OUT/$name.done"
  echo "[$name] done in $(cat "$OUT/$name.done")s; errors: $(grep -h 'errors' "$OUT/$name".*.log | grep -o '[0-9]* errors' | tr '\n' ' ')"
}

S="$DS/longmemeval_s_cleaned.json"
M="$DS/longmemeval_m_pilot28.json"
L=openai:text-embedding-3-large
SM=openai:text-embedding-3-small
JEV=(--decide rerank=on)

case "${1:-}" in
  data)
    [ -f "$S" ] || curl -sSLo "$S" https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
    if [ ! -f "$M" ]; then
      curl -sSLo "$DS/longmemeval_m_cleaned.json" https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_m_cleaned.json
      python3 - "$DS/longmemeval_m_cleaned.json" "$LISTS/m-pilot-28.txt" "$M" <<'EOF'
import json, sys
want = set(l.strip() for l in open(sys.argv[2]) if l.strip())
rows = [q for q in json.load(open(sys.argv[1])) if q["question_id"] in want]
json.dump(rows, open(sys.argv[3], "w"))
print(len(rows), "M pilot questions")
EOF
      rm -f "$DS/longmemeval_m_cleaned.json"
    fi
    [ -f "$DS/s3-evidence.jsonl" ] || $G decide dataset --slot evidence --from longmemeval "$S" --out "$DS/s3-evidence.jsonl"
    sha256sum "$S" "$M" "$DS/s3-evidence.jsonl"
    ;;
  s-retrieval)
    R=(--retrieval-only)
    run_arm s_off      s-eval-half "$S" $L -- "${R[@]}" --reranker off
    run_arm s_voy30    s-eval-half "$S" $L -- "${R[@]}" --reranker on
    run_arm s_voy100   s-eval-half "$S" $L -- "${R[@]}" --reranker on --eval-pool-depth 100
    run_arm s_jev30    s-eval-half "$S" $L -- "${R[@]}" "${JEV[@]}" --search-pin search.reranker.top_n_in=30
    run_arm s_jev50    s-eval-half "$S" $L -- "${R[@]}" "${JEV[@]}" --search-pin search.reranker.top_n_in=50
    run_arm s_jev100   s-eval-half "$S" $L -- "${R[@]}" "${JEV[@]}" --eval-pool-depth 100
    run_arm s_jev100x  s-eval-half "$S" $L -- "${R[@]}" "${JEV[@]}" --eval-pool-depth 100 --expansion
    run_arm s_jev100b  s-eval-half "$S" $L -- "${R[@]}" "${JEV[@]}" --eval-pool-depth 100
    ;;
  s-decide)
    R=(--retrieval-only)
    run_arm s_s2       s-eval-half "$S" $L -- "${R[@]}" --reranker on --decide intent=on --decide-threshold intent=0.98
    # S3's calibrated threshold (recall >= 0.98 on the calibrate half) is 0.02, which never prunes under the 0.05
    # margin; 0.08 is the lowest acting threshold (family lb 0.869 on the eval half, below the 0.90 gate), so the
    # acting arms run it with force_on to measure what pruning costs and saves.
    run_arm s_s3       s-eval-half "$S" $L -- "${R[@]}" --reranker on --decide evidence=on --decide-threshold evidence=0.08 --decide-force-on evidence
    run_arm s_s3s5     s-eval-half "$S" $L -- "${R[@]}" --reranker on --decide evidence=on --decide injection=on --decide-threshold evidence=0.08 --decide-threshold injection=0.65 --decide-force-on evidence
    ;;
  m-retrieval)
    R=(--retrieval-only)
    run_arm m_off      m-pilot-28 "$M" $SM -- "${R[@]}" --reranker off --eval-pool-depth 300
    run_arm m_voy30    m-pilot-28 "$M" $SM -- "${R[@]}" --reranker on
    run_arm m_jev100   m-pilot-28 "$M" $SM -- "${R[@]}" "${JEV[@]}" --eval-pool-depth 100
    run_arm m_jev300   m-pilot-28 "$M" $SM -- "${R[@]}" "${JEV[@]}" --eval-pool-depth 300
    run_arm m_jev100x  m-pilot-28 "$M" $SM -- "${R[@]}" "${JEV[@]}" --eval-pool-depth 100 --expansion
    ;;
  s-judged)
    J=(--model anthropic:claude-haiku-4-5 --judge --judge-model openai:gpt-4o --max-usd 4 --yes --include-abstention)
    run_arm j_voy30    s-eval-judged-100 "$S" $L -- "${J[@]}" --reranker on
    run_arm j_jev30    s-eval-judged-100 "$S" $L -- "${J[@]}" "${JEV[@]}" --search-pin search.reranker.top_n_in=30
    ;;
  *) echo "usage: $0 data|s-retrieval|s-decide|m-retrieval|s-judged"; exit 2 ;;
esac
