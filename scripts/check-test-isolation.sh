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
#  R7: a file whose code calls `__unconfigureGatewayForTests(` or
#      `_clearGatewayForTests(` must call `resetGateway(` from an
#      afterEach/afterAll hook (or pass it as the hook: `afterEach(resetGateway)`).
#      An unconfigured gateway is process-global too: the next file's
#      beforeAll then sizes its PGLite schema from nothing, and a `-t`
#      filtered run or a throw before an inline restore leaves it empty.
#      Comments do not count either way (#6514).
#  R8: no scratch directory inside the source tree
#      (`join(import.meta.dir, '.tmp-...')`). Guards such as
#      test-reads-source-smell walk test/ in the same lane, and a scratch
#      directory created and removed by another file mid-walk fails them with
#      ENOENT (import-file.test.ts did this to test-reads-source-smell).
#      Use mkdtempSync(join(tmpdir(), '...')).
#  R9: a file that installs one of the process-global hooks below must undo
#      it from an afterEach/afterAll hook (an inline undo does not survive a
#      throw or a -t filter). Each installer patches console, stderr, signal
#      listeners or a module scope for the rest of the shard process: the
#      cli-socket output capture left by cli-socket.test.ts failed
#      cli-socket-context.test.ts in a shared shard (#7494), and the stdio
#      redirect left console.log bound to stderr. Comments do not count.
#        installOutputCapture( / startCliSocketServer(  -> _uninstallOutputCaptureForTests
#        redirectStdoutLoggingToStderr( / _resetStdoutRedirectForTests(  -> _resetStdoutRedirectForTests
#        installSigchldHandler(  -> _uninstallSigchldHandlerForTests
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
# is fine — every violation will fail. The scan matches whole lines.
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST="$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | grep -v '^[[:space:]]*$' || true)"
fi

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
VERDICT_PATTERN='currentExitCode[[:space:]]*\('
UNCONFIGURE_PATTERN='(__unconfigureGatewayForTests|_clearGatewayForTests)[[:space:]]*\('
# R8: a scratch path joined onto this file's own directory.
SOURCE_TREE_SCRATCH_PATTERN="(import\\.meta\\.dir(name)?|__dirname)[[:space:]]*,[[:space:]]*['\"\`]\\.?tmp[-_./'\"\`]"
# R9: installer pattern|restorer name, one pair per line.
PAIRED_RULES='installOutputCapture[[:space:]]*[(]|startCliSocketServer[[:space:]]*[(]|_uninstallOutputCaptureForTests
redirectStdoutLoggingToStderr[[:space:]]*[(]|_resetStdoutRedirectForTests[[:space:]]*[(]|_resetStdoutRedirectForTests
installSigchldHandler[[:space:]]*[(]|_uninstallSigchldHandlerForTests'
PAIRED_PATTERN='installOutputCapture[[:space:]]*[(]|startCliSocketServer[[:space:]]*[(]|redirectStdoutLoggingToStderr[[:space:]]*[(]|_resetStdoutRedirectForTests[[:space:]]*[(]|installSigchldHandler[[:space:]]*[(]'

# One awk process lints every candidate file (#8053): a grep or awk process
# per rule per file cost about 90 s for 2,000 candidates. Each file is read
# once into L[], then every rule runs over it with its own state, in rule order.
#
# Comment removal (R5, R6, R7, R9), line by line: a block comment that opens
# at the start of a line (JSDoc included) is dropped through its closing */,
# and a // comment is dropped from the // to the end of the line when it
# follows the line start, whitespace or punctuation (so a URL's :// survives).
# Block comments opening mid-line are left alone: a glob such as 'test/*.ts'
# would otherwise swallow the rest of the file. R6, R7 and R9 track
# afterEach/afterAll blocks by brace depth from the hook's line: a restore
# counts only inside one (or on the hook line itself), and an R6 reset inside
# one is not a baseline.
read -r -d '' SCAN_AWK <<'AWK' || true
function emit(f, rule, detail, lines,   n, a, i) {
  print "ERROR: " f
  print "       rule " rule ": " detail
  sub(/\n+$/, "", lines)
  if (lines != "") {
    n = split(lines, a, "\n")
    for (i = 1; i <= n && i <= 3; i++) print "         " a[i]
  }
}
function strip(line) {
  if (in_block) {
    if (index(line, "*/") != 0) in_block = 0
    return 0
  }
  if (line ~ /^[[:space:]]*\/\*/) {
    if (index(substr(line, index(line, "/*") + 2), "*/") == 0) in_block = 1
    return 0
  }
  CODE = line
  sub(/(^|[[:space:];,(){}])\/\/.*$/, "", CODE)
  return 1
}
function hook(   code, opens, closes) {
  code = CODE
  opens = gsub(/\{/, "{", code); closes = gsub(/\}/, "}", code)
  if (in_after) { depth += opens - closes; if (depth <= 0) in_after = 0; return 1 }
  if (CODE ~ /after(Each|All)[[:space:]]*\(/) { depth = opens - closes; if (depth > 0) in_after = 1; return 1 }
  return 0
}
function scan(f,   nl, line, i, k, env, mock, scratch, engine, gw, opt, verdict, unconf, paired, after_all, disconnect, last_before_all, bad, calls, reads, restored, baseline, seen) {
  split("", L)
  nl = 0
  while ((getline line < f) > 0) L[++nl] = line
  close(f)

  for (i = 1; i <= nl; i++) {
    line = L[i]
    if (line ~ ENV_RE) env = env i ":" line "\n"
    if (line ~ MOCK_RE) mock = mock i ":" line "\n"
    if (line ~ SCRATCH_RE) scratch = scratch i ":" line "\n"
    if (line ~ ENGINE_RE) engine = 1
    if (line ~ GATEWAY_RE) gw = 1
    if (index(line, OPT_OUT)) opt = 1
    if (line ~ VERDICT_RE) verdict = 1
    if (line ~ UNCONFIGURE_RE) unconf = 1
    if (line ~ PAIRED_RE) paired = 1
    if (line ~ /afterAll[[:space:]]*\(/) after_all = 1
    if (line ~ /\.disconnect[[:space:]]*\(/) disconnect = 1
  }

  # R1: env mutations.
  if (env != "") emit(f, "R1", "process.env mutation; use withEnv() or rename to *.serial.test.ts", env)
  # R2: mock.module() anywhere.
  if (mock != "") emit(f, "R2", "mock.module() leaks across files in the shard process; rename to *.serial.test.ts", mock)
  # R3: PGLiteEngine outside ~50 lines after a beforeAll(.
  if (engine) {
    last_before_all = -1000
    for (i = 1; i <= nl; i++) {
      if (L[i] ~ /beforeAll[[:space:]]*\(/) last_before_all = i
      if (L[i] ~ /new PGLiteEngine[[:space:]]*\(/ && i - last_before_all > 50) bad = bad i ":" L[i] "\n"
    }
    if (bad != "") emit(f, "R3", "new PGLiteEngine(...) outside beforeAll() context (>50 lines); move into beforeAll", bad)
  }
  # R4: PGLiteEngine creation requires afterAll{disconnect}.
  if (engine && (!after_all || !disconnect)) emit(f, "R4", "creates PGLiteEngine but missing afterAll(() => engine.disconnect()); engine leaks across files in the shard process", "")
  # R5: gateway configured but never restored.
  if (gw && !opt) {
    in_block = 0; restored = 0; calls = ""
    for (i = 1; i <= nl; i++) {
      if (!strip(L[i])) continue
      if (CODE ~ /resetGateway[[:space:]]*\(/) restored = 1
      if (CODE ~ /configureGateway[[:space:]]*\(/) calls = calls i ":" L[i] "\n"
    }
    if (calls != "" && !restored) emit(f, "R5", "configureGateway() with no resetGateway(); the gateway is process-global, so this config reaches every later file in the shard. Add afterAll(() => resetGateway()) or rename to *.serial.test.ts", calls)
  }
  # R6: the CLI exit verdict is read with no baseline outside an after-hook.
  if (verdict) {
    in_block = 0; in_after = 0; depth = 0
    for (i = 1; i <= nl; i++) {
      if (!strip(L[i]) || hook()) continue
      if (CODE ~ /_resetCliExitVerdictForTests[[:space:]]*\(|setCliExitVerdict[[:space:]]*\([[:space:]]*0[[:space:]]*\)/) baseline = 1
      if (CODE ~ /currentExitCode[[:space:]]*\(/ && CODE !~ /import/) reads = reads i ":" L[i] "\n"
    }
    if (reads != "" && !baseline) emit(f, "R6", "currentExitCode() read with no baseline; the verdict is process-global, so the first test reads whatever the previous file in the shard left. Call _resetCliExitVerdictForTests() in beforeEach (or before the run it checks), not only in afterEach", reads)
  }
  # R7: the gateway is unconfigured but no after-hook puts the baseline back.
  if (unconf) {
    in_block = 0; in_after = 0; depth = 0; restored = 0; calls = ""
    for (i = 1; i <= nl; i++) {
      if (!strip(L[i])) continue
      if (in_after && CODE ~ /resetGateway[[:space:]]*\(/) restored = 1
      if (!in_after && CODE ~ /after(Each|All)[[:space:]]*\(/ && CODE ~ /resetGateway/) restored = 1
      if (hook()) continue
      if (CODE ~ /(__unconfigureGatewayForTests|_clearGatewayForTests)[[:space:]]*\(/ && CODE !~ /import/) calls = calls i ":" L[i] "\n"
    }
    if (calls != "" && !restored) emit(f, "R7", "__unconfigureGatewayForTests()/_clearGatewayForTests() with no resetGateway() in an afterEach/afterAll hook; an empty gateway is process-global, so the next file's beforeAll sizes its schema from nothing. Add afterEach(() => resetGateway()) (an inline restore does not survive a throw or a -t filter) or rename to *.serial.test.ts", calls)
  }
  # R8: scratch directory inside the source tree.
  if (scratch != "") emit(f, "R8", "scratch directory inside the source tree; tree walkers in the same lane (test-reads-source-smell) fail with ENOENT when it is created or removed mid-walk. Use mkdtempSync(join(tmpdir(), '...'))", scratch)
  # R9: a process-global hook installed with no after-hook undo.
  if (paired) {
    for (k = 1; k <= npairs; k++) {
      seen = 0
      for (i = 1; i <= nl; i++) if (L[i] ~ TRIG[k]) { seen = 1; break }
      if (!seen) continue
      in_block = 0; in_after = 0; depth = 0; restored = 0; calls = ""
      for (i = 1; i <= nl; i++) {
        if (!strip(L[i])) continue
        if ((in_after || CODE ~ /after(Each|All)[[:space:]]*\(/) && CODE ~ REST[k]) restored = 1
        if (hook()) continue
        if (CODE ~ TRIG[k] && CODE !~ /import/) calls = calls i ":" L[i] "\n"
      }
      if (calls != "" && !restored) emit(f, "R9", "process-global hook installed with no " REST[k] "() in an afterEach/afterAll hook; it stays installed for every later file in the shard. Add afterEach(() => " REST[k] "()) or rename to *.serial.test.ts", calls)
    }
  }
}
BEGIN {
  ENV_RE = ENVIRON["ENV_MUTATION_PATTERN"]; MOCK_RE = ENVIRON["MODULE_MOCK_PATTERN"]
  ENGINE_RE = ENVIRON["ENGINE_PATTERN"]; GATEWAY_RE = ENVIRON["GATEWAY_PATTERN"]
  OPT_OUT = ENVIRON["GATEWAY_OPT_OUT"]; VERDICT_RE = ENVIRON["VERDICT_PATTERN"]
  UNCONFIGURE_RE = ENVIRON["UNCONFIGURE_PATTERN"]; SCRATCH_RE = ENVIRON["SOURCE_TREE_SCRATCH_PATTERN"]
  PAIRED_RE = ENVIRON["PAIRED_PATTERN"]
  n = split(ENVIRON["ALLOWLIST"], a, "\n")
  for (i = 1; i <= n; i++) allowed[a[i]] = 1
  npairs = split(ENVIRON["PAIRED_RULES"], p, "\n")
  for (k = 1; k <= npairs; k++) {
    match(p[k], /\|[^|]*$/)
    TRIG[k] = substr(p[k], 1, RSTART - 1); REST[k] = substr(p[k], RSTART + 1)
  }
}
$0 != "" && !($0 in allowed) { scan($0) }
AWK

CANDIDATES="$(guard_candidates -E -e "$ENV_MUTATION_PATTERN" -e "$MODULE_MOCK_PATTERN" -e "$ENGINE_PATTERN" -e "$GATEWAY_PATTERN" -e "$VERDICT_PATTERN" -e "$UNCONFIGURE_PATTERN" -e "$SOURCE_TREE_SCRATCH_PATTERN" -e "$PAIRED_PATTERN" <<< "$FILE_LIST")"
REPORT=""
if [ -n "$CANDIDATES" ]; then
  REPORT="$(printf '%s\n' "$CANDIDATES" | ENV_MUTATION_PATTERN="$ENV_MUTATION_PATTERN" MODULE_MOCK_PATTERN="$MODULE_MOCK_PATTERN" \
    ENGINE_PATTERN="$ENGINE_PATTERN" GATEWAY_PATTERN="$GATEWAY_PATTERN" GATEWAY_OPT_OUT="$GATEWAY_OPT_OUT" \
    VERDICT_PATTERN="$VERDICT_PATTERN" UNCONFIGURE_PATTERN="$UNCONFIGURE_PATTERN" \
    SOURCE_TREE_SCRATCH_PATTERN="$SOURCE_TREE_SCRATCH_PATTERN" PAIRED_PATTERN="$PAIRED_PATTERN" \
    PAIRED_RULES="$PAIRED_RULES" ALLOWLIST="$ALLOWLIST" awk "$SCAN_AWK")"
fi
file_count="$(printf '%s\n' "$FILE_LIST" | grep -c . || true)"
violations="$(printf '%s\n' "$REPORT" | grep -c '^ERROR: ' || true)"
if [ -n "$REPORT" ]; then
  printf '%s\n' "$REPORT"
fi

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
  echo "  - For __unconfigureGatewayForTests(), call resetGateway() in"
  echo "    afterEach or afterAll; it puts back the preload's baseline gateway."
  echo "  - For a scratch directory, use mkdtempSync(join(tmpdir(), '...'))."
  echo "  - For a process-global hook (R9), call its named undo from afterEach"
  echo "    or afterAll."
  echo
  echo "Or, if this is a baseline file from before the lint shipped,"
  echo "add it to scripts/check-test-isolation.allowlist (with a TODO"
  echo "comment naming the sweep PR that will remove it)."
  exit 1
fi

echo "check-test-isolation: OK ($file_count non-serial unit files scanned)"
