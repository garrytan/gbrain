#!/bin/bash
# run.sh <skill> <model> <eval.mjs command> [args...]: runs skill-diet's eval.mjs (pinned clone) for one skill and model.
set -euo pipefail
W=${EVAL_ROOT:?set EVAL_ROOT to the eval scratch root}
skill=$1 model=$2 cmd=$3; shift 3
dir=$W/evals/$skill/$model
mkdir -p "$dir/sk/before" "$W/tmp"
[ -e "$dir/adapter" ] || ln -s "$W/adapter.mjs" "$dir/adapter"
cp ${GBRAIN_REPO:-$PWD}/test/fixtures/skill-evals/$skill/tasks.json "$dir/tasks.json"
[ -d "$dir/sk/before/$skill" ] || cp -R "$W/before/$skill" "$dir/sk/before/$skill"
if [ -d "$W/after/$skill" ] && [ ! -d "$dir/sk/after/$skill" ]; then mkdir -p "$dir/sk/after" && cp -R "$W/after/$skill" "$dir/sk/after/$skill"; fi
export EVAL_ROOT="$W" EVAL_SKILL="$skill" PATH="$W/bin:$PATH" EVAL_AGENTS_BIN="$W/agents/node_modules/.bin" EVAL_SUPPORT_SKILLS="$W/support/$skill" \
  SKILL_EVAL_FIXTURES=${GBRAIN_REPO:-$PWD}/test/fixtures/skill-evals/$skill TMPDIR="$W/tmp" EVAL_LEDGER="$W/ledger.jsonl" \
  EVAL_SPEND_CAP="${EVAL_SPEND_CAP:-440}"
exec node "${SKILL_DIET:-$W/skill-diet}/scripts/eval.mjs" "$cmd" "$dir" --model "$model" "$@"
