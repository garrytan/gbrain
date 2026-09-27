#!/usr/bin/env bash
# scripts/run-unit-shard.sh
#
# Runs the unit suite for a single shard. Excludes test/e2e/* (those are run
# by scripts/run-e2e.sh in the E2E phase). When SHARD=N/M is set, keeps every
# weighted partition N (1-indexed); otherwise runs the full unit set.
#
# Used by scripts/ci-local.sh to fan 4 unit-shard workers in parallel inside
# the runner container, each pinned to its own postgres shard for the
# downstream E2E phase.
#
# One Bun process per file within a shard;
# parallel across shards (4 of these run concurrently).

set -euo pipefail

RUNNER_SHARD="${SHARD:-}"
unset SHARD

# #3485: unit/slow tests need no database — strip ambient DB URLs at this
# wrapper boundary so the bunfig preload guard passes and nothing can reach a
# real brain. The e2e wrapper (run-e2e.sh) is the only lane that keeps them.
unset DATABASE_URL GBRAIN_DATABASE_URL
# An ambient GBRAIN_HOME (a dev shell configured for a real brain) must not
# reach unit tests either: the gbrain-home-preload respects a pre-set value
# (the e2e wrapper needs that), so strip it at this boundary and let the
# preload allocate per-run scratch instead.
unset GBRAIN_HOME

cd "$(dirname "$0")/.."

# --max-concurrency=N is forwarded to `bun test`. v0.26.4: invoked by
# run-unit-parallel.sh; safe to call without (defaults to bun's default cap).
MAX_CONC=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-concurrency) MAX_CONC="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONC="${1#*=}"; shift ;;
    --dry-run-list) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# All non-E2E test files, sorted for deterministic shard splits.
# Tier 4: *.slow.test.ts is "always-slow" (cold-path correctness checks);
# *.serial.test.ts is "concurrency-unsafe" (file-wide shared state). Both
# are excluded from the fast loop. Slow runs via `bun run test:slow`; serial
# runs via scripts/run-serial-tests.sh after the parallel pass.
# Use while-read to stay portable to macOS bash 3.2 (no mapfile).
all_files=()
while IFS= read -r f; do
  all_files+=("$f")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' -not -name '*.serial.test.ts' | sort)

files=()
if [ -n "$RUNNER_SHARD" ]; then
  shard_n=${RUNNER_SHARD%/*}
  shard_m=${RUNNER_SHARD#*/}
  if ! [[ "$RUNNER_SHARD" =~ ^[0-9]+/[0-9]+$ ]] || ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$RUNNER_SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  selected=$(printf '%s\n' "${all_files[@]}" | bun scripts/sharding.ts "$shard_n" "$shard_m")
  while IFS= read -r f; do
    [ -n "$f" ] && files+=("$f")
  done <<< "$selected"
else
  files=("${all_files[@]}")
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "[unit-shard ${RUNNER_SHARD:-(unsharded)}] no files; exiting clean."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

# #4479: per-shard timeout multiplier. 4-way shard contention in the CI
# container makes subprocess/PGLite tests ~6x slower per file than native,
# producing timeout-class failures that pass natively. The 60s per-test
# ceiling scales by GBRAIN_TEST_TIMEOUT_MULTIPLIER (integer, default 1;
# ci-local's container lane sets it). Non-integer values fall back to 1.
MULT="${GBRAIN_TEST_TIMEOUT_MULTIPLIER:-1}"
if ! printf '%s' "$MULT" | grep -qE '^[0-9]+$' || [ "$MULT" -lt 1 ]; then
  MULT=1
fi
TEST_TIMEOUT_MS=$((60000 * MULT))

echo "[unit-shard ${RUNNER_SHARD:-(unsharded)}] running ${#files[@]} files (timeout=${TEST_TIMEOUT_MS}ms)"
# Do not retain runtime/module state across file boundaries. Keep the existing
# worker count and attempt every selected file after ordinary failures.
GROUP_SIZE=1
GROUPS_TOTAL=$(( (${#files[@]} + GROUP_SIZE - 1) / GROUP_SIZE ))
GROUP_LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-unit-groups.XXXXXX")
trap 'rm -rf "$GROUP_LOG_DIR"' EXIT
TEST_ARGS=(test)
[ -z "$MAX_CONC" ] || TEST_ARGS+=("--max-concurrency=$MAX_CONC")
TEST_ARGS+=("--timeout=$TEST_TIMEOUT_MS")
TOTAL_RC=0
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
COMPLETE_GROUPS=0
ESC=$(printf '\033')
for ((offset=0, group=1; offset<${#files[@]}; offset+=GROUP_SIZE, group++)); do
  group_files=("${files[@]:offset:GROUP_SIZE}")
  log="$GROUP_LOG_DIR/$group.log"
  printf '%s\n' "${group_files[@]}" > "$GROUP_LOG_DIR/$group.assigned"
  echo "__gbrain_unit_group_start__ group=$group/$GROUPS_TOTAL files=${#group_files[@]}"
  set +e
  bun "${TEST_ARGS[@]}" "${group_files[@]}" 2>&1 | tee "$log"
  statuses=("${PIPESTATUS[@]}")
  set -e
  bun_rc=${statuses[0]}
  tee_rc=${statuses[1]}
  sed "s/${ESC}\\[[0-9;]*[a-zA-Z]//g" "$log" > "$GROUP_LOG_DIR/$group.clean"
  # Child tests can print their own Bun summaries. Use the final block, require
  # its exact selected-file count, and independently check every file header.
  read -r summary_ok pass_count fail_count skip_count missing_count < <(awk '
    FNR == NR { expected[$0] = 1; selected++; next }
    {
      header = $0; sub(/^::group::/, "", header); sub(/:$/, "", header)
      if (header in expected) seen[header] = 1
    }
    $1 ~ /^[0-9]+$/ && $2 == "pass" { p = $1; have_p = 1 }
    $1 ~ /^[0-9]+$/ && $2 == "fail" { f = $1; have_f = 1 }
    $1 ~ /^[0-9]+$/ && $2 == "skip" { s = $1 }
    /^Ran [0-9]+ tests? across [0-9]+ files?\./ {
      valid = have_p && have_f && $5 == selected
      last_p = p; last_f = f; last_s = s
      p = f = s = have_p = have_f = 0
    }
    END {
      for (file in expected) if (!(file in seen)) missing++
      ok = valid && !missing
      print ok + 0, ok ? last_p + 0 : 0, ok ? last_f + 0 : 0, ok ? last_s + 0 : 0, missing + 0
    }
  ' "$GROUP_LOG_DIR/$group.assigned" "$GROUP_LOG_DIR/$group.clean")
  group_rc=0
  if [ "$bun_rc" -ne 0 ] || [ "$tee_rc" -ne 0 ] || [ "$summary_ok" -ne 1 ] || [ "$fail_count" -ne 0 ]; then
    group_rc=1
    TOTAL_RC=1
  fi
  if [ "$summary_ok" -eq 1 ]; then
    COMPLETE_GROUPS=$((COMPLETE_GROUPS + 1))
    TOTAL_PASS=$((TOTAL_PASS + pass_count))
    TOTAL_FAIL=$((TOTAL_FAIL + fail_count))
    TOTAL_SKIP=$((TOTAL_SKIP + skip_count))
  else
    echo "[unit-shard] group $group/$GROUPS_TOTAL incomplete: missing or mismatched Bun summary/file census; missing_headers=$missing_count" >&2
  fi
  echo "__gbrain_unit_group__ group=$group/$GROUPS_TOTAL files=${#group_files[@]} bun_rc=$bun_rc tee_rc=$tee_rc complete=$summary_ok pass=$pass_count fail=$fail_count skip=$skip_count rc=$group_rc"
done
# Distinct from native Bun summary syntax: consumers must not count these twice.
echo "__gbrain_unit_shard__ groups=$GROUPS_TOTAL complete_groups=$COMPLETE_GROUPS files=${#files[@]} pass=$TOTAL_PASS fail=$TOTAL_FAIL skip=$TOTAL_SKIP rc=$TOTAL_RC"
exit "$TOTAL_RC"
