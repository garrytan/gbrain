#!/usr/bin/env bash
# scripts/run-with-receipt.sh — run one named `bun test` invocation and record
# its executed-test receipt (X2) when GBRAIN_TEST_RECEIPT_DIR is set.
#
# CI jobs that call `bun test` directly (the slow lanes, Tier 1, Tier 2, the
# JSONB parity guard) go through this wrapper so every bun invocation leaves a
# receipt like the runner scripts do. Receipt format and consumers:
# scripts/lib/test-env.sh (receipts_init) and scripts/ci-executed-counts.ts.
#
# Usage:
#   bash scripts/run-with-receipt.sh <lane> <tag> -- bun [--no-env-file] test --timeout=N [args] <files...>
#
# <lane> names the identity lane (unit, slow, tier1, ...); <tag> must be unique
# per invocation inside that lane. Test files are the *.test.ts arguments.
# Without GBRAIN_TEST_RECEIPT_DIR the command runs unchanged. Exit code: the
# command's.

set -euo pipefail

bun_flag=""
if [ "${5:-}" = "--no-env-file" ]; then
  bun_flag=--no-env-file
  set -- "$1" "$2" "$3" "$4" "${@:6}"
fi
if [ "$#" -lt 5 ] || [ "$3" != "--" ] || [ "$4" != "bun" ] || [ "$5" != "test" ]; then
  echo "usage: bash scripts/run-with-receipt.sh <lane> <tag> -- bun [--no-env-file] test --timeout=N [args] <files...>" >&2
  exit 2
fi
lane="$1"
tag="$2"
shift 4

cd "$(dirname "$0")/.."
GBRAIN_TEST_RECEIPT_LANE="$lane"
. scripts/lib/test-env.sh
receipts_init "$lane" || exit 2

shift
files=()
has_timeout=0
for arg in "$@"; do
  case "$arg" in
    *.test.ts) files+=("${arg#./}") ;;
    --timeout|--timeout=*) has_timeout=1 ;;
  esac
done
if [ "$has_timeout" = "0" ]; then
  echo "run-with-receipt: pass an explicit --timeout (scripts/check-bun-test-timeout.sh explains why)" >&2
  exit 2
fi
if [ "${#files[@]}" -eq 0 ]; then
  echo "run-with-receipt: no *.test.ts file arguments; a receipt needs the files the invocation runs" >&2
  exit 2
fi

receipt_begin primary "$tag" "" "" "" "${files[@]}"
rc=0
bun $bun_flag test ${RECEIPT_ARGS[@]+"${RECEIPT_ARGS[@]}"} "$@" || rc=$?  # "$@" carries --timeout (refused above otherwise)
receipt_end "$rc"
exit "$rc"
