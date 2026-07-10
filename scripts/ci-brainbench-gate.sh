#!/usr/bin/env bash
# BrainBench CI gate (Cathedral 2, decision 4) — local parity with the
# .github/workflows/test.yml `brainbench` job.
#
# Governance: the gate compares HEAD's run against MAIN's copy of the
# committed baseline (git show origin/master:...), NEVER the working tree's —
# a PR cannot rewrite the thing it is compared against. Two modes resolve
# automatically inside `eval brainbench --compare`:
#   same fixtures_hash  → count-aware gate (any newly-failed gold item fails)
#   different hash      → corpus-bless (the PR's committed baseline must
#                         exactly match HEAD's run; regressions vs main need
#                         a `justification` in the committed baseline)
#
# Exit codes pass through: 0 pass · 1 regression · 2 error/inconclusive.

set -euo pipefail

BASELINE_PATH="evals/brainbench/baselines/main.json"
MAIN_REF="${BRAINBENCH_MAIN_REF:-origin/master}"
# mktemp default (review finding): a fixed world-writable /tmp path is a
# symlink-planting target on shared hosts. CI overrides via BRAINBENCH_OUT.
if [ -n "${BRAINBENCH_OUT:-}" ]; then
  OUT="$BRAINBENCH_OUT"
  OUT_IS_TEMP=0
else
  OUT="$(mktemp /tmp/brainbench-result-XXXXXX.json)"
  OUT_IS_TEMP=1
fi
MAIN_BASELINE="$(mktemp /tmp/brainbench-main-baseline-XXXXXX.json)"
cleanup() {
  rm -f "$MAIN_BASELINE"
  [ "$OUT_IS_TEMP" = "1" ] && rm -f "$OUT" || true
}
trap cleanup EXIT

# Fail HARD when the ref itself is broken — only a genuinely-absent baseline
# may take the ungated first-landing path (review finding: an unfetched ref
# or typo'd BRAINBENCH_MAIN_REF must not silently disable the gate).
if ! git rev-parse --verify --quiet "${MAIN_REF}^{commit}" > /dev/null; then
  echo "[brainbench-gate] ERROR: ref ${MAIN_REF} does not resolve — fetch it or fix BRAINBENCH_MAIN_REF" >&2
  exit 2
fi

if git show "${MAIN_REF}:${BASELINE_PATH}" > "$MAIN_BASELINE" 2>/dev/null; then
  # Deletion defense (red-team finding): if main carries a baseline but the
  # working tree deleted it, every FUTURE PR would take the ungated
  # first-landing path once this one merges. Refuse.
  if [ ! -f "$BASELINE_PATH" ]; then
    echo "[brainbench-gate] ERROR: ${BASELINE_PATH} exists on ${MAIN_REF} but is deleted in this tree — restore it or re-run --update-baseline" >&2
    exit 2
  fi
  echo "[brainbench-gate] comparing against ${MAIN_REF}:${BASELINE_PATH}"
  bun src/cli.ts eval brainbench --compare "$MAIN_BASELINE" --out "$OUT"
else
  # First landing: the ref exists but carries no baseline yet. The COMMITTED
  # baseline still gets verified against the actual run (codex adversarial
  # finding: an unverified first landing could seed a doctored baseline for
  # every future PR to compare against). Same-hash + committed==run logic
  # inside --compare does the verification.
  if [ -f "$BASELINE_PATH" ]; then
    echo "[brainbench-gate] no baseline on ${MAIN_REF} yet — verifying the run against the COMMITTED baseline (first-landing path)"
    bun src/cli.ts eval brainbench --compare "$BASELINE_PATH" --out "$OUT"
  else
    echo "[brainbench-gate] no baseline on ${MAIN_REF} and none committed — running ungated (pre-baseline tree)"
    bun src/cli.ts eval brainbench --out "$OUT"
  fi
fi
