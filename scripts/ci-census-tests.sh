#!/usr/bin/env bash
# The enumeration and census tests: the unit files that fail when a change adds
# an operation, command, flag, error code, doctor check, repair kind, caller or
# route without its reviewed entry, or changes a golden. They need no Postgres.
# The pull-request job enumeration-census-tests in .github/workflows/test.yml
# runs them, so a pull request finds these failures in minutes instead of in its
# full-ci run (docs/ci-event-parity.md#enumeration-and-census-tests).
#
# Usage:
#   bash scripts/ci-census-tests.sh                     print the files, one per line
#   bash scripts/ci-census-tests.sh --run               run every file
#   bash scripts/ci-census-tests.sh --run <k> <n>       run shard k of n (scripts/sharding.ts)
#
# The set, from tracked files under test/:
#   - source censuses: files marked test-reads-source-ok[structural]
#   - goldens: files that import test/helpers/golden
#   - enumeration lists: file names matching ENUMERATION below
#   - idle-pass statement bounds: test/persistence-consumer-*.test.ts files that mention idle
#   - tree walkers: tests that read every file under src/ or test/, named in WALKERS below
# minus test/e2e/ (Postgres), *.serial.test.ts and *.slow.test.ts (their own
# full-ci jobs) and test/setup.test.ts (about 7 minutes on its own).
set -euo pipefail
cd "$(dirname "$0")/.."

ENUMERATION='registry|inventory|catalog|coverage-ledger|operations-|behavior-change-notice|error-|exit-codes|fix-wave-5-integration|repair-explicit-only|cli-flag-validation|allowlist-drift|mcp-tool-defs|cli-flag-equals|remote-privacy-sweep|tool-catalog'

WALKERS='test-reads-source-smell|canonical-migration-command|db-guard-coverage|env-trust-protected-keys|no-valid-until-write|page-row-deleters-guard|persistence-mode-reader-guard|query-embed-call-sites|readiness-advice-lint|refresh-barrier-state-audit|scripts/serial-files|write-refusals-coverage|scripts/ci-census-tests|chronicle-upgrade-notice-5876|cli-cold-start-registries|cli-exit-verdict-pin|cli-socket\.test|connector-kind-routing|cycle-date-consistency|doctor-default-budget-6803|generations-deprecated-fact-writers|persistence-pipeline-first|persistence-true-up-sites|pg-tls\.test|postgres-inflight-budget-6543|query-expansion-phrasing-guard|receipt-coverage\.test|remediation-command-resolution|git-env-guard|engine-surface-coverage|run-unit-shard'

list() {
  {
    git grep -l 'test-reads-source-ok\[structural\]' -- test || true
    git grep -l helpers/golden -- test || true
    git ls-files test | grep -E "$ENUMERATION" || true
    git ls-files test | grep -E "$WALKERS" || true
    git grep -l -i idle -- 'test/persistence-consumer-*.test.ts' || true
  } | grep '\.test\.ts$' | grep -v -E '^test/e2e/|\.(serial|slow)\.test\.ts$|^test/setup\.test\.ts$' | LC_ALL=C sort -u
}

if [ "$#" -eq 0 ]; then
  list
  exit 0
fi
if [ "$1" != --run ] || { [ "$#" -ne 1 ] && [ "$#" -ne 3 ]; }; then
  echo "usage: bash scripts/ci-census-tests.sh [--run [<shard> <total>]]" >&2
  exit 2
fi

files=$(list)
if [ "$#" -eq 3 ]; then
  files=$(printf '%s\n' "$files" | bun run scripts/sharding.ts "$2" "$3")
fi
if [ -z "$files" ]; then
  echo "no census files selected" >&2
  exit 1
fi
echo "enumeration and census tests: $(printf '%s\n' "$files" | grep -c '^') files; $(printf '%s\n' "$files" | bun run scripts/sharding.ts --sum 2>/dev/null || echo 'predicted weight unavailable')"

# The unit phase never sees a database URL, in CI or here: a Postgres arm would
# turn this into a different run.
unset DATABASE_URL GBRAIN_DATABASE_URL
. scripts/lib/test-env.sh
ensure_pglite_snapshot census
# ./ makes each argument a path, run in the order given (see scripts/test-shard.sh).
printf '%s\n' "$files" | sed 's#^#./#' | xargs -n 100000 -x bun test --timeout=120000 --max-concurrency="${GBRAIN_TEST_MAX_CONCURRENCY:-4}"
