#!/usr/bin/env bash
# scripts/run-serial-tests.sh — run *.serial.test.ts files, one bun process per
# file, POOLED across files.
#
# Serial files are tests that share file-wide state (top-level mock.module,
# module-level singletons that intentionally cross test cases) and would race
# under intra-file concurrency. Discovered via filename suffix; no annotation
# inside the file is needed.
#
# Each file gets its OWN bun process. `--max-concurrency=1` alone was not
# enough: files in the same process share the module registry, so a top-level
# `mock.module(...)` in one file leaks into the next file's imports. Per-file
# processes give true isolation — and that isolation is per-PROCESS, not
# per-machine, so separate processes run CONCURRENTLY through the pool below.
# (The previous runner executed the per-file processes strictly one-at-a-time:
# an 8.5-minute CI job whose serialization was never required by the
# quarantine contract.)
#
# Excluded by run-unit-shard.sh and run-unit-parallel.sh's parallel pass.
# Invoked separately by run-unit-parallel.sh after the parallel pass succeeds.
#
# Knobs:
#   GBRAIN_SERIAL_POOL=N          pool width (default min(detect_cpus, 4),
#                                 then memory-adapted; 1 restores the old
#                                 fully-sequential behavior)
#   GBRAIN_SERIAL_FILE_TIMEOUT=S  wall-clock kill per file (default 300;
#                                 needs timeout/gtimeout on PATH, else no wrap)
#   GBRAIN_TEST_MEM_PER_FILE_MB   per-process memory budget (default 1536)
#   GBRAIN_TEST_NO_MEM_ADAPT=1    skip the memory clamp

set -euo pipefail

# Fixture tests that `git commit` in temp repos must not inherit the developer's
# global commit.gpgsign — a signing gpg-agent can OOM under full-suite memory
# pressure and fail the commit ("gpg: signing failed: Cannot allocate memory",
# #1696). git applies these env keys as highest-precedence config on every
# invocation in this process tree, so all child `git commit`s run unsigned.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="commit.gpgsign" GIT_CONFIG_VALUE_0="false"

# #3485: serial tests need no database — strip ambient DB URLs at this
# wrapper boundary (same four-layer guard as run-slow-tests.sh / the
# parallel runner) so the bunfig preload guard passes and nothing can
# reach a real brain.
unset DATABASE_URL GBRAIN_DATABASE_URL
cd "$(dirname "$0")/.."

. scripts/lib/test-env.sh

# ──────────────────────────────────────────────────────────────────────────
# EXCLUSIVE_FILES: files that must never run concurrently with anything else
# (machine-global state or contention-critical timing). They run sequentially
# AFTER the pool drains, without the wall-clock kill (a SIGKILL
# mid-registration could strand a real scheduled job). Growth guard:
# test/scripts/serial-files.test.ts fails when this list grows past 3
# entries — every addition needs a justification comment like the entries
# below.
# ──────────────────────────────────────────────────────────────────────────
EXCLUSIVE_FILES=(
  # launchd/cron lifecycle arc: install → self-disable → reinstall →
  # uninstall ordering against (PATH-shimmed) launchctl; the arc asserts
  # machine-level sequencing and is the flake-class canary.
  "test/autopilot-launchd-lifecycle.serial.test.ts"
  # hardenBrainRepo({installCron:true}) executes REAL launchctl/crontab
  # (src/core/brain-repo-durability.ts) — a concurrent or killed run could
  # strand a real scheduled job on the machine.
  "test/brain-durability-hook.serial.test.ts"
  # hardenBrainRepo's own scaffolding commit fires the just-installed
  # post-commit hook (background push) which races the synchronous
  # push-probe on the same bare remote ("cannot lock ref" →
  # needs_attention non-empty). The race is intra-call; pooled CPU
  # contention widens the window past what the assertions tolerate
  # (observed on a 4-vCPU CI runner, never locally). Sequential lane
  # restores master-era timing until the probe learns to retry ref-lock
  # contention.
  "test/brain-repo-durability.serial.test.ts"
)

is_exclusive() {
  local f="$1" e
  for e in "${EXCLUSIVE_FILES[@]}"; do
    [ "$f" = "$e" ] && return 0
  done
  return 1
}

# Use while-read for portability to macOS bash 3.2 (no mapfile).
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[serial-tests] no *.serial.test.ts files found"
  exit 0
fi

# --dry-run-list mirrors run-unit-shard.sh for inline checks/tests. Lists
# ALL discovered files, pooled and exclusive alike.
if [ "${1:-}" = "--dry-run-list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

ensure_pglite_snapshot "serial-tests"

# Partition into pooled vs exclusive (exclusive entries missing from the
# discovered set are simply ignored — the list names repo files, and a
# sandbox copy of this script won't have them).
pool_files=()
exclusive_present=()
for f in "${files[@]}"; do
  if is_exclusive "$f"; then
    exclusive_present+=("$f")
  else
    pool_files+=("$f")
  fi
done

# LPT dispatch: heaviest-first into the work-stealing pool (descending-weight
# dispatch into a width-P pool IS longest-processing-time-first). Weights are
# ADVISORY (scripts/serial-weights.json, seconds, mined from
# .context/serial-durations.txt below); absent file / corrupt JSON / missing
# bun keep discovery order (bun, not node: bun-only dev machines are the
# common case — the script runs `bun test` right after). Absent key → corpus
# p75 (same doctrine as
# scripts/sharding.ts). Rank stability is all that matters — a wrong order
# costs idle tail, never correctness. The --dry-run-list output above stays
# discovery-ordered on purpose (pinned by test/scripts/run-serial-pool.test.ts).
if [ "${#pool_files[@]}" -gt 1 ] && [ -f scripts/serial-weights.json ] && command -v bun >/dev/null 2>&1; then
  lpt_sorted=$(printf '%s\n' "${pool_files[@]}" | bun -e '
    const fs = require("fs");
    let w = {};
    try { w = JSON.parse(fs.readFileSync("scripts/serial-weights.json", "utf8")); } catch {}
    const files = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
    const vals = Object.values(w).filter((v) => typeof v === "number").sort((a, b) => a - b);
    const p75 = vals.length ? vals[Math.floor(vals.length * 0.75)] : 0;
    const wt = (f) => (typeof w[f] === "number" ? w[f] : p75);
    files.sort((a, b) => (wt(b) - wt(a)) || (a < b ? -1 : 1));
    process.stdout.write(files.join("\n"));
  ' 2>/dev/null) || lpt_sorted=""
  if [ -n "$lpt_sorted" ]; then
    pool_files=()
    while IFS= read -r f; do pool_files+=("$f"); done <<< "$lpt_sorted"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Pool sizing: min(detect_cpus, 4) — each pooled bun process can hold a
# PGLite WASM instance (~1.5GB) — then clamped by available memory (same
# layer-1 doctrine as run-unit-parallel.sh, 4GB OS reserve).
# ──────────────────────────────────────────────────────────────────────────
POOL="${GBRAIN_SERIAL_POOL:-}"
if [ -z "$POOL" ]; then
  POOL=$(detect_cpus)
  [ "$POOL" -gt 4 ] && POOL=4
  if [ "${GBRAIN_TEST_NO_MEM_ADAPT:-0}" != "1" ]; then
    MEM_PER_FILE_MB="${GBRAIN_TEST_MEM_PER_FILE_MB:-1536}"
    AVAIL_MB=$(detect_available_mem_mb)
    if [ "${AVAIL_MB:-0}" -gt 0 ] 2>/dev/null; then
      BUDGET_MB=$((AVAIL_MB - 4096))
      [ "$BUDGET_MB" -lt "$MEM_PER_FILE_MB" ] && BUDGET_MB="$MEM_PER_FILE_MB"
      MAX_POOL=$((BUDGET_MB / MEM_PER_FILE_MB))
      [ "$MAX_POOL" -lt 1 ] && MAX_POOL=1
      [ "$POOL" -gt "$MAX_POOL" ] && POOL="$MAX_POOL"
    fi
  fi
fi
if ! printf '%s' "$POOL" | grep -qE '^[0-9]+$' || [ "$POOL" -lt 1 ]; then
  echo "[serial-tests] ERROR: invalid pool size: $POOL" >&2
  exit 2
fi

# Wall-clock kill per pooled file: contains the exit-hang class (a bun
# process that finishes its tests but never exits). SIGTERM first, SIGKILL
# after a grace period (`timeout -k`). macOS without coreutils has neither
# binary — run unwrapped there (CI is Linux and always wraps).
PER_FILE_TIMEOUT="${GBRAIN_SERIAL_FILE_TIMEOUT:-300}"
TIMEOUT_BIN=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_BIN="timeout"
[ -z "$TIMEOUT_BIN" ] && command -v gtimeout >/dev/null 2>&1 && TIMEOUT_BIN="gtimeout"

LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-serial.XXXXXX")
trap 'rm -rf "$LOG_DIR"' EXIT

if [ -n "$TIMEOUT_BIN" ]; then
  TIMEOUT_DESC="${PER_FILE_TIMEOUT}s via $TIMEOUT_BIN"
else
  TIMEOUT_DESC="none (no timeout/gtimeout on PATH)"
fi
echo "[serial-tests] ${#files[@]} file(s): pool=$POOL (${#exclusive_present[@]} exclusive), per-file timeout=$TIMEOUT_DESC"

# Per-test timeout is 120s (not the fast-loop 60s): pooled contention can
# push a 30-50s file past 60s — the same flake class the slow lane hardened
# against in v0.40.10. The literal `bun test --max-concurrency=1` below is
# contract-pinned by test/scripts/serial-files.test.ts.
run_one_file() {
  # $1 file, $2 log path, $3 exit-sentinel path, $4 wrap ("wrap"|"nowrap")
  local f="$1" log="$2" exitf="$3" wrap="$4" rc=0
  # COVERAGE_DIR (opt-in): every bun process needs its OWN coverage dir — a
  # second process reusing a dir OVERWRITES lcov.info. The log basename is
  # unique per file (pool idx / exclusive i), so it keys the dir. Empty/unset
  # COVERAGE_DIR leaves the exec line byte-identical to pre-coverage behavior.
  local cov_args=()
  if [ -n "${COVERAGE_DIR:-}" ]; then
    local key
    key=$(basename "$log" .log)
    cov_args=(--coverage --coverage-reporter=lcov --coverage-dir="$COVERAGE_DIR/serial-$key")
  fi
  if [ "$wrap" = "wrap" ] && [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" -k 15 "$PER_FILE_TIMEOUT" \
      bun test --max-concurrency=1 --timeout=120000 ${cov_args[@]+"${cov_args[@]}"} "$f" > "$log" 2>&1 || rc=$?
  else
    bun test --max-concurrency=1 --timeout=120000 ${cov_args[@]+"${cov_args[@]}"} "$f" > "$log" 2>&1 || rc=$?
  fi
  echo "$rc" > "$exitf"
}

start_epoch=$(date +%s)
idx=0
if [ "${#pool_files[@]}" -gt 0 ]; then
  for f in "${pool_files[@]}"; do
    while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$POOL" ]; do
      # 0.05s granularity: at 0.2s the dispatch loop idled ~15% of a full
      # serial run in aggregate poll latency across 200+ dispatches.
      sleep 0.05
    done
    (
      s=$(date +%s)
      run_one_file "$f" "$LOG_DIR/$idx.log" "$LOG_DIR/$idx.exit" "wrap"
      e=$(date +%s)
      echo "$((e - s))" > "$LOG_DIR/$idx.dur"
    ) &
    idx=$((idx + 1))
  done
  wait
fi

# Exclusive lane: sequential, unwrapped (see EXCLUSIVE_FILES comment).
if [ "${#exclusive_present[@]}" -gt 0 ]; then
  for f in "${exclusive_present[@]}"; do
    s=$(date +%s)
    run_one_file "$f" "$LOG_DIR/$idx.log" "$LOG_DIR/$idx.exit" "nowrap"
    e=$(date +%s)
    echo "$((e - s))" > "$LOG_DIR/$idx.dur"
    idx=$((idx + 1))
  done
fi

# ──────────────────────────────────────────────────────────────────────────
# Aggregate from the exit sentinels.
#   exit 0                → pass
#   exit 124              → killed by the per-file wall-clock timeout (real
#                           failure: the exit-hang class this cap exists for)
#   exit 143 / 137, or a  → EXTERNAL-KILL class: a stray SIGTERM/SIGKILL from
#   missing sentinel        outside this runner (sibling workspaces' process
#                           cleanup, memory jetsam — the same class
#                           run-unit-parallel.sh rescues). Queued for ONE
#                           sequential rescue re-run below; a rescue that
#                           fails again is a real failure. Never a silent pass.
#   anything else         → real failure
# ──────────────────────────────────────────────────────────────────────────
ordered_files=()
if [ "${#pool_files[@]}" -gt 0 ]; then ordered_files+=("${pool_files[@]}"); fi
if [ "${#exclusive_present[@]}" -gt 0 ]; then ordered_files+=("${exclusive_present[@]}"); fi

fail_count=0
failed_files=()
rescue_files=()
# Aggregate pass count across pooled files, re-emitted below in bun's own
# " N pass" summary format so run-unit-parallel.sh's headline counter
# (bun_summary_count) still sees the serial suite's tests. Failing files'
# logs are cat'ed raw (their " N pass/fail" lines land in the stream
# directly), so only PASSING files accumulate here — no double counting.
pass_total=0
i=0
for f in "${ordered_files[@]}"; do
  dur="?"
  [ -f "$LOG_DIR/$i.dur" ] && dur=$(cat "$LOG_DIR/$i.dur")
  if [ ! -f "$LOG_DIR/$i.exit" ]; then
    echo "[serial-tests] KILLED ${dur}s $f — missing exit sentinel (external kill/OOM) — queued for serial rescue" >&2
    rescue_files+=("$f")
  else
    rc=$(cat "$LOG_DIR/$i.exit")
    if [ "$rc" = "0" ]; then
      summary=$(grep -E '^ *[0-9]+ pass' "$LOG_DIR/$i.log" | tail -1 | tr -d ' ' || true)
      n=$(printf '%s' "$summary" | grep -oE '^[0-9]+' || echo 0)
      pass_total=$((pass_total + n))
      echo "[serial-tests] PASS ${dur}s $f ${summary:+($summary)}"
    elif [ "$rc" = "137" ] && [ "$dur" != "?" ] && [ "$dur" -ge "$PER_FILE_TIMEOUT" ] 2>/dev/null; then
      # 137 with full duration = OUR timeout's SIGKILL escalation (a hang
      # that ignored SIGTERM), not an external kill — a real failure; a
      # rescue re-run would just re-hang for another ~315s.
      echo "[serial-tests] FAIL ${dur}s $f — exit 137 (hang survived SIGTERM; killed by ${PER_FILE_TIMEOUT}s per-file timeout)" >&2
      cat "$LOG_DIR/$i.log" >&2
      fail_count=$((fail_count + 1))
      failed_files+=("$f")
    elif [ "$rc" = "143" ] || [ "$rc" = "137" ]; then
      echo "[serial-tests] KILLED ${dur}s $f — exit $rc (external SIGTERM/SIGKILL) — queued for serial rescue" >&2
      rescue_files+=("$f")
    else
      note=""
      [ "$rc" = "124" ] && note=" (killed by ${PER_FILE_TIMEOUT}s per-file timeout)"
      echo "[serial-tests] FAIL ${dur}s $f — exit $rc$note" >&2
      cat "$LOG_DIR/$i.log" >&2
      fail_count=$((fail_count + 1))
      failed_files+=("$f")
    fi
  fi
  i=$((i + 1))
done

# Rescue pass: one sequential, unpooled re-run per externally-killed file.
# Phantoms pass here and the run stays green (with a rescue note); real
# failures fail again and go red. Mirrors run-unit-parallel.sh's doctrine.
if [ "${#rescue_files[@]}" -gt 0 ]; then
  echo "[serial-tests] rescue pass: ${#rescue_files[@]} externally-killed file(s), re-running serially" >&2
  for f in "${rescue_files[@]}"; do
    # Exclusive-lane files keep their no-kill contract on rescue too (the
    # lane exists because a SIGKILL mid-registration strands real state).
    wrap_mode="wrap"
    is_exclusive "$f" && wrap_mode="nowrap"
    s=$(date +%s)
    run_one_file "$f" "$LOG_DIR/$i.log" "$LOG_DIR/$i.exit" "$wrap_mode"
    e=$(date +%s)
    rc=$(cat "$LOG_DIR/$i.exit" 2>/dev/null || echo 1)
    if [ "$rc" = "0" ]; then
      summary=$(grep -E '^ *[0-9]+ pass' "$LOG_DIR/$i.log" | tail -1 | tr -d ' ' || true)
      n=$(printf '%s' "$summary" | grep -oE '^[0-9]+' || echo 0)
      pass_total=$((pass_total + n))
      echo "[serial-tests] PASS $((e - s))s $f ${summary:+($summary)} (rescued: external-kill phantom)"
    else
      echo "[serial-tests] FAIL $((e - s))s $f — exit $rc on rescue re-run" >&2
      cat "$LOG_DIR/$i.log" >&2
      fail_count=$((fail_count + 1))
      failed_files+=("$f")
    fi
    i=$((i + 1))
  done
fi

# Slowest-file table: feeds flake triage + future weight mining.
echo "[serial-tests] slowest files:"
i=0
for f in "${ordered_files[@]}"; do
  [ -f "$LOG_DIR/$i.dur" ] && echo "$(cat "$LOG_DIR/$i.dur") $f"
  i=$((i + 1))
done | sort -rn | awk 'NR<=10' | sed 's/^/  /'

# Bank the FULL per-file duration table before the tmpdir EXIT trap destroys
# it — the mining input for scripts/serial-weights.json (workspace-local,
# gitignored, overwritten per run).
if mkdir -p .context 2>/dev/null; then
  {
    di=0
    for f in "${ordered_files[@]}"; do
      [ -f "$LOG_DIR/$di.dur" ] && echo "$(cat "$LOG_DIR/$di.dur") $f"
      di=$((di + 1))
    done
  } > .context/serial-durations.txt 2>/dev/null || true
fi

total_epoch=$(( $(date +%s) - start_epoch ))
if [ "$fail_count" -gt 0 ]; then
  echo "" >&2
  echo "[serial-tests] $fail_count file(s) failed (${total_epoch}s total):" >&2
  for f in "${failed_files[@]}"; do
    echo "  - $f" >&2
  done
  exit 1
fi
# Lane manifest: written ONLY on a fully green run (complete:true means the
# lcov data represents every serial file). merge-lcov.ts's --manifest-expect
# treats a missing manifest as a degraded lane.
if [ -n "${COVERAGE_DIR:-}" ]; then
  LCOV_COUNT=$(find "$COVERAGE_DIR" -name 'lcov.info' 2>/dev/null | grep -c '^' || true)
  printf '{"lane":"serial","sha":"%s","lcovCount":%s,"complete":true}\n' \
    "$(git rev-parse HEAD)" "${LCOV_COUNT:-0}" > "$COVERAGE_DIR/lane-manifest.json"
fi
# bun-summary-format aggregate: run-unit-parallel.sh's headline counter
# (bun_summary_count awk: $1 numeric, $2 == "pass") reads this line — without
# it the serial suite's tests vanish from `bun run test`'s pass=N banner.
echo " $pass_total pass"
echo "[serial-tests] all ${#ordered_files[@]} file(s) passed in ${total_epoch}s (pool=$POOL)"
