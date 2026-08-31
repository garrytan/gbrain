#!/usr/bin/env bash
# scripts/run-unit-parallel.sh — fast unit-test loop, parallel fan-out.
#
# Spawns N parallel `bun test` processes, each running a hash-disjoint shard
# of the unit-test set (files only — no e2e, no .slow, no .serial). After
# all shards complete, runs serial-only files (*.serial.test.ts) with
# --max-concurrency=1. Failure-first logging: extracts failure blocks from
# each shard's log, writes to .context/test-failures.log with --- shard $i:
# prefixes, prints loud stderr banner if any failures, exit non-zero.
#
# Usage:
#   bash scripts/run-unit-parallel.sh [--shards N] [--max-concurrency N] [--dry-run]
#
# Env overrides:
#   SHARDS=N                     same as --shards
#   GBRAIN_TEST_SHARD_TIMEOUT    per-shard wallclock cap, seconds (default 3000)
#   GBRAIN_TEST_SHARD_KILL_AFTER grace after TERM before KILL (default 30)
#   GBRAIN_TEST_MAX_CONCURRENCY  passed through to bun test (default 4)
#   GBRAIN_TEST_MEM_PER_FILE_MB  memory budget per concurrent test file used by
#                                the adaptive sizing below (default 1536 — a
#                                PGLite WASM instance reserves ~1-1.5GB)
#   GBRAIN_TEST_NO_MEM_ADAPT=1   disable memory-aware concurrency reduction
#   GBRAIN_TEST_NO_OOM_FALLBACK=1 disable the serial OOM-rescue pass
#
# Memory safety (two layers; both default-on):
#   1. ADAPTIVE SIZING — before spawning, total concurrency (shards ×
#      intra-shard --max-concurrency) is capped to what available memory can
#      hold at GBRAIN_TEST_MEM_PER_FILE_MB per concurrent file. Concurrent
#      Conductor workspaces running their own suites shrink the budget
#      automatically instead of OOMing each other.
#   2. SERIAL PHANTOM RESCUE — two phantom classes are re-run serially
#      (--max-concurrency 1) after the parallel pass: (a) failures whose
#      shard log carries the PGLite WASM out-of-memory signature, and
#      (b) shards killed EXTERNALLY (SIGTERM/SIGKILL well before the shard
#      timeout — sibling Conductor workspaces' process cleanup, macOS memory
#      jetsam). Phantoms pass serially and the run goes green with an
#      oom_rescued note; real failures fail again and stay red. Plain
#      assertion failures never match either signature.
#
# Output files (workspace-local; falls back to /tmp if .context/ unwritable):
#   .context/test-failures.log   failure blocks (cleared at start)
#   .context/test-summary.txt    per-shard pass/fail/skip/duration (cleared at start)
#   .context/test-shards/        per-shard logs + exit codes (cleared at start)

set -uo pipefail

# Fixture tests that `git commit` in temp repos must not inherit the developer's
# global commit.gpgsign — a signing gpg-agent can OOM under full-suite memory
# pressure and fail the commit ("gpg: signing failed: Cannot allocate memory",
# #1696). git applies these env keys as highest-precedence config on every
# invocation in this process tree, so all child `git commit`s run unsigned.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="commit.gpgsign" GIT_CONFIG_VALUE_0="false"

# #3485: unit tests need no database — strip ambient DB URLs at this wrapper
# boundary so the bunfig preload guard passes and nothing can reach a real
# brain. The e2e wrapper (run-e2e.sh) is the only lane that keeps them.
unset DATABASE_URL GBRAIN_DATABASE_URL
# An ambient GBRAIN_HOME (a dev shell configured for a real brain) must not
# reach unit tests either: the gbrain-home-preload respects a pre-set value
# (the e2e wrapper needs that), so strip it at this boundary and let the
# preload allocate per-run scratch instead.
unset GBRAIN_HOME

cd "$(dirname "$0")/.."

# ──────────────────────────────────────────────────────────────────────────
# W0 fix-wave (Tier-1 #16): PGLite schema snapshot, DEFAULT-ON for the plain
# `bun run test` loop. 500+ test files each cold-boot PGLite + replay 126
# migrations without it; the fixture was previously enabled ONLY inside
# scripts/ci-local.sh, so the everyday loop paid the full cost. The build
# script is idempotent (hash short-circuit) and concurrency-safe (mkdir
# lock, D5.8), and its hash folds handler-migration source (D5.13), so an
# unconditional call here is cheap and always current. Runs BEFORE the shard
# fan-out — shards inherit a finished fixture. Opt out: GBRAIN_NO_SNAPSHOT=1
# (the migration-replay canary tests clear the env themselves regardless).
# ──────────────────────────────────────────────────────────────────────────
# detect_cpus / detect_available_mem_mb / ensure_pglite_snapshot live in the
# shared lib (also sourced by test-shard.sh, run-serial-tests.sh,
# run-slow-tests.sh) — one implementation, no copy drift.
. scripts/lib/test-env.sh
ensure_pglite_snapshot "run-unit-parallel"

# ──────────────────────────────────────────────────────────────────────────
# Argument parsing. --shards N override wins over $SHARDS; both are clamped.
# ──────────────────────────────────────────────────────────────────────────
SHARDS_OVERRIDE=""
MAX_CONCURRENCY_OVERRIDE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --shards) SHARDS_OVERRIDE="$2"; shift 2 ;;
    --shards=*) SHARDS_OVERRIDE="${1#*=}"; shift ;;
    --max-concurrency) MAX_CONCURRENCY_OVERRIDE="$2"; shift 2 ;;
    --max-concurrency=*) MAX_CONCURRENCY_OVERRIDE="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

N="${SHARDS_OVERRIDE:-${SHARDS:-$(detect_cpus)}}"
if ! printf '%s' "$N" | grep -qE '^[0-9]+$' || [ "$N" -lt 1 ]; then
  echo "ERROR: invalid shard count: $N" >&2; exit 2
fi
# v0.40.10 flake-hardening: clamp default to 4 (was 8) to match CI's
# test-shard.sh fan-out. At 8-shard parallel on Apple Silicon we observed
# shard 5 SIGKILL during source-health.test.ts's PGLite migration replay —
# 8 parallel PGLite WASM inits contend severely on the lockfile, and the
# 92-migration replay × 8 simultaneous can wedge past even 900s. CI uses
# 4 and is stable. Trade ~2x wallclock for reliability + parity with CI's
# fan-out. Override via --shards N or SHARDS=N (still capped at 8).
[ "$N" -gt 8 ] && N=8
if [ -z "${SHARDS_OVERRIDE:-}" ] && [ -z "${SHARDS:-}" ] && [ "$N" -gt 4 ]; then
  N=4
fi

INTRA_CONC="${MAX_CONCURRENCY_OVERRIDE:-${GBRAIN_TEST_MAX_CONCURRENCY:-4}}"
# v0.40.10 flake-hardening: bump per-shard cap 600 → 1500 (was 900). At
# 4-shard default each shard runs 159 files / ~2420 tests with internal
# wallclock 960-1020s. The 900s value (sized for 8-shard's ~80 files /
# 1100 tests at 620-770s) false-killed shard 1 at 900s even though it
# had completed in 968s. The cap must track suite growth: the suite roughly
# tripled since the 1500s cap was set (June: ~3900 tests, 92-migration PGLite
# replay; now: 13k+ tests with the agent-bootstrap wave, 120-migration replay
# per PGLite init). The split balances file COUNT, not weight — the heaviest
# count-balanced shard is still making steady per-test progress at 1800s under
# 4-way contention while its siblings finish at 1150-1550s. 3000s keeps the
# ~55%-headroom doctrine over observed wallclock; genuinely hung TESTS still
# die at bun's per-test timeout, mid-run stalls still hit this cap, and
# post-completion exit-hangs are classified separately (see the EXIT-HANG
# block below). Override via GBRAIN_TEST_SHARD_TIMEOUT=N.
SHARD_TIMEOUT="${GBRAIN_TEST_SHARD_TIMEOUT:-3000}"
SHARD_KILL_AFTER="${GBRAIN_TEST_SHARD_KILL_AFTER:-30}"
if ! printf '%s' "$SHARD_KILL_AFTER" | grep -qE '^[0-9]+$' || [ "$SHARD_KILL_AFTER" -lt 1 ]; then
  echo "ERROR: invalid shard kill-after: $SHARD_KILL_AFTER" >&2; exit 2
fi

# ──────────────────────────────────────────────────────────────────────────
# Memory-aware concurrency (layer 1). Total concurrent test files =
# N shards × INTRA_CONC; each concurrent file can hold a PGLite WASM
# instance (~1-1.5GB reserved). 4×4 = 16 concurrent instances OOM'd on a
# 128GB machine when other Conductor workspaces ran their suites at the
# same time — every PGLite connect across every shard failed at once
# ("Out of memory" at PGlite.create). Cap total concurrency to what's
# actually available, keeping a 4GB reserve for the OS + bun itself.
# Applies to explicit --shards overrides too (an operator who wants an
# over-committed run sets GBRAIN_TEST_NO_MEM_ADAPT=1).
# ──────────────────────────────────────────────────────────────────────────
MEM_PER_FILE_MB="${GBRAIN_TEST_MEM_PER_FILE_MB:-1536}"
MEM_NOTE=""
if [ "${GBRAIN_TEST_NO_MEM_ADAPT:-0}" != "1" ]; then
  AVAIL_MB=$(detect_available_mem_mb)
  if [ "${AVAIL_MB:-0}" -gt 0 ] 2>/dev/null; then
    BUDGET_MB=$((AVAIL_MB - 4096))
    [ "$BUDGET_MB" -lt "$MEM_PER_FILE_MB" ] && BUDGET_MB="$MEM_PER_FILE_MB"
    MAX_TOTAL=$((BUDGET_MB / MEM_PER_FILE_MB))
    [ "$MAX_TOTAL" -lt 1 ] && MAX_TOTAL=1
    ORIG_N="$N"; ORIG_INTRA="$INTRA_CONC"
    # Shed intra-shard concurrency before shards. `bun test --max-concurrency`
    # only bounds test.concurrent tests (1 file in the corpus) — every other
    # file runs serially inside its shard process, so INTRA_CONC is nearly
    # free to shed: dropping it costs no throughput, while dropping a SHARD
    # removes a whole bun process of real fan-out. The old order (shards
    # first) collapsed a 16GB box to 1x4 — effectively a serial run behind a
    # 12000s watchdog (measured 3.25x slower than 4 shards on the same box).
    while [ $((N * INTRA_CONC)) -gt "$MAX_TOTAL" ]; do
      if [ "$INTRA_CONC" -gt 1 ]; then INTRA_CONC=$((INTRA_CONC - 1))
      elif [ "$N" -gt 1 ]; then N=$((N - 1))
      else break
      fi
    done
    if [ "$N" != "$ORIG_N" ] || [ "$INTRA_CONC" != "$ORIG_INTRA" ]; then
      # Fewer shards → more files per shard → each shard legitimately runs
      # longer. Scale the per-shard cap by the shed ratio so adaptation
      # doesn't convert memory safety into false WEDGED verdicts.
      if [ "$N" -lt "$ORIG_N" ]; then
        SHARD_TIMEOUT=$((SHARD_TIMEOUT * ORIG_N / N))
      fi
      MEM_NOTE=" | mem-adapted ${ORIG_N}x${ORIG_INTRA}→${N}x${INTRA_CONC} (avail=${AVAIL_MB}MB, ${MEM_PER_FILE_MB}MB/file, timeout→${SHARD_TIMEOUT}s)"
    else
      MEM_NOTE=" | mem-ok (avail=${AVAIL_MB}MB)"
    fi
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Output directories. Prefer workspace-local .context/, fall back to /tmp.
# ──────────────────────────────────────────────────────────────────────────
LOG_DIR=""
if mkdir -p .context/test-shards 2>/dev/null; then
  LOG_DIR=".context/test-shards"
  FAILURES_LOG=".context/test-failures.log"
  SUMMARY_FILE=".context/test-summary.txt"
else
  LOG_DIR="/tmp/gbrain-test-shards-$$"
  FAILURES_LOG="/tmp/gbrain-test-failures.log"
  SUMMARY_FILE="/tmp/gbrain-test-summary.txt"
  mkdir -p "$LOG_DIR" || { echo "ERROR: cannot create log dir" >&2; exit 2; }
fi
# Clear from prior run.
rm -f "$LOG_DIR"/shard-*.log "$LOG_DIR"/shard-*.exit "$LOG_DIR"/shard-*.wedged "$LOG_DIR"/shard-*.lastkb "$LOG_DIR"/shard-*.lastprogress "$LOG_DIR"/shard-*.start "$LOG_DIR"/shard-*.end "$LOG_DIR"/shard-*.watchdog "$LOG_DIR"/shard-*.assigned "$LOG_DIR"/shard-*.hbsum 2>/dev/null
: > "$FAILURES_LOG"
: > "$SUMMARY_FILE"

# ──────────────────────────────────────────────────────────────────────────
# Resolve `timeout` command. macOS without coreutils has neither; we degrade
# to bg-pid + sleep cap. For now, prefer gtimeout (brew coreutils) → timeout.
# ──────────────────────────────────────────────────────────────────────────
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi

START_TS=$(date +%s)
echo "[unit-parallel] N=$N shards | --max-concurrency=$INTRA_CONC | timeout=${SHARD_TIMEOUT}s | kill-after=${SHARD_KILL_AFTER}s | logs=$LOG_DIR${MEM_NOTE}" >&2

if [ "$DRY_RUN" = "1" ]; then
  echo "[unit-parallel] dry-run: would spawn $N shards with the above settings."
  for i in $(seq 1 "$N"); do
    SHARD="$i/$N" bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null \
      | sed "s|^|  [s$i] |"
  done
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────────
# Spawn shards. Each child captures its own exit code into a sentinel file
# so $? is recoverable per-shard (we never trust `wait`'s aggregate value).
# ──────────────────────────────────────────────────────────────────────────
SHARD_PIDS=()
for i in $(seq 1 "$N"); do
  (
    SHARD_LOG="$LOG_DIR/shard-$i.log"
    date +%s > "$LOG_DIR/shard-$i.start"
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" --signal=TERM --kill-after="${SHARD_KILL_AFTER}s" "${SHARD_TIMEOUT}s" \
        env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1
      rc=$?
    else
      env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        > "$SHARD_LOG" 2>&1 &
      pid=$!
      ( sleep "$SHARD_TIMEOUT" && touch "$LOG_DIR/shard-$i.watchdog" && \
        kill -TERM "$pid" 2>/dev/null && \
        sleep "$SHARD_KILL_AFTER" && kill -KILL "$pid" 2>/dev/null ) &
      cap_pid=$!
      wait "$pid" 2>/dev/null
      # Capture the shard's exit code from ITS `wait`, before any watchdog
      # teardown runs. The teardown commands below overwrite $? — the killed
      # watchdog reports 143 — which used to get stamped into every shard's
      # sentinel on machines with no gtimeout/timeout: every run "failed"
      # with rc=143 summaries even when all tests passed.
      rc=$?
      # Reap the watchdog's `sleep` child too (pkill -P), then the watchdog.
      # Killing only the subshell leaves the sleep orphaned until
      # $SHARD_TIMEOUT elapses — same quirk the heartbeat cleanup below works
      # around; CI's orphan-process sweep flags those.
      pkill -P "$cap_pid" 2>/dev/null
      kill "$cap_pid" 2>/dev/null
      wait "$cap_pid" 2>/dev/null
    fi
    date +%s > "$LOG_DIR/shard-$i.end"
    echo "$rc" > "$LOG_DIR/shard-$i.exit"
    { [ "$rc" = "124" ] || [ "$rc" = "137" ]; } && echo "WEDGED" > "$LOG_DIR/shard-$i.wedged"
    # No-timeout-binary fallback: its watchdog TERMs the shard (rc 143), which
    # the 124/137 line above can't see — the sentinel dropped right before the
    # TERM marks the wedge, so the EXIT-HANG/WEDGED classifier is reachable on
    # machines without coreutils timeout instead of a bare rc=143 hard-fail.
    [ -f "$LOG_DIR/shard-$i.watchdog" ] && { [ "$rc" = "143" ] || [ "$rc" = "137" ]; } \
      && echo "WEDGED" > "$LOG_DIR/shard-$i.wedged"
  ) &
  SHARD_PIDS+=($!)
done

# ──────────────────────────────────────────────────────────────────────────
# Heartbeat: every 10s, print per-shard progress to stderr by tailing logs
# and counting Bun's `(pass)` / `(fail)` / `(skip)` markers. Read-only.
# ──────────────────────────────────────────────────────────────────────────
# grep_count: returns 0 (single integer) if file is missing or zero matches,
# otherwise the match count. Avoids the `grep -c | echo 0` double-output bug
# where 0 matches produces a 2-line "0\n0" string that breaks arithmetic.
grep_count() {
  local pattern="$1"; local file="$2"
  if [ ! -f "$file" ]; then echo 0; return; fi
  local n
  n=$(grep -cE "$pattern" "$file" 2>/dev/null) || n=0
  echo "${n:-0}"
}

# strip_ansi: emit FILE with SGR color sequences removed.
#
# Every parser below reads a log that `bun test` wrote to a pipe with color
# still enabled, so its lines carry SGR escapes:
#     ESC[0mESC[32m 5385 passESC[0m
#     ESC[0mESC[31m✗ESC[0m ESC[0msome test name
# Parsing those raw makes awk's $1 the escape blob rather than the count or the
# marker — which silently produced `pass=0 fail=0` on shards that had thousands
# of passes, and stopped every `✗`/`(fail)` pattern below from ever matching.
# The ESC is built with printf rather than written as `\x1b`, because BSD sed
# (macOS) does not understand `\x` escapes.
strip_ansi() {
  local esc
  esc=$(printf '\033')
  sed "s/${esc}\[[0-9;]*[a-zA-Z]//g" "$1"
}

# bun_summary_count: parses Bun's summary lines (one per `bun test` invocation
# inside a shard — there's only one when we pass an explicit file list).
# Looks for ` N pass` / ` N fail` / ` N skip` patterns and sums them across
# all summary blocks the shard emitted. `bun test` prints these near the end
# of its output. Format: leading whitespace + integer + space + label.
bun_summary_count() {
  local label="$1"; local file="$2"
  if [ ! -f "$file" ]; then echo 0; return; fi
  strip_ansi "$file" | awk -v label="$label" '
    $1 ~ /^[0-9]+$/ && $2 == label { total += $1 }
    END { print total + 0 }
  '
}

# shard_total_files: parse the "[unit-shard N/M] running X files" line that
# run-unit-shard.sh echoes before invoking bun test. Returns the file count
# the shard was given, or 0 if the line isn't there yet (shard still
# bootstrapping). Uses sed-then-grep so it's portable to macOS awk (BSD awk
# doesn't support `match($0, /re/, arr)` with the array sink — that's gawk-only).
shard_total_files() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  local n
  n=$(sed -n 's/^\[unit-shard [0-9][0-9]*\/[0-9][0-9]*\] running \([0-9][0-9]*\) files.*/\1/p' "$file" 2>/dev/null | head -1)
  echo "${n:-0}"
}

# shard_pglite_init_count: count "Schema version" lines as a proxy for "test
# files initialized so far." Each PGLite-using test file's beforeAll triggers
# one initSchema() which prints this. Undercounts because not every test file
# opens a PGLite engine, but it's the only real-time progress signal bun's
# default reporter leaves in the log (bun has no per-file progress markers,
# only a final shard-end summary).
shard_pglite_init_count() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  grep -cE 'Schema version [0-9]+ → [0-9]+' "$file" 2>/dev/null || echo 0
}

# log_size_kb: total stderr+stdout written by the shard so far. Strictly
# monotonic — useful as a "definitely alive" signal when other heuristics
# read 0 (e.g. very early in shard startup before initSchema fires).
log_size_kb() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  local b
  b=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
  echo $(( ${b:-0} / 1024 ))
}

# fmt_elapsed: pretty-print seconds → "Mm:SS" or "SSs" for short.
fmt_elapsed() {
  local s=$1
  if [ "$s" -ge 60 ]; then
    printf '%dm%02ds' $((s / 60)) $((s % 60))
  else
    printf '%ds' "$s"
  fi
}

heartbeat() {
  local hb_start=$(date +%s)
  while true; do
    sleep 10
    local line=""
    local now; now=$(date +%s)
    local hb_elapsed=$((now - hb_start))
    for i in $(seq 1 "$N"); do
      if [ -f "$LOG_DIR/shard-$i.exit" ]; then
        # Finished shards never change: compute the summary once at first
        # sight of .exit and cache it — re-running strip_ansi+awk over a
        # multi-MB log twice per shard on every 10s tick was hundreds of
        # full-file passes per run.
        local rc p f
        if [ ! -f "$LOG_DIR/shard-$i.hbsum" ]; then
          rc=$(cat "$LOG_DIR/shard-$i.exit" 2>/dev/null || echo "?")
          p=$(bun_summary_count "pass" "$LOG_DIR/shard-$i.log")
          f=$(bun_summary_count "fail" "$LOG_DIR/shard-$i.log")
          echo "$rc $p $f" > "$LOG_DIR/shard-$i.hbsum"
        fi
        read -r rc p f < "$LOG_DIR/shard-$i.hbsum"
        local status="✓"
        [ "$rc" != "0" ] && status="✗"
        line="$line [s$i: done $status ${p}p ${f}f]"
      else
        local lf="$LOG_DIR/shard-$i.log"
        if [ -f "$lf" ]; then
          # Bun's default reporter has no per-file progress markers, only a
          # final shard-end summary, so we surface three complementary signals
          # mid-run: (1) PGLite initSchema() count as a "files started" proxy,
          # (2) total files this shard was assigned (from the runner banner),
          # (3) log size in KB as a strictly-monotonic liveness signal.
          local total; total=$(shard_total_files "$lf")
          local pglite; pglite=$(shard_pglite_init_count "$lf")
          local kb; kb=$(log_size_kb "$lf")
          local et; et=$(fmt_elapsed "$hb_elapsed")
          # Progress stamp for the exit-hang classifier: any log growth counts
          # as progress. A wedged shard whose log went silent (≥ idle window)
          # with zero fails did its work and hung at exit.
          local prev_kb=""
          [ -f "$LOG_DIR/shard-$i.lastkb" ] && prev_kb=$(cat "$LOG_DIR/shard-$i.lastkb" 2>/dev/null)
          if [ "$kb" != "$prev_kb" ]; then
            echo "$kb" > "$LOG_DIR/shard-$i.lastkb"
            echo "$now" > "$LOG_DIR/shard-$i.lastprogress"
          fi
          if [ "$total" -gt 0 ]; then
            line="$line [s$i: ~${pglite}/${total}f ${kb}KB ${et}]"
          else
            line="$line [s$i: starting ${kb}KB ${et}]"
          fi
        else
          line="$line [s$i: spawning]"
        fi
      fi
    done
    printf '[heartbeat] %s\n' "$line" >&2
  done
}
heartbeat &
HB_PID=$!
# v0.41.11.0 cleanup: pkill children FIRST, then kill heartbeat. If we
# kill the heartbeat shell first, its current `sleep 10` is reparented
# to init/launchd and pkill -P can no longer find it (orphan). Order:
# children first while the parent PID is still findable, then parent.
# Known bash quirk: SIGTERM to a shell sleeping inside `sleep` doesn't
# propagate to the sleep child before the wait returns. Without this,
# each invocation of this script leaks ONE orphan sleep; CI's "orphan
# process cleanup" at end-of-job reports them as (unnamed) test failures.
# Seen on the garrytan/port-pr-1406 PR, 2 CI runs in a row, 6 orphans
# matching the 6 invocations in test/scripts/run-unit-parallel.test.ts.
trap 'pkill -P "$HB_PID" 2>/dev/null; kill "$HB_PID" 2>/dev/null; wait "$HB_PID" 2>/dev/null' EXIT

# Wait for every shard. Don't care about wait's exit code.
for pid in "${SHARD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

pkill -P "$HB_PID" 2>/dev/null
kill "$HB_PID" 2>/dev/null
wait "$HB_PID" 2>/dev/null
trap - EXIT

# ──────────────────────────────────────────────────────────────────────────
# Aggregate failures (single writer; serial; never concurrent).
# Bun failure block format: from the failure marker line through the next pass
# marker, `(skip)`, blank line, or `__bun_test_summary__`. Bun 1.3 emits `✗ ` /
# `✓ `; older releases emitted `(fail) ` / `(pass) `. Both are matched, and every
# parse runs on ANSI-stripped text — the markers are color-wrapped on the wire,
# so raw patterns silently matched nothing.
# ──────────────────────────────────────────────────────────────────────────
TOTAL_FAILURES=0
TOTAL_PASS=0
TOTAL_SKIP=0
TOTAL_RC=0

# Layer 2 state (serial OOM rescue). A shard whose log carries the WASM
# out-of-memory signature gets its failing files queued for a serial re-run;
# NON_OOM_FAIL records that at least one failure exists that the rescue lane
# must NOT absolve (plain assertion failures, wedges without the signature).
OOM_RE='Out of memory|WebAssembly\.Memory|RuntimeError: [Aa]borted|Aborted\(\)'

# oom_signature_in_log: true when FILE carries a genuine WASM OOM signature.
#
# Not a bare `grep -qE "$OOM_RE"`. The signature is ordinary text, so any test
# that merely PRINTS it trips the detector — and one does: the rescue lane's own
# meta-test (test/scripts/run-unit-parallel.test.ts) writes fixtures containing
# `Original error: Out of memory` and asserts on the nested runner's output. When
# that assertion fails, Bun prints the captured payload as an `Expected:` /
# `Received:` diff, the fixture text lands in the PARENT shard log, and the
# parent concludes a real OOM occurred — re-running every file in the shard
# serially. Observed 2026-08-11: a full 372-file serial rescue kicked off on a
# machine with 19 GB free, triggered by the test that exists to verify rescue.
#
# Assertion payloads are therefore excluded. A real OOM aborts the file and the
# signature appears as runtime output on its own line; it never shows up ONLY
# inside a quoted expect() diff. Keeps the safety net armed for real OOMs while
# refusing to be fooled by a string a test happened to print.
oom_signature_in_log() {
  local file="$1"
  [ -f "$file" ] || return 1
  strip_ansi "$file" \
    | grep -vE '^[[:space:]]*(Expected|Received):' \
    | grep -qE "$OOM_RE"
}

OOM_RESCUE_LIST="$LOG_DIR/oom-rescue-files.txt"
: > "$OOM_RESCUE_LIST"
NON_OOM_FAIL=0
# Set when any shard was killed externally — killed-midrun shards leave lock/
# state residue that can poison the LATER serial pass, so serial failures are
# only rescue-eligible under this flag (or their own OOM signature). A flaky
# serial test in an otherwise-clean run must stay red.
EXTERNAL_KILL_ANY=0

# failing_files_in_log: attribute each `(fail)` block to the test file whose
# `path.test.ts:` header most recently preceded it in bun's output. Under
# GITHUB_ACTIONS the shard wraps each file section as `::group::path.test.ts:`
# — strip that prefix or the rescue pass feeds bun literal `::group::...`
# non-paths that match zero test files (CI-only; local runs have no groups).
failing_files_in_log() {
  local file="$1"
  [ -f "$file" ] || return 0
  strip_ansi "$file" | awk '
    /^(::group::)?[^ ].*\.test\.ts:$/ {
      current = $0
      sub(/^::group::/, "", current)
      current = substr(current, 1, length(current) - 1)
      next
    }
    /^(\(fail\) |✗ )/ && current != "" { print current }
  ' | sort -u
}

# shard_assigned_list: the deterministic per-shard file list, computed once
# per shard and cached — shard_unstarted_files and the rescue-queue appends
# used to re-walk `find test` via --dry-run-list up to 3x per wedged shard.
shard_assigned_list() {
  local shard_idx="$1" cache="$LOG_DIR/shard-$shard_idx.assigned"
  if [ ! -f "$cache" ]; then
    # Cache ONLY on success (tmp + mv): a failed/truncated first attempt —
    # most likely under the exact fork-pressure conditions this path runs in —
    # must not be served to the rescue queue as a partial file list.
    if SHARD="$shard_idx/$N" bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null > "$cache.tmp"; then
      mv "$cache.tmp" "$cache"
    else
      rm -f "$cache.tmp"
      # Loud, not silent: an underivable list means a rescue-queue append got
      # NOTHING while the summary says the shard was queued.
      echo "⚠️  shard $shard_idx/$N: assigned-file list underivable — rescue queue may be incomplete" >&2
      return 0
    fi
  fi
  cat "$cache"
}

# shard_unstarted_files: completion evidence for the EXIT-HANG classifier.
# Prints every file assigned to shard $1 (same deterministic split the shard
# itself used, via --dry-run-list) whose started file-header never appeared
# in the shard log $2. Bun prints `path.test.ts:` as each file starts; under
# GITHUB_ACTIONS that header is wrapped as `::group::path.test.ts:` — both
# forms count as started. Fail-closed: an underivable assigned list or a
# missing log emits markers so the caller treats the shard as WEDGED rather
# than warn-passing without evidence.
shard_unstarted_files() {
  local shard_idx="$1" log="$2"
  local assigned
  assigned=$(shard_assigned_list "$shard_idx")
  if [ -z "$assigned" ]; then
    echo "(assigned-file-list-underivable)"
    return
  fi
  if [ ! -f "$log" ]; then
    printf '%s\n' "$assigned"
    return
  fi
  local af
  while IFS= read -r af; do
    [ -n "$af" ] || continue
    if ! grep -qxF "${af}:" "$log" && ! grep -qxF "::group::${af}:" "$log"; then
      printf '%s\n' "$af"
    fi
  done <<< "$assigned"
}

for i in $(seq 1 "$N"); do
  SHARD_LOG="$LOG_DIR/shard-$i.log"
  EXIT_FILE="$LOG_DIR/shard-$i.exit"
  WEDGED_FILE="$LOG_DIR/shard-$i.wedged"
  rc=1
  [ -f "$EXIT_FILE" ] && rc=$(cat "$EXIT_FILE" 2>/dev/null || echo 1)

  pass_count=$(bun_summary_count "pass" "$SHARD_LOG")
  fail_count=$(bun_summary_count "fail" "$SHARD_LOG")
  skip_count=$(bun_summary_count "skip" "$SHARD_LOG")
  TOTAL_PASS=$((TOTAL_PASS + pass_count))
  TOTAL_FAILURES=$((TOTAL_FAILURES + fail_count))
  TOTAL_SKIP=$((TOTAL_SKIP + skip_count))

  shard_oom=0
  if [ "$rc" != "0" ] && [ "${GBRAIN_TEST_NO_OOM_FALLBACK:-0}" != "1" ] \
     && [ -f "$SHARD_LOG" ] && oom_signature_in_log "$SHARD_LOG"; then
    shard_oom=1
  fi

  # External-kill detection: rc 143 (SIGTERM) / 137 (SIGKILL) with the shard
  # dying before 80% of the shard timeout means something OUTSIDE the runner
  # killed it — sibling Conductor workspaces' process cleanup and macOS
  # memory jetsam both present exactly this way (observed: 3 shards TERM'd +
  # 1 KILL'd at ~700s under a 3000s cap, all mid-progress). A REAL wedge is
  # killed BY the runner at ~SHARD_TIMEOUT and stays red. Externally-killed
  # shards are phantoms: queue for the serial rescue lane like OOM.
  shard_external_kill=0
  if [ "$shard_oom" = "0" ] && [ "${GBRAIN_TEST_NO_OOM_FALLBACK:-0}" != "1" ] \
     && { [ "$rc" = "143" ] || [ "$rc" = "137" ]; }; then
    s_start=$(cat "$LOG_DIR/shard-$i.start" 2>/dev/null) || s_start=""
    s_end=$(cat "$LOG_DIR/shard-$i.end" 2>/dev/null) || s_end=""
    if [ -n "$s_start" ] && [ -n "$s_end" ]; then
      s_elapsed=$((s_end - s_start))
      if [ "$s_elapsed" -lt $((SHARD_TIMEOUT * 80 / 100)) ]; then
        shard_external_kill=1
        EXTERNAL_KILL_ANY=1
      fi
    fi
  fi

  if [ -f "$WEDGED_FILE" ]; then
    # EXIT-HANG classifier (pre-existing PGLite-adjacent leak, TODOS.md
    # "unit-shard exit hang"): a shard killed by the watchdog whose log shows
    # every assigned file STARTED and zero (fail) markers did all its work and
    # then failed to exit (a leaked ref'd handle; reproduces on master with
    # the same file combination). Bun's per-test --timeout turns a genuinely
    # hung TEST into a (fail), so this cannot mask one — the residual
    # maskable case is a file-level import hang in the very last file, which
    # the loud banner keeps visible. Classified shards warn instead of
    # red-Xing the run; their pass counts are undercounted (bun never printed
    # its final summary before the kill).
    inline_fails=$(grep_count '^\(fail\) ' "$SHARD_LOG")
    # Idle window: the log stopped growing this long before the kill. Bun's
    # per-test --timeout turns a hung TEST into a printed (fail) — new output —
    # so a silent-with-zero-fails shard was done with its work.
    idle_secs=-1
    if [ -f "$LOG_DIR/shard-$i.lastprogress" ] && [ -f "$WEDGED_FILE" ]; then
      last_prog=$(cat "$LOG_DIR/shard-$i.lastprogress" 2>/dev/null || echo 0)
      kill_ts=$(stat -f %m "$WEDGED_FILE" 2>/dev/null || stat -c %Y "$WEDGED_FILE" 2>/dev/null || echo 0)
      [ "$kill_ts" -gt 0 ] && [ "$last_prog" -gt 0 ] && idle_secs=$((kill_ts - last_prog))
    fi
    # Warn-pass gate: rescue-eligible kills (OOM signature / external kill)
    # are excluded so they reach the serial rescue queue below instead of
    # being absolved without a re-run.
    if [ "$fail_count" = "0" ] && [ "$inline_fails" = "0" ] && [ "$idle_secs" -ge 300 ] \
       && [ "$shard_oom" = "0" ] && [ "$shard_external_kill" = "0" ]; then
      # Completion evidence (fail-closed): warn-pass additionally requires
      # every assigned file to have STARTED (its file-header appears in the
      # log). A silent idle window can also mean the shard wedged before
      # reaching its last files — that stays a hard WEDGE.
      unstarted=$(shard_unstarted_files "$i" "$SHARD_LOG")
      if [ -z "$unstarted" ]; then
        {
          echo "⚠️  shard $i/$N: EXIT-HANG after ${SHARD_TIMEOUT}s — log silent for ${idle_secs}s with 0 failures"
          echo "    and every assigned file started; the process finished its work, leaked a handle, and"
          echo "    never exited (pre-existing, master-reproducible; see TODOS.md 'unit-shard exit hang')."
          echo "    Treating as pass-with-warning."
        } >&2
        echo "shard $i/$N: EXIT-HANG (idle ${idle_secs}s, 0 fails, all files started) rc=$rc — warn-pass" >> "$SUMMARY_FILE"
        continue
      fi
      unstarted_count=$(printf '%s\n' "$unstarted" | grep -c .)
      {
        echo "⚠️  shard $i/$N: watchdog-killed with 0 fails and idle ${idle_secs}s, but ${unstarted_count} assigned"
        echo "    file(s) never started — classifying WEDGED, not EXIT-HANG:"
        printf '%s\n' "$unstarted" | sed 's/^/      /'
      } >&2
    fi
    TOTAL_RC=1
    if [ "$shard_external_kill" = "1" ]; then
      shard_assigned_list "$i" >> "$OOM_RESCUE_LIST"
      echo "shard $i/$N: KILLED externally after ${s_elapsed}s (rc=$rc, well before ${SHARD_TIMEOUT}s cap — queued for serial rescue)" >> "$SUMMARY_FILE"
    elif [ "$shard_oom" = "1" ]; then
      # Wedged UNDER memory pressure: we can't attribute failures, so queue
      # the shard's entire file list for the serial rescue pass.
      shard_assigned_list "$i" >> "$OOM_RESCUE_LIST"
      echo "shard $i/$N: WEDGED after ${SHARD_TIMEOUT}s (rc=$rc, OOM signature — queued for serial rescue)" >> "$SUMMARY_FILE"
    else
      NON_OOM_FAIL=1
      echo "shard $i/$N: WEDGED after ${SHARD_TIMEOUT}s (rc=$rc)" >> "$SUMMARY_FILE"
    fi
    {
      echo "--- shard $i: WEDGED after ${SHARD_TIMEOUT}s ---"
      [ -f "$SHARD_LOG" ] && tail -50 "$SHARD_LOG"
      echo ""
    } >> "$FAILURES_LOG"
    continue
  fi

  if [ "$rc" != "0" ]; then
    if [ "$shard_oom" = "1" ]; then
      # One scan, reused for both the queue append and the emptiness check.
      shard_failing_files=$(failing_files_in_log "$SHARD_LOG")
      if [ -n "$shard_failing_files" ]; then
        printf '%s\n' "$shard_failing_files" >> "$OOM_RESCUE_LIST"
      else
        # OOM signature but no attributable files (e.g. bun died before any
        # file header) → rescue the whole shard.
        shard_assigned_list "$i" >> "$OOM_RESCUE_LIST"
      fi
    elif [ "$shard_external_kill" = "1" ]; then
      shard_assigned_list "$i" >> "$OOM_RESCUE_LIST"
      echo "shard $i/$N: KILLED externally after ${s_elapsed}s (rc=$rc — queued for serial rescue)" >> "$SUMMARY_FILE"
    else
      NON_OOM_FAIL=1
    fi
  fi

  echo "shard $i/$N: pass=$pass_count fail=$fail_count skip=$skip_count rc=$rc" >> "$SUMMARY_FILE"

  if [ "$rc" != "0" ]; then
    TOTAL_RC=1
    if [ "$fail_count" -gt 0 ] && [ -f "$SHARD_LOG" ]; then
      # Extract each failure block: from the `✗ ` / `(fail) ` line through the
      # next pass/skip marker, blank line, or `__bun_test_summary__`. Single awk
      # pass over ANSI-stripped text.
      strip_ansi "$SHARD_LOG" | awk -v shard="$i" '
        /^(\(fail\) |✗ )/ { in_block=1; print "--- shard " shard ": " $0; next }
        in_block {
          if (/^(\(pass\)|\(skip\)|✓ |✓$)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' >> "$FAILURES_LOG"
    elif [ -f "$SHARD_LOG" ]; then
      # Non-zero rc but no (fail) line found — extraction couldn't pinpoint.
      # Dump the full shard log so we never silently lose the failure cause.
      {
        echo "--- shard $i: rc=$rc, no (fail) markers — full log follows ---"
        cat "$SHARD_LOG"
        echo ""
      } >> "$FAILURES_LOG"
    fi
  fi
done

# ──────────────────────────────────────────────────────────────────────────
# Print each shard's full output to stdout (developer expects to scroll
# through it). Print summary file last for one-glance overview.
# ──────────────────────────────────────────────────────────────────────────
for i in $(seq 1 "$N"); do
  SHARD_LOG="$LOG_DIR/shard-$i.log"
  echo ""
  echo "════════════ shard $i/$N ════════════"
  [ -f "$SHARD_LOG" ] && cat "$SHARD_LOG"
done
echo ""
echo "════════════ summary ════════════"
cat "$SUMMARY_FILE"
echo ""

# ──────────────────────────────────────────────────────────────────────────
# Serial pass: any *.serial.test.ts files run after parallel pass.
# ──────────────────────────────────────────────────────────────────────────
SERIAL_RC=0
SERIAL_FILES_COUNT=0
SERIAL_FILES_COUNT=$(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$SERIAL_FILES_COUNT" -gt 0 ]; then
  echo "════════════ serial pass ($SERIAL_FILES_COUNT files) ════════════"
  bash scripts/run-serial-tests.sh > "$LOG_DIR/serial.log" 2>&1
  SERIAL_RC=$?
  cat "$LOG_DIR/serial.log"
  if [ "$SERIAL_RC" != "0" ]; then
    TOTAL_RC=1
    if [ "${GBRAIN_TEST_NO_OOM_FALLBACK:-0}" != "1" ] \
       && { grep -qE "$OOM_RE" "$LOG_DIR/serial.log" || [ "$EXTERNAL_KILL_ANY" = "1" ]; }; then
      # Serial failures are rescue-eligible ONLY with their own OOM signature
      # or when an externally-killed shard ran earlier in this invocation
      # (killed-midrun shards leave lock/state residue that poisons the serial
      # pass). A merely-OOM'd sibling shard is NOT grounds — a flaky serial
      # test must stay red rather than get silently absolved.
      failing_files_in_log "$LOG_DIR/serial.log" >> "$OOM_RESCUE_LIST"
    else
      NON_OOM_FAIL=1
    fi
    s_fail=$(bun_summary_count "fail" "$LOG_DIR/serial.log")
    TOTAL_FAILURES=$((TOTAL_FAILURES + s_fail))
    if [ "$s_fail" -gt 0 ]; then
      strip_ansi "$LOG_DIR/serial.log" | awk '
        /^(\(fail\) |✗ )/ { in_block=1; print "--- shard serial: " $0; next }
        in_block {
          if (/^(\(pass\)|\(skip\)|✓ |✓$)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' >> "$FAILURES_LOG"
    else
      {
        echo "--- shard serial: rc=$SERIAL_RC, no (fail) markers — full log follows ---"
        cat "$LOG_DIR/serial.log"
        echo ""
      } >> "$FAILURES_LOG"
    fi
    echo "serial: rc=$SERIAL_RC fail=$s_fail" >> "$SUMMARY_FILE"
  else
    s_pass=$(bun_summary_count "pass" "$LOG_DIR/serial.log")
    TOTAL_PASS=$((TOTAL_PASS + s_pass))
    echo "serial: pass=$s_pass rc=0" >> "$SUMMARY_FILE"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Layer 2: serial OOM rescue. Re-run every file that failed inside an
# OOM-signature shard, one at a time (1 shard, --max-concurrency 1), after
# the parallel fan-out has fully drained. Phantom failures (the WASM ran out
# of memory because 16 instances were up at once) pass here and the run goes
# green with an oom_rescued note; real failures fail again and stay red.
# ──────────────────────────────────────────────────────────────────────────
OOM_RESCUED=0
OOM_RESCUE_NOTE=""
sort -u "$OOM_RESCUE_LIST" -o "$OOM_RESCUE_LIST" 2>/dev/null
# grep -c exits 1 on zero matches — assign in two steps so an empty rescue
# list yields a single "0" (the grep_count double-output bug, same class).
RESCUE_COUNT=$(grep -c . "$OOM_RESCUE_LIST" 2>/dev/null) || RESCUE_COUNT=0
if [ "$TOTAL_RC" != "0" ] && [ "${RESCUE_COUNT:-0}" -gt 0 ]; then
  echo "════════════ OOM rescue pass ($RESCUE_COUNT files, serial) ════════════"
  echo "[unit-parallel] OOM signature detected — re-running $RESCUE_COUNT failing file(s) at --max-concurrency 1" >&2
  RESCUE_LOG="$LOG_DIR/oom-rescue.log"
  # 60s-per-file floor with the shard cap as a minimum, and 2x the shard cap
  # as a CEILING: a wedged shard queueing its whole file list must not turn
  # `bun run test` into an unbounded multi-hour serial re-run — hitting the
  # ceiling reads as a red rescue, not silence.
  RESCUE_TIMEOUT=$((RESCUE_COUNT * 60))
  [ "$RESCUE_TIMEOUT" -lt "$SHARD_TIMEOUT" ] && RESCUE_TIMEOUT="$SHARD_TIMEOUT"
  [ "$RESCUE_TIMEOUT" -gt $((SHARD_TIMEOUT * 2)) ] && RESCUE_TIMEOUT=$((SHARD_TIMEOUT * 2))
  # Split the queue: *.serial.test.ts files require one bun PROCESS per file
  # (run-serial-tests.sh's isolation contract — top-level mock.module leaks
  # across files in a shared registry); the remainder batches in one process.
  # Both lanes mirror the shard invocation's --timeout=60000 — bun's default
  # 5s per-test timeout would re-fail PGLite phantoms (120-migration replay)
  # and mislabel them 'confirmed real'.
  grep -v '\.serial\.test\.ts$' "$OOM_RESCUE_LIST" > "$LOG_DIR/oom-rescue-batch.txt" || true
  grep '\.serial\.test\.ts$' "$OOM_RESCUE_LIST" > "$LOG_DIR/oom-rescue-serial.txt" || true
  RESCUE_RC=0
  : > "$RESCUE_LOG"
  run_rescue() { # $1 = per-invocation timeout seconds; rest = test-file args
    local t="$1"; shift
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" --signal=TERM --kill-after="${SHARD_KILL_AFTER}s" "${t}s" \
        bun test --max-concurrency 1 --timeout=60000 "$@" >> "$RESCUE_LOG" 2>&1
    else
      bun test --max-concurrency 1 --timeout=60000 "$@" >> "$RESCUE_LOG" 2>&1
    fi
  }
  if [ -s "$LOG_DIR/oom-rescue-batch.txt" ]; then
    # shellcheck disable=SC2046
    run_rescue "$RESCUE_TIMEOUT" $(cat "$LOG_DIR/oom-rescue-batch.txt") || RESCUE_RC=1
  fi
  if [ -s "$LOG_DIR/oom-rescue-serial.txt" ]; then
    while IFS= read -r serial_file; do
      [ -n "$serial_file" ] || continue
      run_rescue 300 "$serial_file" || RESCUE_RC=1
    done < "$LOG_DIR/oom-rescue-serial.txt"
  fi
  cat "$RESCUE_LOG"
  r_pass=$(bun_summary_count "pass" "$RESCUE_LOG")
  r_fail=$(bun_summary_count "fail" "$RESCUE_LOG")
  if [ "$RESCUE_RC" = "0" ] && [ "$NON_OOM_FAIL" = "0" ]; then
    # Every failure in the run was OOM-phantom and every rescued file passed
    # serially: the run is green. Adjust the headline numbers so they reflect
    # the rescue verdict, and mark the earlier failure blocks superseded.
    TOTAL_RC=0
    OOM_RESCUED=1
    # Do NOT fold r_pass into TOTAL_PASS — the failing shard's own summary
    # already counted the rescued files' passing tests, so folding would
    # double-count. Rescue results ride in the note instead.
    TOTAL_FAILURES=0
    OOM_RESCUE_NOTE=" | oom_rescued=${RESCUE_COUNT}files(${r_pass}p serial)"
    {
      echo "--- OOM rescue: all $RESCUE_COUNT file(s) passed serially (${r_pass} tests) ---"
      echo "--- failure blocks above were WASM out-of-memory phantoms, superseded ---"
    } >> "$FAILURES_LOG"
    echo "oom-rescue: $RESCUE_COUNT files pass=$r_pass rc=0 (phantom OOM failures superseded)" >> "$SUMMARY_FILE"
  else
    # Real failures confirmed serially (or a non-OOM failure exists anyway).
    OOM_RESCUE_NOTE=" | oom_rescue_failed=${r_fail}real"
    strip_ansi "$RESCUE_LOG" | awk '
      /^(\(fail\) |✗ )/ { in_block=1; print "--- oom-rescue (serial, confirmed real): " $0; next }
      in_block {
        if (/^(\(pass\)|\(skip\)|✓ |✓$)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
        print $0
      }
    ' >> "$FAILURES_LOG"
    echo "oom-rescue: $RESCUE_COUNT files pass=$r_pass fail=$r_fail rc=$RESCUE_RC (real failures confirmed)" >> "$SUMMARY_FILE"
  fi
fi

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

# ──────────────────────────────────────────────────────────────────────────
# Loud banner if anything failed. To stderr so it survives `| head`/`| tail`.
# ──────────────────────────────────────────────────────────────────────────
if [ "$TOTAL_RC" != "0" ]; then
  ABS_FAIL=$(cd "$(dirname "$FAILURES_LOG")" && pwd)/$(basename "$FAILURES_LOG")
  {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "❌ $TOTAL_FAILURES TEST FAILURES — full details:"
    echo "   $ABS_FAIL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    tail -30 "$FAILURES_LOG"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP${OOM_RESCUE_NOTE}"
  } >&2
  exit 1
fi

echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP${OOM_RESCUE_NOTE}" >&2
exit 0
