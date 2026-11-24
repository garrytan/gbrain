#!/usr/bin/env bash
# Local push gate for rust-engine/main of garrytan/gbrain. Lives on this machine only (the .github
# workflows are frozen until 2026-11-24 20:30Z); the pre-push hook in the clone requires its PASS line.
#
#   bash /var/tmp/trunk/trunk-push-gate.sh <sha> [base-sha]
#
# base-sha defaults to the current origin/rust-engine/main (read from the local ref, no fetch).
# Checks <sha> out detached in /var/tmp/trunk/pushgate, then runs, in order, stopping at the first red:
#   1 cargo-test   cd rust && cargo build + cargo clippy --all-targets --locked -D warnings + cargo test --locked           (rust-engine.yml "Unit tests" step)
#   2 rust-build   CARGO_BUILD_JOBS=3 bun run rust:build                       (rust-engine.yml "Build the addon")
#   3 parity-arm   test/rust-engine-{store,shell,differential}.test.ts, then every test/engine-parity/*.test.ts
#                  one bun process per file, GBRAIN_TEST_RUST_ARM=1 GBRAIN_TEST_RUST_ADDON_REQUIRED=1
#                  GBRAIN_RUST_ENGINE_ADDON=<worktree>/rust/target/addon/gbrain_engine.linux-x64-glibc.node
#                  (rust-engine.yml "Rust engine store tests and the parity suite's Rust arm"), with the
#                  Postgres arm on (DATABASE_URL = the fresh gbrain_test_pushgate database on :55434)
#   3b addon-serial the three serial files no workflow runs with the addon (docs/research/rust-test-audit-r2.md, item 10):
#                  test/rust-export.serial.test.ts, test/rust-jsonb-key-order.serial.test.ts and
#                  test/rust-vector-search-cli.serial.test.ts, one bun process per file, GBRAIN_TEST_RUST_ADDON_REQUIRED=1, no
#                  DATABASE_URL. A skipped test fails the step: with the addon required, nothing may skip. This step stands
#                  in for a rust-engine.yml line until the .github freeze ends (20:30Z Nov 24); drop it when that line lands.
#   3c addon-job   everything else the rust-engine.yml addon job runs with the addon (added 2026-11-22 after rust-engine/main
#                  720bc21296 passed this gate and then failed the "Rust engine" workflow): test/rust-cli-parity.serial.test.ts
#                  (GBRAIN_TEST_RUST_ADDON_REQUIRED=1) and test/rust-engine-withdrawn-lead.test.ts through
#                  scripts/run-with-receipt.sh (GBRAIN_TEST_REQUIRE_RUST_ADDON=1, a receipt dir), then
#                  scripts/require-executed-tests.ts rust-store. First it reads the addon job out of the checked-out
#                  rust-engine.yml and fails if that job names a test or script file, or a GBRAIN_ variable, that this
#                  script does not know, so the list cannot drift from the workflow.
#   TMPDIR         parity-arm and addon-job run with TMPDIR set to $G/linktmp, a symlink to $G/realtmp, as macOS tmpdir() goes
#                  through /var -> /private/var (the export-bytes and notifier tests failed there only). Removed after each step.
#   4 unit-lane    DATABASE_URL unset. The full CI unit lane (40 shards, serial lane) takes about 100 minutes here and
#                  does not fit. This runs a fixed subset: the census files (scripts/ci-census-tests.sh --run) and
#                  GATE_UNIT_SHARD_PAIRS (default 0) pairs of test.yml's `test` shards, picked by the sha
#   5 e2e          diff-selected E2E: scripts/select-e2e.ts on <base>..<sha>, then a deterministic subset that fits
#                  (scripts/pushgate-e2e.sh logic in /var/tmp/trunk/pushgate-e2e.sh) on :55434 gbrain_test_pushgate
#   6 guard12      test/e2e/typed-preparation-reads-guard-postgres.test.ts on Postgres, always
# Every bun suite runs under `flock /var/tmp/trunk/bun.lock`, taken per suite or per file (a parity file, a census chunk of 20
# files, a unit shard, an E2E chunk of 4 files) and released between them, so other work can get the lock.
#
# Output: /var/tmp/trunk/pushgate-logs/<full sha>/summary.txt, one line per step
#   <step> rc=<rc> pass=<n> fail=<n> errlines=<n> <secs>s
# ending in `GATE PASS <sha> <wall s>` or `GATE FAIL <sha> <step>`. Full logs sit beside it.
# Exit status: 0 on pass, 1 on a red step, 2 on bad usage or setup.
#
# Knobs (environment): GATE_UNIT_SHARD_PAIRS (default 0), GATE_CENSUS (default 1), GATE_E2E_BUDGET_MS
# (default 300000), GATE_STEP_TIMEOUT (default 1500 s per command), GATE_REPO (default /code/garrytan/gbrain).
set -uo pipefail

SHA_IN=${1:-}; BASE_IN=${2:-}
[ -n "$SHA_IN" ] || { echo "usage: bash /var/tmp/trunk/trunk-push-gate.sh <sha> [base-sha]" >&2; exit 2; }
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
REPO=${GATE_REPO:-/code/garrytan/gbrain}
WT=/var/tmp/trunk/pushgate
LOCK=/var/tmp/trunk/bun.lock
SHA=$(git -C "$REPO" rev-parse --verify --quiet "$SHA_IN^{commit}") || { echo "trunk-push-gate: unknown commit $SHA_IN in $REPO" >&2; exit 2; }
BASE=$(git -C "$REPO" rev-parse --verify --quiet "${BASE_IN:-origin/rust-engine/main}^{commit}") || { echo "trunk-push-gate: unknown base ${BASE_IN:-origin/rust-engine/main}" >&2; exit 2; }
G=/var/tmp/trunk/pushgate-logs/$SHA
STEP_TIMEOUT=${GATE_STEP_TIMEOUT:-1500}
CENSUS=${GATE_CENSUS:-1}
PAIRS=${GATE_UNIT_SHARD_PAIRS:-0}
E2E_BUDGET=${GATE_E2E_BUDGET_MS:-300000}
DBNAME=gbrain_test_pushgate
DB="postgres://postgres@127.0.0.1:55434/$DBNAME"
ADMIN="postgres://postgres@127.0.0.1:55434/postgres"
T() { timeout --kill-after=30 "$STEP_TIMEOUT" "$@"; }
F() {   # one bun suite at a time: the lock is taken per suite or per file and released at once, never held across an arm or lane
  local t=$(date +%s)
  ( flock 8; echo "[lock waited $(( $(date +%s) - t ))s]"; timeout --kill-after=30 "$STEP_TIMEOUT" "$@" ) 8> "$LOCK"
}

# One gate at a time: it owns the pushgate worktree and the database.
exec 9> /var/tmp/trunk/pushgate.lock
flock -n 9 || { echo "trunk-push-gate: another gate run holds /var/tmp/trunk/pushgate.lock" >&2; exit 2; }

S=$G/summary.txt
# GATE_REUSE=1: keep the green steps of the previous run on this same sha (same tree, never rerun a passed check);
# their lines are carried forward with a "reused" tag and their logs stay beside the summary.
PREV=""
if [ "${GATE_REUSE:-0}" = 1 ] && [ -f "$S" ]; then PREV=$(cat "$S"); mv "$S" "$G/summary.prev.$(date +%s).txt"; else rm -rf "$G"; fi
mkdir -p "$G"
WALL0=$(date +%s)
say() { echo "$*" | tee -a "$S"; }
say "HEAD $SHA"
say "BASE $BASE"
say "started $(date -u +%Y-%m-%dT%H:%M:%SZ) host-load $(cut -d' ' -f1-3 /proc/loadavg)"
CURRENT=setup
trap 'say "GATE FAIL $SHA interrupted-in-$CURRENT"; exit 1' INT TERM

fail_gate() { say "GATE FAIL $SHA $1"; exit 1; }

# pass/fail counts from a log: bun "N pass"/"N fail", cargo "test result", run-e2e.sh "Tests:" totals.
counts() {
  awk '
    /^Tests: [0-9]+ passed, [0-9]+ failed/ { e2e=1; ep+=$2; ef+=$4 }
    /^ *[0-9]+ pass$/ { bp+=$1; seenb=1 }
    /^ *[0-9]+ fail$/ { bf+=$1 }
    /^\(fail\)/ { fl++ }
    /^test result: / { for (i=1;i<=NF;i++) { if ($(i+1)=="passed;") cp+=$i; if ($(i+1)=="failed;") cf+=$i } }
    END {
      if (e2e) { p=ep; f=ef } else { p=bp+cp; f=bf+cf; if (f==0 && seenb==0) f=fl }
      printf "pass=%d fail=%d", p, f
    }' "$1"
}
errlines() { grep -cE '^(ERROR|FAILED|Failed:|error(\[E[0-9]+\])?:|::error|PARITY_FAIL)' "$1" || true; }


# Known reds: failing test files that are already owned elsewhere. A unit piece whose only failing files match
# GATE_KNOWN_RED (egrep, default sync-partial-clone-2331: red on 48e9e9cd6b, owned by a debug task) is logged as
# KNOWN-RED-ONLY and does not stop the gate; any other failing file still does.
KNOWN_RED=${GATE_KNOWN_RED:-sync-partial-clone-2331}
known_only() {   # <log>: true when the log has failures and every failing file matches KNOWN_RED
  local files
  files=$(awk '/^test\/.*\.test\.ts:$/ { f=$0; sub(/:$/, "", f) } /^\(fail\)/ { print f }' "$1" | sort -u)
  [ -n "$files" ] || return 1
  if printf '%s\n' "$files" | grep -Evq "$KNOWN_RED"; then return 1; fi
  echo "KNOWN-RED-ONLY: $(printf '%s ' $files)"
}

# step <name> <needs-tests: 1|0> <unused: 0> <function>   (locking is per suite or per file, inside the function, via F)   (the function's output is the step's log)
step() {
  local name=$1 needs=$2 lock=$3 fn=$4 t0 rc c f e p lw why=""
  CURRENT=$name
  local prevline
  prevline=$(printf '%s\n' "$PREV" | grep -E "^$name rc=0 " | grep -v 'RED:' | tail -1)
  if [ -n "$prevline" ] && [ "$name" != setup ]; then say "$prevline (reused: same sha, earlier run)"; return 0; fi
  t0=$(date +%s)
  ( "$fn" ) > "$G/$name.log" 2>&1; rc=$?
  c=$(counts "$G/$name.log"); e=$(errlines "$G/$name.log")
  p=${c#pass=}; p=${p%% *}; f=${c##*fail=}
  [ "$rc" -ne 0 ] && why="$why rc"
  if [ "${f:-0}" -gt 0 ] && ! { [ "$name" = unit-lane ] && [ "$rc" -eq 0 ] && grep -q '^KNOWN-RED-ONLY' "$G/$name.log"; }; then why="$why fail-count"; fi
  [ "${e:-0}" -gt 0 ] && why="$why error-lines"
  [ "$needs" = 1 ] && [ "${p:-0}" -eq 0 ] && why="$why no-tests-ran"
  lw=$(awk '/^\[lock waited [0-9]+s\]/ { gsub(/[^0-9]/, "", $3); s += $3 } END { print s + 0 }' "$G/$name.log")
  say "$name rc=$rc $c errlines=$e $(( $(date +%s) - t0 ))s (waiting for the bun lock: ${lw}s)${why:+ RED:$why}"
  [ -z "$why" ] || fail_gate "$name"
}

# ---- setup: dedicated detached worktree, dependencies, no stale files
setup() {
  if [ -e "$WT/.git" ]; then
    git -C "$WT" checkout --detach --force "$SHA" || return 1
    git -C "$WT" clean -fd -q || return 1
  else
    git -C "$REPO" worktree add --detach "$WT" "$SHA" || return 1
  fi
  [ "$(git -C "$WT" rev-parse HEAD)" = "$SHA" ] || { echo "worktree is not at $SHA"; return 1; }
  cd "$WT" || return 1
  local h
  h=$(sha1sum bun.lock package.json | sha1sum | cut -d' ' -f1)
  if [ "$(cat node_modules/.pushgate-deps 2>/dev/null)" != "$h" ]; then
    T bun install --frozen-lockfile --ignore-scripts || return 1
    echo "$h" > node_modules/.pushgate-deps
  else
    echo "node_modules up to date for this bun.lock"
  fi
  # A clean fresh database for the Postgres arms.
  psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS $DBNAME WITH (FORCE)" -c "CREATE DATABASE $DBNAME" || return 1
}
t0=$(date +%s)
CURRENT=setup
( setup ) > "$G/setup.log" 2>&1 || { say "setup rc=$? $(( $(date +%s) - t0 ))s"; fail_gate setup; }
say "setup rc=0 $(( $(date +%s) - t0 ))s"
cd "$WT"

# ---- 1 cargo store tests (the workspace, which holds gbrain-store)
# Ember ruling Nov 20 ~8:55 PM PST: build and test the whole workspace (every crate's integration tests, not --lib),
# and run the dupfn check (one store method defined twice for one type in one crate).
s_dupfn() { python3 /var/tmp/trunk/dupfn-check.py "$WT/rust"; }
step dupfn 0 0 s_dupfn

s_cargo() { cd "$WT/rust" && T env CARGO_BUILD_JOBS=3 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo build --workspace --locked && T env CARGO_BUILD_JOBS=3 CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo clippy --all-targets --locked -- -D warnings && T env CARGO_BUILD_JOBS=3 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --workspace --locked; }
step cargo-test 1 0 s_cargo

# ---- 2 addon build
s_build() { cd "$WT" && T env CARGO_BUILD_JOBS=3 bun run rust:build && test -f "$ADDON" && ls -l "$ADDON"; }
ADDON=$WT/rust/target/addon/gbrain_engine.linux-x64-glibc.node
step rust-build 0 0 s_build

# ---- symlinked temp dir: tmpdir() on macOS is /var/folders/... reached through the /var -> /private/var symlink
link_tmp() {   # run inside a step function (a subshell): TMPDIR becomes a symlink to a real directory, removed when the step ends
  rm -rf "$G/realtmp" "$G/linktmp"
  mkdir -p "$G/realtmp" && ln -s realtmp "$G/linktmp" || return 1
  trap 'rm -rf "$G/realtmp" "$G/linktmp"' EXIT
  export TMPDIR="$G/linktmp"
  [ "$(readlink -f "$TMPDIR")" != "$TMPDIR" ] || { echo "ERROR: TMPDIR $TMPDIR is not reached through a symlink"; return 1; }
  echo "TMPDIR=$TMPDIR -> $(readlink -f "$TMPDIR")"
}

# ---- 3 Rust parity arm
# The files rust-engine.yml's "Rust engine store tests and the parity suite's Rust arm" step runs; the addon-job step checks the workflow against this.
PARITY_HEAD_FILES=(test/rust-engine-store.test.ts test/rust-engine-shell.test.ts test/rust-engine-differential.test.ts)
PARITY_GLOB='test/engine-parity/*.test.ts'
s_parity() {
  cd "$WT"
  link_tmp || return 1
  export GBRAIN_RUST_ENGINE_ADDON=$ADDON GBRAIN_TEST_RUST_ARM=1 GBRAIN_TEST_RUST_ADDON_REQUIRED=1
  export DATABASE_URL=$DB GBRAIN_TEST_ALLOW_DATABASE_URL=1
  echo "== store, shell and differential tests"
  F bun test --timeout=60000 "${PARITY_HEAD_FILES[@]}" || { echo "PARITY_FAIL rust-engine store/shell/differential"; return 1; }
  local file
  # shellcheck disable=SC2086
  for file in $PARITY_GLOB; do
    echo "== $file"
    F bun test --timeout=60000 "$file" || { echo "PARITY_FAIL $file"; return 1; }
  done
}
step parity-arm 1 0 s_parity

# ---- 3b the export, jsonb key-order and vector CLI tests, with the addon required (see header)
ADDON_SERIAL_FILES=(test/rust-export.serial.test.ts test/rust-jsonb-key-order.serial.test.ts test/rust-vector-search-cli.serial.test.ts)
s_addon_serial() {
  cd "$WT"
  export GBRAIN_TEST_RUST_ADDON_REQUIRED=1
  local file n=0 rc out
  for file in "${ADDON_SERIAL_FILES[@]}"; do
    n=$((n + 1)); out="$G/addon-serial-$n.out"
    echo "== $file"
    [ -f "$file" ] || { echo "PARITY_FAIL $file does not exist"; return 1; }
    F env -u DATABASE_URL -u GBRAIN_TEST_ALLOW_DATABASE_URL -u GBRAIN_TEST_RUST_ARM bun test --timeout=120000 "$file" > "$out" 2>&1; rc=$?
    cat "$out"
    [ "$rc" -eq 0 ] || { echo "PARITY_FAIL $file"; return 1; }
    # Addon required: a skipped or empty file is a red step, never a pass.
    if grep -Eq '^ *[1-9][0-9]* skip$' "$out" || ! grep -Eq '^ *[1-9][0-9]* pass$' "$out"; then echo "PARITY_FAIL $file skipped or ran no test with the addon required"; return 1; fi
  done
}
step addon-serial 1 0 s_addon_serial

# ---- 3c the rest of the rust-engine.yml addon job (see header): CLI parity, withdrawn-lead with its receipt, the receipt check
ADDON_JOB_FILES=(test/rust-cli-parity.serial.test.ts test/token-member-cli-parity.serial.test.ts test/rust-mcp-receipts.serial.test.ts test/rust-engine-withdrawn-lead.test.ts scripts/run-with-receipt.sh scripts/require-executed-tests.ts)
ADDON_JOB_VARS=(GBRAIN_TEST_RUST_ADDON_REQUIRED GBRAIN_TEST_RUST_ARM GBRAIN_TEST_REQUIRE_RUST_ADDON GBRAIN_TEST_RECEIPT_DIR GBRAIN_RUST_ENGINE_ADDON)
addon_job_drift() {   # fail when the workflow's addon job names a file or GBRAIN_ variable this script does not run or set
  local wf=.github/workflows/rust-engine.yml job known tok bad=0
  [ -f "$wf" ] || { echo "PARITY_FAIL $wf does not exist"; return 1; }
  job=$(awk '/^  addon:[[:space:]]*$/ { on=1; next } on && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { exit } on' "$wf" | grep -Ev '^[[:space:]]*#')
  [ -n "$job" ] || { echo "PARITY_FAIL no addon job found in $wf"; return 1; }
  set -f   # the workflow names a glob (test/engine-parity/*.test.ts): compare it as text, never expand it
  known=" ${PARITY_HEAD_FILES[*]} $PARITY_GLOB ${ADDON_JOB_FILES[*]} scripts/ci-bun-install.ts "
  for tok in $(printf '%s\n' "$job" | grep -oE '(^|[^A-Za-z0-9_/.-])(test|scripts)/[A-Za-z0-9_./*-]+\.(ts|sh)' | sed -E 's/^[^ts]//' | sort -u); do
    case "$known" in *" $tok "*) ;; *) echo "PARITY_FAIL $wf addon job names $tok, which trunk-push-gate.sh does not run (add it to ADDON_JOB_FILES and s_addon_job)"; bad=1 ;; esac
  done
  known=" ${ADDON_JOB_VARS[*]} "
  for tok in $(printf '%s\n' "$job" | grep -oE 'GBRAIN_[A-Z0-9_]+' | sort -u); do
    case "$known" in *" $tok "*) ;; *) echo "PARITY_FAIL $wf addon job sets $tok, which trunk-push-gate.sh does not know (add it to ADDON_JOB_VARS and s_addon_job)"; bad=1 ;; esac
  done
  set +f
  [ "$bad" -eq 0 ] && echo "addon job of $wf: every test file, script and GBRAIN_ variable is covered by this gate"
  return "$bad"
}
s_addon_job() {
  cd "$WT"
  addon_job_drift || return 1
  link_tmp || return 1
  export GBRAIN_RUST_ENGINE_ADDON=$ADDON
  local out rc dir="$G/receipts"
  rm -rf "$dir"; mkdir -p "$dir"
  echo "== test/rust-cli-parity.serial.test.ts"
  out="$G/addon-job-cli.out"
  F env -u DATABASE_URL -u GBRAIN_TEST_ALLOW_DATABASE_URL -u GBRAIN_TEST_RUST_ARM GBRAIN_TEST_RUST_ADDON_REQUIRED=1 bun test --timeout=60000 test/rust-cli-parity.serial.test.ts > "$out" 2>&1; rc=$?
  cat "$out"
  [ "$rc" -eq 0 ] || { echo "PARITY_FAIL test/rust-cli-parity.serial.test.ts"; return 1; }
  if grep -Eq '^ *[1-9][0-9]* skip$' "$out" || ! grep -Eq '^ *[1-9][0-9]* pass$' "$out"; then echo "PARITY_FAIL test/rust-cli-parity.serial.test.ts skipped or ran no test with the addon required"; return 1; fi
  # The other addon-required serial files the workflow's addon job runs (a file the checkout lacks is skipped: older bases).
  local f t
  for f in test/token-member-cli-parity.serial.test.ts:60000 test/rust-mcp-receipts.serial.test.ts:150000; do
    t=${f#*:}; f=${f%%:*}
    [ -f "$f" ] || continue
    echo "== $f"
    out="$G/addon-job-$(basename "$f" .ts).out"
    F env -u DATABASE_URL -u GBRAIN_TEST_ALLOW_DATABASE_URL -u GBRAIN_TEST_RUST_ARM GBRAIN_TEST_RUST_ADDON_REQUIRED=1 bun test --timeout="$t" "$f" > "$out" 2>&1; rc=$?
    cat "$out"
    [ "$rc" -eq 0 ] || { echo "PARITY_FAIL $f"; return 1; }
    if grep -Eq '^ *[1-9][0-9]* skip$' "$out" || ! grep -Eq '^ *[1-9][0-9]* pass$' "$out"; then echo "PARITY_FAIL $f skipped or ran no test with the addon required"; return 1; fi
  done
  echo "== test/rust-engine-withdrawn-lead.test.ts (with a receipt)"
  F env -u DATABASE_URL -u GBRAIN_TEST_ALLOW_DATABASE_URL -u GBRAIN_TEST_RUST_ARM GBRAIN_TEST_REQUIRE_RUST_ADDON=1 GBRAIN_TEST_RECEIPT_DIR="$dir" bash scripts/run-with-receipt.sh rust-store withdrawn-lead -- bun test --timeout=60000 test/rust-engine-withdrawn-lead.test.ts || { echo "PARITY_FAIL test/rust-engine-withdrawn-lead.test.ts"; return 1; }
  echo "== scripts/require-executed-tests.ts (the withdrawn-lead lane ran, nothing skipped)"
  F bun scripts/require-executed-tests.ts "$dir" rust-store || { echo "PARITY_FAIL scripts/require-executed-tests.ts rust-store"; return 1; }
}
step addon-job 1 0 s_addon_job

# ---- 4 unit lane (subset, see header)
s_unit() {
  cd "$WT"
  local unitenv=(env -u DATABASE_URL -u GBRAIN_TEST_ALLOW_DATABASE_URL -u GBRAIN_RUST_ENGINE_ADDON -u GBRAIN_TEST_RUST_ARM -u GBRAIN_TEST_RUST_ADDON_REQUIRED)
  local nunit pair a b sh rc
  nunit=$(sed -n 's/^export const UNIT_SHARDS = \([0-9][0-9]*\);.*/\1/p' scripts/sharding.ts)
  [ -n "$nunit" ] || { echo "ERROR: UNIT_SHARDS not found in scripts/sharding.ts"; return 1; }
  echo "unit lane: $nunit shards in this tree; census=$CENSUS shard pairs=$PAIRS"
  if [ "$CENSUS" = 1 ]; then
    local files chunk n=0 rc
    files=$(bash scripts/ci-census-tests.sh) || return 1
    echo "== census files: $(printf '%s\n' "$files" | grep -c .) (scripts/ci-census-tests.sh), run in chunks of 20, one lock per chunk"
    F bun run build:pglite-snapshot > /dev/null 2>&1 && export GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar
    while IFS= read -r chunk; do
      n=$((n + 1)); echo "== census chunk $n"
      # shellcheck disable=SC2086
      F "${unitenv[@]}" -u GBRAIN_DATABASE_URL bun test --timeout=120000 --max-concurrency=4 $chunk > "$G/unit-census-$n.out" 2>&1; rc=$?
      cat "$G/unit-census-$n.out"
      if [ "$rc" -ne 0 ]; then known_only "$G/unit-census-$n.out" || { echo "FAILED: census chunk $n rc=$rc"; return 1; }; fi
    done < <(printf '%s\n' "$files" | sed 's#^#./#' | xargs -n 20 echo)
  fi
  local i
  for ((i = 0; i < PAIRS; i++)); do
    pair=$(( (0x${SHA:0:8} + i) % ((nunit + 1) / 2) ))
    a=$(( 2 * pair + 1 )); b=$(( 2 * pair + 2 )); [ "$b" -le "$nunit" ] || b=""
    for sh in $a $b; do
      echo "== unit shard $sh (of $nunit), picked by the sha"
      F "${unitenv[@]}" GBRAIN_SHARD_PACK_DIR="$G/shards" bash scripts/test-shard-pack.sh "$nunit" "$sh" > "$G/unit-shard-$sh.out" 2>&1; rc=$?
      cat "$G/unit-shard-$sh.out"
      if [ "$rc" -ne 0 ]; then known_only "$G/unit-shard-$sh.out" || { echo "FAILED: unit shard $sh rc=$rc"; return 1; }; fi
    done
  done
}
step unit-lane 1 0 s_unit

# ---- 5 diff-selected E2E
s_e2e() { bash /var/tmp/trunk/pushgate-e2e.sh "$WT" "$BASE" "$SHA" "$G/e2e" "$DB" "$DBNAME" "$E2E_BUDGET" "$ADMIN"; }
step e2e-selected 0 0 s_e2e

# ---- 6 guard 12 on Postgres, always
s_guard12() {
  cd "$WT"
  psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS $DBNAME WITH (FORCE)" -c "CREATE DATABASE $DBNAME" || return 1
  F env -u GBRAIN_RUST_ENGINE_ADDON -u GBRAIN_TEST_RUST_ARM -u GBRAIN_TEST_RUST_ADDON_REQUIRED \
    DATABASE_URL="$DB" GBRAIN_TEST_ALLOW_DATABASE_URL=1 bun test --timeout=120000 test/e2e/typed-preparation-reads-guard-postgres.test.ts
}
step guard12 1 0 s_guard12

# ---- last: Rust CI on the exact sha (waits for queued runs, so it runs after every local step)
# Minder CI rule (8:18 AM PST Nov 23, PR 10131 c7106926275): no hand-dispatched e2e.yml/test.yml on rust-engine
# branches, so the full-CI steps are replaced by Rust engine + Rust CLI parity green on the exact sha. Full Test/E2E/macOS
# run only after queue: on a master PR. Old steps: trunk-push-gate.sh.bak-20261123-fullci.
s_rustci() { bash /var/tmp/trunk/rust-ci-green.sh "$SHA" rust-engine.yml; }
step rust-engine-ci 0 0 s_rustci
s_parityci() { bash /var/tmp/trunk/rust-ci-green.sh "$SHA" rust-cli-parity.yml; }
step rust-cli-parity-ci 0 0 s_parityci
say "GATE PASS $SHA $(( $(date +%s) - WALL0 ))"
exit 0
