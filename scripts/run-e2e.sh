#!/usr/bin/env bash
# Run E2E tests ONE FILE AT A TIME.
#
# Bun's default is to run test files in parallel (each in its own worker).
# Our E2E suite shares one Postgres database across all 13 files, and
# `setupDB()` does TRUNCATE CASCADE + fixture import. When files run in
# parallel, file A's TRUNCATE can race with file B's fixture import,
# producing observed fails like "expected 16 pages, got 8", missing
# links, orphaned timeline entries, etc. The flakiness was visible on
# ~3 of every 5 runs pre-fix.
#
# Running files sequentially eliminates the race entirely. It also costs
# some startup overhead (each file spins up a fresh bun process) but for
# a suite this size that is measured in ~1-2s per file, amortized under
# the natural per-file test time of 5-10s.
#
# Exits non-zero on the first failing file so CI fails fast.
#
# `--timeout=60000` matches the unit test suite. Bun's default is 5s,
# which is too tight for setupDB's TRUNCATE CASCADE on ~30 tables on
# CI runners under load (one CI flake observed on PR #475 hitting
# exactly 5000.09ms in the Tags beforeAll).
#
# HOME isolation: E2E tests call paths that resolve to gbrain init / saveConfig
# (e.g. setupDB writing config for the test container) and would otherwise
# write the user's real ~/.gbrain/config.json. The wrapper redirects HOME and
# GBRAIN_HOME to a tmpdir before bun starts so config writes land in the
# tmpdir, then verifies the user's real config md5 didn't change after the run.
# Both env vars are required: loadConfig/saveConfig resolve via HOME, while
# configPath/getDbUrlSource honor GBRAIN_HOME; setting only one leaves the
# other path escaping isolation. HOME is set before bun starts because Bun's
# os.homedir() caches at first call and in-process mutation would not take.
# Trap cleans up the tmpdir even on test failure.

set -euo pipefail

cd "$(dirname "$0")/.."

# --dry-run-list: print the resolved file list (one per line) and exit. Used
# by scripts/ci-local.sh to smoke-test the argv branching at startup.
DRY_RUN_LIST=0
if [ "${1:-}" = "--dry-run-list" ]; then
  DRY_RUN_LIST=1
  shift
fi

# Argv-driven file list (used by `ci:local:diff`); fall back to the full glob.
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=(test/e2e/*.test.ts)
fi

# SHARD env (e.g. SHARD=1/4) keeps every M-th file starting at index N (1-indexed).
# Used by scripts/ci-local.sh to fan 4 shards in parallel against 4 postgres
# containers. Sequential execution within a shard is preserved (the TRUNCATE
# CASCADE no-race rationale at the top of this file still holds).
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}
  shard_m=${SHARD#*/}
  if ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  filtered=()
  i=0
  for f in "${files[@]}"; do
    if [ $((i % shard_m + 1)) -eq "$shard_n" ]; then
      filtered+=("$f")
    fi
    i=$((i + 1))
  done
  # ${filtered[@]:-} avoids "unbound variable" under `set -u` when no files matched.
  files=("${filtered[@]:-}")
  # If the empty placeholder slipped in, drop it.
  if [ "${#files[@]}" -eq 1 ] && [ -z "${files[0]}" ]; then
    files=()
  fi
fi

# --dry-run-list and empty-shard exits run BEFORE HOME isolation: they don't
# launch bun, so there's nothing to isolate from and no breach to verify.
if [ "$DRY_RUN_LIST" = "1" ]; then
  if [ "${#files[@]}" -eq 0 ]; then
    exit 0
  fi
  printf '%s\n' "${files[@]}"
  exit 0
fi

if [ "${#files[@]}" -eq 0 ]; then
  # Empty shard (e.g. SHARD=4/4 with only 3 files): nothing to do.
  echo "No files for shard ${SHARD:-(unsharded)}; exiting clean."
  exit 0
fi

# --- HOME isolation: snapshot real user config before switching ---
# Tolerate unset HOME (minimal containers, exotic CI shells) without tripping set -u.
REAL_HOME="${HOME:-/tmp}"
USER_CONFIG="$REAL_HOME/.gbrain/config.json"
USER_CONFIG_EXISTED=0
USER_CONFIG_MD5=""
# `{ ... } || true` swallows non-zero exit when the file is missing or md5 isn't
# installed, so set -e never aborts before the post-run breach detector can run.
md5_of() {
  { if command -v md5 >/dev/null 2>&1; then
      md5 -q "$1" 2>/dev/null
    elif command -v md5sum >/dev/null 2>&1; then
      md5sum "$1" 2>/dev/null | awk '{print $1}'
    fi
  } || true
}
if [ -f "$USER_CONFIG" ]; then
  USER_CONFIG_EXISTED=1
  USER_CONFIG_MD5=$(md5_of "$USER_CONFIG")
fi

# Portable mktemp: explicit XXXXXX is required by GNU mktemp on Linux CI.
# `-t prefix` works on BSD but errors on GNU when the template lacks Xs.
E2E_TMP_HOME=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-e2e.XXXXXX")
trap 'rm -rf "$E2E_TMP_HOME"' EXIT

export HOME="$E2E_TMP_HOME"
export GBRAIN_HOME="$E2E_TMP_HOME"
mkdir -p "$E2E_TMP_HOME/.gbrain"

pass_files=0
fail_files=0
fail_list=()
total_pass=0
total_fail=0

for f in "${files[@]}"; do
  name=$(basename "$f")
  echo ""
  echo "=== $name ==="
  if output=$(bun test --timeout=60000 "$f" 2>&1); then
    pass_files=$((pass_files + 1))
    # Extract pass/fail counts from bun's summary (e.g., "123 pass")
    p=$(echo "$output" | grep -oE '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || echo 0)
    total_pass=$((total_pass + p))
    echo "$output" | tail -8
  else
    fail_files=$((fail_files + 1))
    fail_list+=("$name")
    p=$(echo "$output" | grep -oE '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || echo 0)
    fl=$(echo "$output" | grep -oE '[0-9]+ fail' | tail -1 | grep -oE '[0-9]+' || echo 0)
    total_pass=$((total_pass + p))
    total_fail=$((total_fail + fl))
    echo "$output"
    echo ""
    echo "FAILED: $name"
    # Continue so we see all failures; exit nonzero at the end.
  fi
done

echo ""
echo "========================================"
echo "E2E SUMMARY (sequential execution)"
echo "========================================"
echo "Files: $((pass_files + fail_files)) total, $pass_files passed, $fail_files failed"
echo "Tests: $total_pass passed, $total_fail failed"

# --- HOME isolation verification: fail loud on any out-of-isolation write ---
# Runs regardless of test pass/fail; isolation breach is higher-severity than
# any individual test failure. Exit 2 distinguishes from exit 1 (test failure).
# Three breach modes covered:
#   1. Config existed before AND was modified (md5 changed)
#   2. Config existed before AND was deleted during the run
#   3. Config did NOT exist before but was created during the run
AFTER_EXISTS=0
[ -f "$USER_CONFIG" ] && AFTER_EXISTS=1
AFTER_MD5=""
if [ "$AFTER_EXISTS" = "1" ]; then
  AFTER_MD5=$(md5_of "$USER_CONFIG")
fi
BREACH_REASON=""
if [ "$USER_CONFIG_EXISTED" = "1" ] && [ "$AFTER_EXISTS" = "0" ]; then
  BREACH_REASON="config existed before run but was deleted"
elif [ "$USER_CONFIG_EXISTED" = "0" ] && [ "$AFTER_EXISTS" = "1" ]; then
  BREACH_REASON="config did not exist before run but was created"
elif [ -n "$USER_CONFIG_MD5" ] && [ "$AFTER_MD5" != "$USER_CONFIG_MD5" ]; then
  BREACH_REASON="config md5 changed during run"
fi
if [ -n "$BREACH_REASON" ]; then
  echo "" >&2
  echo "ERROR: HOME isolation breach detected." >&2
  echo "  Reason: $BREACH_REASON" >&2
  echo "  Path: $USER_CONFIG" >&2
  echo "  Before: existed=$USER_CONFIG_EXISTED md5=${USER_CONFIG_MD5:-none}" >&2
  echo "  After:  existed=$AFTER_EXISTS md5=${AFTER_MD5:-none}" >&2
  echo "  A test wrote outside the tmpdir HOME despite the override." >&2
  exit 2
fi

if [ ${#fail_list[@]} -gt 0 ]; then
  echo ""
  echo "Failing files:"
  for f in "${fail_list[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
