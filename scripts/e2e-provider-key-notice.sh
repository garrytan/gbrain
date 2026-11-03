#!/usr/bin/env bash
# scripts/e2e-provider-key-notice.sh — make keyless E2E coverage visible (GBRA-47 A9).
#
# e2e.yml passes the OPENAI_API_KEY / ANTHROPIC_API_KEY repo secrets to its
# key-gated jobs; when a secret is empty, the key-gated tests self-skip and
# the job still goes green. The test preload (test/helpers/provider-keys-preload.ts)
# also strips both keys from every test process unless the step that ran the
# tests set GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 (scripts/run-e2e.sh sets it, and
# so does the keyed Tier 2 nightly step). The workflow passes this step
# the value the test step had, so a run whose keys were stripped is never
# reported as keyed. This step says what happened in the log (::warning::) and
# the step summary. Exit 0 always: it reports, it does not gate.
set -euo pipefail

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
missing=()
[ -n "${OPENAI_API_KEY:-}" ] || missing+=(OPENAI_API_KEY)
[ -n "${ANTHROPIC_API_KEY:-}" ] || missing+=(ANTHROPIC_API_KEY)

if [ "${#missing[@]}" -gt 0 ]; then
  fix=$(printf 'gh secret set %s; ' "${missing[@]}")
  echo "::warning::Key-gated E2E tests skipped for missing keys: empty secret(s) ${missing[*]}. Why: only the repo owner can set secrets. Fix (owner-only): ${fix%; }"
  {
    echo "## Key-gated E2E tests skipped for missing keys"
    echo "Empty secret(s): ${missing[*]}. Tests gated on these keys self-skipped, so this job's green is keyless coverage only."
    echo ""
    echo "- Fix (owner-only): \`${fix%; }\`"
  } >> "$summary"
  exit 0
fi

if [ "${GBRAIN_TEST_KEEP_PROVIDER_KEYS:-}" != "1" ]; then
  echo "::warning::Key-gated E2E tests skipped: provider keys not passed (GBRAIN_TEST_KEEP_PROVIDER_KEYS unset). The secrets are set, but the test preload stripped them, so this job's green is keyless coverage only. A keyed run spends on the providers: set GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 on the test step only with that spend approved."
  {
    echo "## Key-gated E2E tests skipped: provider keys not passed"
    echo "GBRAIN_TEST_KEEP_PROVIDER_KEYS was unset on the test step, so the test preload stripped OPENAI_API_KEY and ANTHROPIC_API_KEY. This job's green is keyless coverage only."
  } >> "$summary"
  exit 0
fi

echo "Provider keys passed to the tests (OPENAI_API_KEY, ANTHROPIC_API_KEY, GBRAIN_TEST_KEEP_PROVIDER_KEYS=1): key-gated E2E tests ran keyed."
