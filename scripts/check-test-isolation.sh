#!/usr/bin/env bash
# CI guard: fail if any non-serial unit test file violates intra-process
# isolation rules. The v0.26.4 parallel runner loads multiple test files
# into one bun process per shard; module-level state (env vars, PGLite
# engines, mock.module overrides) leaks across files in that process and
# silently flakes other tests.
#
# Rules enforced (non-serial unit test files only):
#  R1: no `process.env.X = ...`, `process.env['X'] = ...`,
#      `delete process.env.X`, `Object.assign(process.env, ...)`,
#      `Reflect.set(process.env, ...)` mutations. Use withEnv() helper or
#      rename the file to `*.serial.test.ts`.
#  R2: no `mock.module(...)` anywhere. Top-level module mocks affect every
#      other file in the same shard process. Rename to `*.serial.test.ts`.
#  R3: `new PGLiteEngine(` may only appear within ~50 lines following a
#      `beforeAll(` line. Engines created at module scope (or in describe
#      bodies) leak across files in the shard process.
#  R4: any file that creates `new PGLiteEngine(` must call `.disconnect(`
#      inside an `afterAll(` block. Without disconnect, engines leak across
#      file boundaries within a shard process.
#  R5: a file whose code calls `configureGateway(` must also call
#      `resetGateway(` in its code (normally from afterAll/afterEach). The
#      AI gateway is one object per process, so whatever a file configures
#      (embedding model and width, keys, base URLs) is still in force for
#      the next file the shard loads, and that file's PGLite schema is sized
#      from it: eval-canary once failed "expected 1280 dimensions, not 1536"
#      after a reshuffle ran a LiteLLM-configuring file first. Comments do
#      not count either way. A file whose only calls run inside a spawned
#      child's script string carries `isolation-lint: R5-subprocess-only`.
#  R6: a file whose code reads the CLI exit verdict (`currentExitCode(`)
#      must set its own baseline outside an after-hook: a
#      `_resetCliExitVerdictForTests(` or `setCliExitVerdict(0)` call in a
#      before-hook or before its run. The verdict is one value per process
#      and any command a test drives can leave it at 1 (doctor, remediate,
#      connectors sync), so a reset only in afterEach still reads the
#      previous file's verdict in its first test: edge-proposals-json-bigint
#      failed this way three times after a shard reshuffle.
#
# Scope:
#  - Recursively scans `test/**/*.test.ts`.
#  - Skips `*.serial.test.ts` entirely (the quarantine escape hatch).
#  - Skips `test/e2e/**` (E2E runs sequentially in its own runner; not in
#    the parallel pool).
#
# Allow-list:
#  Files in `scripts/check-test-isolation.allowlist` (one filename per
#  line, # comments allowed) are skipped. This exists because v0.26.7
#  ships the lint as a foundation; v0.26.8 (env sweep) and v0.26.9
#  (PGLite sweep) remove entries as files get fixed. New files MUST NOT
#  be added — the allow-list shrinks over time, never grows.
#
# Usage: scripts/check-test-isolation.sh [TARGET_DIR]
#        scripts/check-test-isolation.sh --as-parallel FILE...
#   --as-parallel lints the named files (serial ones included) as if they
#   ran in the parallel pool: the check a *.serial.test.ts file must pass
#   before it rejoins the unit lane (scripts/serial-files.tsv).
# Exit:  0 when clean, 1 when un-allow-listed violations found.

set -euo pipefail

. "$(dirname "$0")/lib/guard-candidates.sh"

# GBRAIN_GUARD_ROOT (guard self-test): lint a fixture tree, whose unit files
# end in .test.fixture.ts so the real lint and `bun test` never collect them.
ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"
TEST_SUFFIX='.test.ts'
[ -n "${GBRAIN_GUARD_ROOT:-}" ] && TEST_SUFFIX='.test.fixture.ts'

AS_PARALLEL=0
if [ "${1:-}" = "--as-parallel" ]; then
  AS_PARALLEL=1
  shift
  [ "$#" -gt 0 ] || { echo "Usage: scripts/check-test-isolation.sh --as-parallel FILE..." >&2; exit 2; }
fi
TARGET_DIR="${1:-test}"
# When scanning the default root, also lint evals/**/*.test.ts — those files
# are collected into the CI matrix (scripts/test-shard.sh) and must obey the
# same isolation rules as everything else CI executes. An explicit TARGET_DIR
# argument (guard self-test fixtures) scans only itself.
EXTRA_DIRS=""
if [ "$TARGET_DIR" = "test" ] && [ -d evals ]; then
  EXTRA_DIRS="evals"
fi
ALLOWLIST_FILE="$ROOT/scripts/check-test-isolation.allowlist"

# Read allowlist (one filename per line, # comments allowed). Empty file
# is fine — every violation will fail. Cached into ALLOWLIST so the
# per-file check (~700 lookups per run) is one pure-bash `case` match.
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST="$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' || true)"
fi

is_allowlisted() {
  local f="$1"
  if [ -z "$ALLOWLIST" ]; then
    return 1
  fi
  # Use a pure-bash `case` whole-line match against the newline-delimited
  # allowlist instead of `echo | grep -qxF`. v0.41.8 CI flake (verify job
  # 77771356276): the grep pipe form occasionally failed to match the
  # first allowlist entry on Ubuntu 24.04 + bash 5 under
  # `bun run` + GNU `timeout` (couldn't reproduce on macOS bash 3.2 with
  # the same allowlist file content + lint script content + checkout
  # state). Pure-bash case is locale-free, pipe-free, subshell-free,
  # set-e-quirk-free, and ~100x faster on every call.
  case $'\n'"$ALLOWLIST"$'\n' in
    *$'\n'"$f"$'\n'*) return 0 ;;
  esac
  return 1
}

# Find non-serial unit test files (excluding test/e2e). Portable across
# bash 3.2 (macOS default) and bash 4+; no mapfile.
if [ "$AS_PARALLEL" = 1 ]; then
  FILE_LIST="$(printf '%s\n' "$@")"
else
FILE_LIST="$(find "$TARGET_DIR" $EXTRA_DIRS -name "*$TEST_SUFFIX" \
  -not -name "*.serial$TEST_SUFFIX" \
  -not -path "*/e2e/*" \
  -type f 2>/dev/null | sort)"
fi

ENV_MUTATION_PATTERN='process\.env\.[A-Za-z_][A-Za-z_0-9]*[[:space:]]*=[^=]|process\.env\[[^]]+\][[:space:]]*=[^=]|delete[[:space:]]+process\.env\.|delete[[:space:]]+process\.env\[|Object\.assign[[:space:]]*\([[:space:]]*process\.env|Reflect\.set[[:space:]]*\([[:space:]]*process\.env'
MODULE_MOCK_PATTERN='mock\.module[[:space:]]*\('
ENGINE_PATTERN='new PGLiteEngine[[:space:]]*\('
GATEWAY_PATTERN='configureGateway[[:space:]]*\('
GATEWAY_OPT_OUT='isolation-lint: R5-subprocess-only'
# Comment removal for R5, line by line: a block comment that opens at the
# start of a line (JSDoc included) is dropped through its closing */, and a
# // comment is dropped from the // to the end of the line when it follows
# the line start, whitespace or punctuation (so a URL's :// survives).
# Block comments opening mid-line are left alone: a glob such as
# 'test/*.ts' would otherwise swallow the rest of the file.
VERDICT_PATTERN='currentExitCode[[:space:]]*\('
# R6: same comment removal as GATEWAY_CODE_SCAN; a reset inside an
# afterEach/afterAll block (tracked by brace depth from the hook's line)
# does not count as a baseline. Prints the reads when no baseline is left.
VERDICT_CODE_SCAN='
  in_block {
    if (index($0, "*/") == 0) next
    in_block = 0
    next
  }
  /^[[:space:]]*\/\*/ {
    if (index(substr($0, index($0, "/*") + 2), "*/") == 0) in_block = 1
    next
  }
  {
    code = $0
    sub(/(^|[[:space:];,(){}])\/\/.*$/, "", code)
    opens = gsub(/\{/, "{", code); closes = gsub(/\}/, "}", code)
    if (in_after) { depth += opens - closes; if (depth <= 0) in_after = 0; next }
    if (code ~ /after(Each|All)[[:space:]]*\(/) { depth = opens - closes; if (depth > 0) in_after = 1; next }
    if (code ~ /_resetCliExitVerdictForTests[[:space:]]*\(|setCliExitVerdict[[:space:]]*\([[:space:]]*0[[:space:]]*\)/) baseline = 1
    if (code ~ /currentExitCode[[:space:]]*\(/ && code !~ /import/) reads = reads NR ":" $0 "\n"
  }
  END { if (reads != "" && !baseline) printf "%s", reads }
'
GATEWAY_CODE_SCAN='
  in_block {
    if (index($0, "*/") == 0) next
    in_block = 0
    next
  }
  /^[[:space:]]*\/\*/ {
    if (index(substr($0, index($0, "/*") + 2), "*/") == 0) in_block = 1
    next
  }
  {
    code = $0
    sub(/(^|[[:space:];,(){}])\/\/.*$/, "", code)
    if (code ~ /resetGateway[[:space:]]*\(/) restored = 1
    if (code ~ /configureGateway[[:space:]]*\(/) calls = calls NR ":" $0 "\n"
  }
  END { if (calls != "" && !restored) printf "%s", calls }
'
CANDIDATES="$(guard_candidates -E -e "$ENV_MUTATION_PATTERN" -e "$MODULE_MOCK_PATTERN" -e "$ENGINE_PATTERN" -e "$GATEWAY_PATTERN" -e "$VERDICT_PATTERN" <<< "$FILE_LIST")"

violations=0
file_count=0

emit_violation() {
  local f="$1" rule="$2" detail="$3" lines="$4"
  if is_allowlisted "$f"; then
    return
  fi
  echo "ERROR: $f"
  echo "       rule $rule: $detail"
  if [ -n "$lines" ]; then
    echo "$lines" | head -3 | sed 's/^/         /'
  fi
  violations=$((violations + 1))
}

# Read newline-separated file list; OK on macOS bash 3.2.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  file_count=$((file_count + 1))
  case $'\n'"$CANDIDATES"$'\n' in
    *$'\n'"$f"$'\n'*) ;;
    *) continue ;;
  esac
  if is_allowlisted "$f"; then
    continue
  fi
  # R1: env mutations.
  env_lines=$(grep -nE "$ENV_MUTATION_PATTERN" "$f" 2>/dev/null || true)
  if [ -n "$env_lines" ]; then
    emit_violation "$f" "R1" "process.env mutation; use withEnv() or rename to *.serial.test.ts" "$env_lines"
  fi

  # R2: mock.module() anywhere.
  mock_lines=$(grep -nE "$MODULE_MOCK_PATTERN" "$f" 2>/dev/null || true)
  if [ -n "$mock_lines" ]; then
    emit_violation "$f" "R2" "mock.module() leaks across files in the shard process; rename to *.serial.test.ts" "$mock_lines"
  fi

  # R3: PGLiteEngine outside ~50 lines after a beforeAll(.
  if grep -qE "$ENGINE_PATTERN" "$f" 2>/dev/null; then
    bad=$(awk '
      BEGIN { last_before_all = -1000 }
      /beforeAll[[:space:]]*\(/ { last_before_all = NR }
      /new PGLiteEngine[[:space:]]*\(/ {
        if (NR - last_before_all > 50) {
          printf "%d:%s\n", NR, $0
        }
      }
    ' "$f" 2>/dev/null)
    if [ -n "$bad" ]; then
      emit_violation "$f" "R3" "new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll" "$bad"
    fi
  fi

  # R4: PGLiteEngine creation requires afterAll{disconnect}.
  if grep -qE "$ENGINE_PATTERN" "$f" 2>/dev/null; then
    if ! grep -qE 'afterAll[[:space:]]*\(' "$f" 2>/dev/null \
       || ! grep -qE '\.disconnect[[:space:]]*\(' "$f" 2>/dev/null; then
      emit_violation "$f" "R4" "creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process" ""
    fi
  fi

  # R5: gateway configured but never restored. GATEWAY_CODE_SCAN reads the
  # file with comments removed and prints the configureGateway lines only
  # when no resetGateway call is left.
  if grep -qE "$GATEWAY_PATTERN" "$f" 2>/dev/null && ! grep -qF "$GATEWAY_OPT_OUT" "$f" 2>/dev/null; then
    unrestored=$(awk "$GATEWAY_CODE_SCAN" "$f" 2>/dev/null || true)
    if [ -n "$unrestored" ]; then
      emit_violation "$f" "R5" "configureGateway() with no resetGateway(); the gateway is process-global, so this config reaches every later file in the shard. Add afterAll(() => resetGateway()) or rename to *.serial.test.ts" "$unrestored"
    fi
  fi

  # R6: the CLI exit verdict is read with no baseline outside an after-hook.
  if grep -qE "$VERDICT_PATTERN" "$f" 2>/dev/null; then
    unbased=$(awk "$VERDICT_CODE_SCAN" "$f" 2>/dev/null || true)
    if [ -n "$unbased" ]; then
      emit_violation "$f" "R6" "currentExitCode() read with no baseline; the verdict is process-global, so the first test reads whatever the previous file in the shard left. Call _resetCliExitVerdictForTests() in beforeEach (or before the run it checks), not only in afterEach" "$unbased"
    fi
  fi
done <<EOF
$FILE_LIST
EOF

if [ $violations -gt 0 ]; then
  echo
  echo "check-test-isolation: FAIL ($violations violation(s))"
  echo
  echo "Fix:"
  echo "  - For env mutations, use withEnv() from test/helpers/with-env.ts"
  echo "  - For mock.module(), rename to *.serial.test.ts (quarantine)"
  echo "  - For PGLiteEngine, follow the canonical pattern in"
  echo "    test/helpers/reset-pglite.ts JSDoc and CLAUDE.md."
  echo "  - For configureGateway(), call resetGateway() in afterAll; it"
  echo "    puts back the preload's baseline gateway for the next file."
  echo "  - For currentExitCode(), reset the verdict in beforeEach (or right"
  echo "    before the run it checks) with _resetCliExitVerdictForTests()."
  echo
  echo "Or, if this is a baseline file from before the lint shipped,"
  echo "add it to scripts/check-test-isolation.allowlist (with a TODO"
  echo "comment naming the sweep PR that will remove it)."
  exit 1
fi

echo "check-test-isolation: OK ($file_count non-serial unit files scanned)"
