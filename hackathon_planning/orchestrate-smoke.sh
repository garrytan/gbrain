#!/usr/bin/env bash
# orchestrate-smoke.sh — end-to-end smoke test for the Task 2 patient orchestrator
# on the LOCAL LM Studio / Qwen stack (see LOCAL-MODELS-SETUP.md).
#
# Validates the two things the unit tests can't (they use injected fakes):
#   1. `gbrain orchestrate`      — the REAL LLM skill selector picks the right
#                                  clinical skill for each patient input.
#   2. `gbrain orchestrate-run`  — the REAL subagent-job executor runs a skill and
#                                  the feedback loop terminates.
#
# Prereqs (per LOCAL-MODELS-SETUP.md):
#   - LM Studio serving a chat model on :1234 (e.g. openrouter:qwen/qwen3.6-27b)
#   - a brain with some patient data imported + embedded
#   - a running worker for step 2:  bun src/cli.ts jobs work   (in another shell)
# Run gbrain FROM SOURCE (bun src/cli.ts), NOT the compiled bin.
#
# Usage:  bash hackathon_planning/orchestrate-smoke.sh
# Env:    GBRAIN="bun src/cli.ts"   CHAT_MODEL="openrouter:qwen/qwen3.6-27b"
set -uo pipefail

GBRAIN="${GBRAIN:-bun src/cli.ts}"
CHAT_MODEL="${CHAT_MODEL:-openrouter:qwen/qwen3.6-27b}"
PASS=0
FAIL=0

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# Extract a JSON field from stdin via bun (guaranteed in the dev container).
jget() { bun -e "const j=JSON.parse(await Bun.stdin.text());const f=process.argv[1].split('.').reduce((o,k)=>o?.[k?.match(/^\d+$/)?Number(k):k],j);console.log(f??'')" "$1"; }

check_top() { # input, expected_skill
  local input="$1" expected="$2" out top
  out="$($GBRAIN orchestrate "$input" --json 2>/dev/null)"
  top="$(printf '%s' "$out" | jget 'recommendations.0.skill')"
  if [ "$top" = "$expected" ]; then
    printf '  \033[32mPASS\033[0m top=%s  «%s»\n' "$top" "$input"; PASS=$((PASS+1))
  else
    printf '  \033[31mFAIL\033[0m top=%s (expected %s)  «%s»\n' "${top:-<none>}" "$expected" "$input"; FAIL=$((FAIL+1))
  fi
}

hr "1. Skill selection (real LLM selector via gbrain orchestrate)"
# Same intents as test/fixtures/orchestrator-routing-cases.ts, against real seed skills.
check_top "reports chest pain and shortness of breath, needs vital signs" "nurse-triage"
check_top "expressing suicidal thoughts, self-harm and depression"        "psych-risk-screen"
check_top "needs a medication list and allergies check"                    "patient-history-review"

hr "2. Generic input is never routed patient data"
GEN="$($GBRAIN orchestrate "please run a keyword search in the system" --json 2>/dev/null)"
GEN_TOP="$(printf '%s' "$GEN" | jget 'recommendations.0.skill')"
GEN_EXCL="$(printf '%s' "$GEN" | jget 'excluded_generic.0')"
if [ -z "$GEN_TOP" ]; then printf '  \033[32mPASS\033[0m no clinical skill routed; excluded_generic present=%s\n' "${GEN_EXCL:-none}"; PASS=$((PASS+1));
else printf '  \033[31mFAIL\033[0m routed %s to a generic input\n' "$GEN_TOP"; FAIL=$((FAIL+1)); fi

hr "3. Execution + feedback loop (real subagent jobs via gbrain orchestrate-run)"
echo "  (needs a running worker: bun src/cli.ts jobs work)"
RUN="$($GBRAIN orchestrate-run "reports chest pain and shortness of breath" --model "$CHAT_MODEL" --max_rounds 2 --json 2>/dev/null)"
STOPPED="$(printf '%s' "$RUN" | jget 'stopped')"
RAN="$(printf '%s' "$RUN" | jget 'priorSkillOutputs.0.skill')"
if [ -n "$STOPPED" ]; then
  printf '  \033[32mPASS\033[0m loop terminated (stopped=%s, first executed=%s)\n' "$STOPPED" "${RAN:-none}"; PASS=$((PASS+1))
else
  printf '  \033[31mFAIL\033[0m orchestrate-run produced no result (worker running? model reachable?)\n'; FAIL=$((FAIL+1))
fi

hr "Summary"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
