#!/usr/bin/env bash
# Run E2E tests ONE FILE AT A TIME (within a shard).
#
# Bun's default is to run test files in parallel (each in its own worker).
# Our E2E suite shares one Postgres database across the whole test/e2e glob
# (220+ files), and `setupDB()` does TRUNCATE CASCADE + fixture import. When
# files run in parallel against ONE database, file A's TRUNCATE can race with
# file B's fixture import, producing observed fails like "expected 16 pages,
# got 8", missing links, orphaned timeline entries, etc. The flakiness was
# visible on ~3 of every 5 runs pre-fix.
#
# Running files sequentially eliminates the race entirely. Parallelism is
# recovered ACROSS databases instead: the SHARD=N/M env below fans shards out
# against separate Postgres containers (scripts/ci-local.sh runs 4). Within a
# shard, per-file bun startup (~1-2s) amortizes under the natural per-file
# test time of 5-10s.
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

# COVERAGE_DIR (opt-in lcov coverage) must be an ABSOLUTE path: this script
# redirects HOME (and E2E tests spawn CLI subprocesses with varying cwd), so
# a relative --coverage-dir would scatter lcov output across working dirs.
# Normalize it once against the repo root, before HOME moves. COVERAGE_DIR is
# deliberately NOT GBRAIN-prefixed: the hermetic env scrub below drops
# GBRAIN_*/operator prefixes, and this variable must survive that scrub.
if [ -n "${COVERAGE_DIR:-}" ]; then
  case "$COVERAGE_DIR" in
    /*) ;;
    *) COVERAGE_DIR="$PWD/$COVERAGE_DIR" ;;
  esac
fi

# #3485: this wrapper IS the e2e boundary — opt in to running with a database
# URL present. The bunfig test preload (database-url-guard-preload.ts) refuses
# bare `bun test` runs while DATABASE_URL/GBRAIN_DATABASE_URL is ambient; the
# per-file name floor (test/helpers/db-guard.ts) still applies after this.
export GBRAIN_TEST_ALLOW_DATABASE_URL=1
# Provider keys: the unit-lane preload (provider-keys-preload.ts) strips
# ambient ANTHROPIC/OPENAI keys for keyless-CI parity; e2e is the lane where
# real keys are deliberate (live embed/parity tests skip-gate on them), so
# opt back in at this boundary.
export GBRAIN_TEST_KEEP_PROVIDER_KEYS=1
# The e2e suite runs on DATABASE_URL only; an ambient GBRAIN_DATABASE_URL
# would pass the opt-in yet reach CLI-subprocess paths with no name floor —
# drop it here so only the floored variable crosses the boundary.
unset GBRAIN_DATABASE_URL

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

# --- Hermetic env scrub: operator/agent context must not bleed into E2E ---
# A dev shell or a Conductor workspace exports CONDUCTOR_*, MCP_*, OPENCLAW_*,
# HERMES_*, and GBRAIN_* config overrides (e.g. a stray GBRAIN_BRAIN_ID,
# GBRAIN_SOURCE, GBRAIN_*_THRESHOLD, GBRAIN_SUPERVISOR_PID_FILE, an operator's
# HERMES_BIN/HERMES_HOME) that would silently change test behavior — making
# "hermetic" E2E non-hermetic and its failures unreproducible across machines.
# Drop them before bun starts. This is a DENYLIST of operator-context prefixes
# (not an allowlist rebuild), so PATH, HOME, TMPDIR, CI, DATABASE_URL, and bun
# internals survive untouched. We keep GBRAIN_HOME (just set above for HOME
# isolation); everything else GBRAIN_* is an operator override the suite must
# not inherit — which also scrubs GBRAIN_REAL_HERMES_E2E and
# GBRAIN_REAL_GROK_E2E / GBRAIN_REAL_OPENCODE_E2E, so the real-agent door
# suites structurally
# cannot fire under this runner (their venue is heavy-tests.yml's direct bun
# test). GROK_ also drops an operator's GROK_BIN/GROK_HOME; OPENCODE_ drops
# OPENCODE_BIN and the OPENCODE_CONFIG* trio. Adapts GStack's
# buildHermeticEnv() allowlist to gbrain's shell E2E runner.
for _e2e_var in $(env | grep -oE '^(CONDUCTOR_|MCP_|OPENCLAW_|HERMES_|GROK_|OPENCODE_|GBRAIN_)[A-Za-z0-9_]*' | sort -u); do
  case "$_e2e_var" in
    GBRAIN_HOME) ;;  # required for HOME isolation (set above) — keep
    GBRAIN_PGLITE_SNAPSHOT) ;;  # snapshot fast-path fixture (exported by ci-local.sh / runners) — keep
    GBRAIN_TEST_ALLOW_DATABASE_URL) ;;  # #3485 preload opt-in (set above) — keep
    GBRAIN_TEST_KEEP_PROVIDER_KEYS) ;;  # provider-keys preload opt-in (set above) — keep
    GBRAIN_E2E_FILE_TIMEOUT) ;;  # per-file cap override — read AFTER this scrub, so it must survive it
    GBRAIN_E2E_ALLOW_DB) ;;  # #3485 name-floor opt-in — the guard's own error
                             # message tells operators to set it; stripping it
                             # here would make that escape hatch a dead end
    *) unset "$_e2e_var" || true ;;
  esac
done

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
  # phantom-redirect lives in test/ (its PGLite arm runs in the unit suite) but
  # its Postgres arm is only reachable through a DATABASE_URL-bearing lane —
  # the unit wrappers strip the URL (#3485), so this lane must carry it.
  files=(test/e2e/*.test.ts test/phantom-redirect-engine-parity.test.ts)
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

# PGLite snapshot fast path — ~90 e2e files boot in-memory PGLite; a cold boot
# replays every migration (~3.5x per booting file). Every other runner already
# activates this; the env scrub above deliberately keep-lists the var. Placed
# AFTER --dry-run-list so list mode stays instant. Non-fatal on build failure
# (tests fall back to cold init; the loader's schema-hash gate is authoritative).
# Files asserting the path TO post-initSchema state carry their own per-file
# `delete process.env.GBRAIN_PGLITE_SNAPSHOT` opt-out.
. scripts/lib/test-env.sh
ensure_pglite_snapshot "run-e2e"
# Absolutize: e2e tests spawn CLI subprocesses with varying cwd; a relative
# path would silently miss the tar there (cold-init fallback, benefit lost).
# Same reason COVERAGE_DIR is normalized to absolute above.
if [ -n "${GBRAIN_PGLITE_SNAPSHOT:-}" ] && [ "${GBRAIN_PGLITE_SNAPSHOT#/}" = "$GBRAIN_PGLITE_SNAPSHOT" ]; then
  export GBRAIN_PGLITE_SNAPSHOT="$PWD/$GBRAIN_PGLITE_SNAPSHOT"
fi

pass_files=0
fail_files=0
fail_list=()
total_pass=0
total_fail=0
file_idx=0

for f in "${files[@]}"; do
  name=$(basename "$f")
  file_idx=$((file_idx + 1))
  # COVERAGE_DIR (opt-in): each E2E file runs in its OWN bun process, so each
  # needs its OWN coverage dir — a second bun process reusing a coverage dir
  # OVERWRITES lcov.info. Empty/unset COVERAGE_DIR leaves the exec line
  # byte-identical to the pre-coverage behavior.
  COVERAGE_ARGS=()
  if [ -n "${COVERAGE_DIR:-}" ]; then
    COVERAGE_ARGS=(--coverage --coverage-reporter=lcov --coverage-dir="$COVERAGE_DIR/e2e-$file_idx")
  fi
  echo ""
  echo "=== $name ==="
  # Cross-file isolation: terminate any stale connections from the prior
  # file's pool before the next file's setupDB() runs. Without this,
  # idle postgres connections from the previous bun process race with
  # the next file's TRUNCATE CASCADE → cross-file fixture-state pollution
  # (people/sarah-chen disappears mid-test, etc.). The terminate call is
  # idempotent + fast (~50ms); on the first iteration there's nothing to
  # terminate so it's effectively free.
  if [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -At -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid != pg_backend_pid() AND datname = current_database()" >/dev/null 2>&1 || true
  fi
  # Hard outer timeout (default 180s per file; GBRAIN_E2E_FILE_TIMEOUT or
  # E2E_FILE_TIMEOUT_SECS overrides — the GBRAIN_ name is kept in the scrub
  # keep-list below, the non-GBRAIN name survives the scrub by construction;
  # nightly coverage runs use it to absorb instrumentation overhead). bun's
  # --timeout covers tests AND hooks (measured on 1.3.14), but it's
  # timer-based: a PGLite WASM call that blocks the event loop synchronously
  # never lets the timer fire and the file wedges indefinitely.
  # gtimeout/timeout SIGKILLs the file so the suite advances. gtimeout (macOS
  # via coreutils) preferred; timeout (Linux) fallback; bare bun (no outer
  # cap) if neither is installed.
  #
  # LLM-bound Tier-2 files (real provider round-trips when .env.testing
  # carries keys) legitimately run past 180s — the ingest skill alone has
  # been observed at ~131s — and were being SIGKILLed mid-run with no
  # assertion output, which reads like a mystery failure. CI runs those
  # files in their own job WITHOUT this wrapper (see .github/workflows/
  # e2e.yml tier2), so the cap only ever bit local runs: give them 4x.
  # serve-http-multi-agent rides the same carve-out for a different reason:
  # it spawns TWO `gbrain serve --http` subprocesses (19133 + a chaos serve
  # on 19134) plus several CLI register subprocesses, so its wall clock is
  # process-spawn-bound, not test-bound.
  file_timeout="${GBRAIN_E2E_FILE_TIMEOUT:-${E2E_FILE_TIMEOUT_SECS:-180}}"
  # Digits-only validation (same strict positive-int posture as the TS env
  # knobs): a malformed value falls back to the default instead of
  # word-splitting into extra gtimeout arguments or breaking the 4x math.
  case "$file_timeout" in ''|*[!0-9]*) file_timeout=180 ;; esac
  case "$f" in
    */skills.test.ts|*/zeroentropy-live.test.ts|*/serve-http-multi-agent.test.ts) file_timeout=$((file_timeout * 4)) ;;
  esac
  if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD="gtimeout $file_timeout"
  elif command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD="timeout $file_timeout"
  else
    TIMEOUT_CMD=""
  fi
  if output=$($TIMEOUT_CMD bun test --timeout=60000 ${COVERAGE_ARGS[@]+"${COVERAGE_ARGS[@]}"} "$f" 2>&1); then
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

# Lane manifest: written ONLY on a fully green run (isolation breach exits 2
# and failing files exit 1 above, both before reaching here), so
# complete:true means the lcov data represents the whole E2E lane.
if [ -n "${COVERAGE_DIR:-}" ]; then
  LCOV_COUNT=$(find "$COVERAGE_DIR" -name 'lcov.info' 2>/dev/null | grep -c '^' || true)
  printf '{"lane":"e2e","sha":"%s","lcovCount":%s,"complete":true}\n' \
    "$(git rev-parse HEAD)" "${LCOV_COUNT:-0}" > "$COVERAGE_DIR/lane-manifest.json"
fi
