#!/usr/bin/env bash
# test.yml cheap-tier aggregator (docs/ci-event-parity.md#full-ci-on-pull-requests).
# Inputs: job results in CHANGES GITLEAKS SECURITY AUDIT VERIFY TYPECHECK STRESS NATIVE
# PERSISTENCE, and the selectors NATIVE_SCOPE and CONVERGENCE.
# Every cheap lane must succeed. The native and persistence lanes may be
# skipped only when their selector left them out (native scope smoke,
# convergence skip); a selected lane that skipped, failed or was cancelled
# fails the tier. A lane gated by Trunk Dynamic CI (DCI_SECURITY DCI_STRESS
# DCI_NATIVE DCI_PERSISTENCE, docs/ci-event-parity.md#trunk-dynamic-ci) may also
# be skipped when its verdict is exactly 'false'; Learning mode never says
# 'false'. The step summary always says the full suite did not run.
set -euo pipefail

fail=0
trunk_skipped() {
  [ "$1" = skipped ] && [ "$2" = false ] || return 1
  echo "  skipped by Trunk Dynamic CI (verdict false)"
}
for row in "changes|${CHANGES:-}|" "gitleaks|${GITLEAKS:-}|" "security-regressions|${SECURITY:-}|${DCI_SECURITY:-}" "dependency-audit|${AUDIT:-}|" \
  "verify|${VERIFY:-}|" "typecheck|${TYPECHECK:-}|" "stress-changed-tests|${STRESS:-}|${DCI_STRESS:-}"; do
  IFS='|' read -r name result verdict <<< "$row"
  echo "$name=$result"
  if trunk_skipped "$result" "$verdict"; then continue; fi
  if [ "$result" != success ]; then echo "✗ $name did not succeed (got $result)"; fail=1; fi
done
lane() {
  local name=$1 result=$2 selected=$3 verdict=$4
  echo "$name=$result (selected=$selected)"
  if [ "$result" = success ]; then return 0; fi
  if [ "$result" = skipped ] && [ "$selected" = no ]; then return 0; fi
  if trunk_skipped "$result" "$verdict"; then return 0; fi
  echo "✗ $name did not succeed (got $result, selected=$selected)"
  fail=1
}
[ "${NATIVE_SCOPE:-}" = smoke ] && native_selected=no || native_selected=yes
[ "${CONVERGENCE:-}" = skip ] && persistence_selected=no || persistence_selected=yes
lane native-locks "${NATIVE:-}" "$native_selected" "${DCI_NATIVE:-}"
lane persistence-validation "${PERSISTENCE:-}" "$persistence_selected" "${DCI_PERSISTENCE:-}"

{
  echo "## Full suite not run"
  echo "This pull request ran the cheap tier: verify, typecheck, gitleaks, security regressions, the dependency audit, the stress gate on changed tests, and the persistence (selected: $persistence_selected) and native (selected: $native_selected) lanes its diff selects. Unit shards, serial, slow, the PostgreSQL arms and E2E did not run."
  echo "The full suite runs when a maintainer adds the \`full-ci\` label, which dispatches Test and E2E on the head branch (a thread can dispatch them itself). Merge requires the \`full-suite\` and \`e2e-full-suite\` checks on the exact head."
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "::notice::Full suite not run on this head (cheap tier). Merge requires full-suite from a full-ci run."

if [ "$fail" -ne 0 ]; then echo "✗ cheap tier failed"; exit 1; fi
echo "✓ cheap tier green (full suite not run)"
