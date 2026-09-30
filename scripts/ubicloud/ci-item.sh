#!/usr/bin/env bash
# scripts/ubicloud/ci-item.sh — run one batch of CI work items on a VM
# bootstrapped by setup-ci-vm.sh. Invoked by scripts/ci-ubicloud.ts:
#
#   SLOT=N bash scripts/ubicloud/ci-item.sh <lane> [FILE...]
#
# Lanes reuse the ci:local wrappers, one wrapper invocation per file:
#   unit     scripts/run-unit-shard.sh FILE    (DATABASE_URL unset)
#   serial   scripts/run-serial-tests.sh FILE  (DATABASE_URL unset)
#   slow     scripts/run-slow-tests.sh FILE    (DATABASE_URL unset)
#   e2e      scripts/run-e2e.sh FILE against this slot's own postgres + pgbouncer
#            (backend-matrix files also run through the slot's pgbouncer)
#   verify   check-bun-test-timeout.sh + bun run verify (no FILE)
#   gitleaks the ci:local host scans (no FILE)
#
# Every item is bracketed by marker lines the orchestrator parses:
#   __ubi_item_begin__ <lane> <file>
#   __ubi_item__ rc=<exit> ms=<duration> lane=<lane> file=<file>
set -uo pipefail

cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$PATH"

lane="${1:?usage: ci-item.sh <lane> [FILE...]}"
shift
slot="${SLOT:?SLOT is required}"
unset SLOT

# The environment ci:local's runner container gives every lane.
export GBRAIN_CI_DISABLE_TEST_ENV_FILE=1
export GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar
export GBRAIN_TEST_TIMEOUT_MULTIPLIER="${GBRAIN_TEST_TIMEOUT_MULTIPLIER:-6}"
# Pull-request scale for export-scale.slow.test.ts; the 100,001-page run is master CI's.
export GBRAIN_TEST_EXPORT_SCALE_PAGES="${GBRAIN_TEST_EXPORT_SCALE_PAGES:-10001}"
unset DATABASE_URL GBRAIN_DATABASE_URL

# Throwaway password of the loopback-only slot servers setup-ci-vm.sh starts.
pg_password=postgres
pg="postgresql://postgres:${pg_password}@127.0.0.1:$((15432 + slot))"
pgb="postgresql://postgres:${pg_password}@127.0.0.1:$((16432 + slot))"

run_item() {
  case "$lane" in
    unit) bash scripts/run-unit-shard.sh "$1" ;;
    serial) bash scripts/run-serial-tests.sh "$1" ;;
    slow) bash scripts/run-slow-tests.sh "$1" ;;
    e2e)
      DATABASE_URL="$pg/gbrain_test" \
      GBRAIN_PGBOUNCER_URL="$pgb/gbrain_pgbouncer_test" \
      GBRAIN_PGBOUNCER_DIRECT_URL="$pg/gbrain_test" \
      GBRAIN_PGBOUNCER_E2E_URL="$pgb/gbrain_test?prepare=false" \
      GBRAIN_CI_REQUIRE_PGBOUNCER=1 \
      GBRAIN_TEST_DB=1 \
      bash scripts/run-e2e.sh "$1"
      ;;
    verify) bash scripts/check-bun-test-timeout.sh && bun run verify ;;
    gitleaks)
      bash scripts/test-gitleaks-config.sh &&
        bash scripts/scan-worktree-secrets.sh &&
        gitleaks git . --redact --no-banner --log-opts="origin/master..HEAD"
      ;;
    *) echo "ci-item: unknown lane '$lane'" >&2; return 2 ;;
  esac
}

items=("$@")
[ "${#items[@]}" -gt 0 ] || items=("-")
for item in "${items[@]}"; do
  echo "__ubi_item_begin__ $lane $item"
  start=$(date +%s%3N)
  run_item "$item" 2>&1
  rc=$?
  echo "__ubi_item__ rc=$rc ms=$(( $(date +%s%3N) - start )) lane=$lane file=$item"
done
