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
#   bash scripts/run-unit-parallel.sh [--shards N] [--max-concurrency N]
#     [--batch-size N] [--timeout N] [--dry-run]
#
# Env overrides:
#   SHARDS=N                     same as --shards
#   GBRAIN_TEST_SHARD_TIMEOUT    per-shard wallclock cap, seconds
#   GBRAIN_TEST_MAX_CONCURRENCY  passed through to bun test
#   GBRAIN_TEST_BATCH_SIZE       files per fresh Bun process (0 disables batches)
#
# Automatic profile inputs (sampled once, before workers start): CPU count,
# available memory, Linux memory PSI, swap headroom, and 1-minute load per CPU.
# Explicit CLI/env settings above override the selected profile per setting.
#
# Output files (workspace-local; falls back to /tmp if .context/ unwritable):
#   .context/test-failures.log   failure blocks (cleared at start)
#   .context/test-summary.txt    per-shard pass/fail/skip/duration (cleared at start)
#   .context/test-shards/        per-shard logs + exit codes (cleared at start)

set -uo pipefail

cd "$(dirname "$0")/.."

# Process-safety state. The signal handler walks each shard subprocess tree
# before terminating the wrapper, so Ctrl-C/HUP/TERM cannot leave timeout or
# Bun workers consuming resources after the parent session disappears.
SHARD_PIDS=()
HB_PID=""
CLEANUP_RUNNING=0
RUN_LOCK_DIR=".context/unit-parallel.lock"
RUN_LOCK_HELD=0

child_pids() {
  local parent_pid="$1"
  if command -v ps >/dev/null 2>&1; then
    ps -eo pid=,ppid= 2>/dev/null |
      awk -v parent="$parent_pid" '$2 == parent { print $1 }'
    return
  fi

  # Minimal Docker images may omit procps entirely. Linux /proc still exposes
  # field 4 (parent PID) in /proc/<pid>/stat, so signal cleanup must not
  # silently degrade to killing only the shard shell and orphaning workers.
  if [ -d /proc ]; then
    local proc_stat proc_pid proc_row proc_rest proc_ppid
    for proc_stat in /proc/[0-9]*/stat; do
      [ -r "$proc_stat" ] || continue
      proc_pid="${proc_stat#/proc/}"
      proc_pid="${proc_pid%/stat}"
      proc_row=$(cat "$proc_stat" 2>/dev/null) || continue
      proc_rest="${proc_row##*) }"
      # After stripping "pid (comm) ", fields start at state; PPID is second.
      set -- $proc_rest
      proc_ppid="${2:-}"
      [ "$proc_ppid" = "$parent_pid" ] && echo "$proc_pid"
    done
  fi
}

descendant_pids() {
  local parent_pid="$1"
  local child_pid
  for child_pid in $(child_pids "$parent_pid"); do
    descendant_pids "$child_pid"
    echo "$child_pid"
  done
}

terminate_pid_tree() {
  local root_pid="$1"
  local descendants
  descendants=$(descendant_pids "$root_pid")
  if [ -n "$descendants" ]; then
    # Intentional word splitting: each line is a numeric PID discovered from
    # the still-live parent tree immediately above.
    kill -TERM $descendants 2>/dev/null || true
  fi
  kill -TERM "$root_pid" 2>/dev/null || true

  # A stuck WASM worker may ignore TERM. Bound cleanup itself so an
  # interrupted test run cannot keep the controlling session open forever.
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$root_pid" 2>/dev/null || break
    sleep 0.2
  done
  if [ -n "$descendants" ]; then
    kill -KILL $descendants 2>/dev/null || true
  fi
  kill -KILL "$root_pid" 2>/dev/null || true
}

release_run_lock() {
  local release_dir
  release_dir="${RUN_LOCK_DIR}.release.$$"
  if [ "$RUN_LOCK_HELD" = "1" ] && [ ! -L "$RUN_LOCK_DIR" ] && \
     [ -d "$RUN_LOCK_DIR" ] && [ ! -L "$RUN_LOCK_DIR/pid" ] && \
     [ -f "$RUN_LOCK_DIR/pid" ] && \
     [ "$(cat "$RUN_LOCK_DIR/pid" 2>/dev/null)" = "$$" ] && \
     [ ! -e "$release_dir" ] && [ ! -L "$release_dir" ] && \
     mv "$RUN_LOCK_DIR" "$release_dir" 2>/dev/null; then
    if [ ! -L "$release_dir" ] && [ -d "$release_dir" ] && \
       [ ! -L "$release_dir/pid" ] && [ -f "$release_dir/pid" ] && \
       [ "$(cat "$release_dir/pid" 2>/dev/null)" = "$$" ]; then
      rm -f "$release_dir/pid"
      rmdir "$release_dir" 2>/dev/null || true
    fi
  fi
  RUN_LOCK_HELD=0
}

cleanup_children() {
  [ "$CLEANUP_RUNNING" = "1" ] && return
  CLEANUP_RUNNING=1
  if [ -n "$HB_PID" ]; then
    kill "$HB_PID" 2>/dev/null || true
    wait "$HB_PID" 2>/dev/null || true
    HB_PID=""
  fi
  local shard_pid
  for shard_pid in "${SHARD_PIDS[@]}"; do
    terminate_pid_tree "$shard_pid"
  done
  for shard_pid in "${SHARD_PIDS[@]}"; do
    wait "$shard_pid" 2>/dev/null || true
  done
}

on_signal() {
  trap - HUP INT TERM
  echo "[unit-parallel] interrupted; stopping all shard process trees..." >&2
  cleanup_children
  exit 130
}

on_exit() {
  local rc=$?
  release_run_lock
  return "$rc"
}

trap on_signal HUP INT TERM
trap on_exit EXIT

# ──────────────────────────────────────────────────────────────────────────
# Launch-time resource probes. The GBRAIN_TEST_RESOURCE_* seams make profile
# selection deterministic in regression tests; production callers should not
# set them. Unknown optional signals use conservative sentinels.
# ──────────────────────────────────────────────────────────────────────────
CGROUP_ROOT="${GBRAIN_TEST_CGROUP_ROOT:-/sys/fs/cgroup}"
PROC_SELF_CGROUP="${GBRAIN_TEST_PROC_SELF_CGROUP:-/proc/self/cgroup}"

cgroup_v2_dir() {
  [ -r "$PROC_SELF_CGROUP" ] || return 1
  local relative
  relative=$(awk -F: '$1 == "0" && $2 == "" { print $3; exit }' \
    "$PROC_SELF_CGROUP" 2>/dev/null)
  case "$relative" in
    /*) ;;
    *) return 1 ;;
  esac
  case "/$relative/" in
    */../*) return 1 ;;
  esac
  printf '%s%s\n' "${CGROUP_ROOT%/}" "$relative"
}

cgroup_v2_cpu_limit() {
  local dir root quota period limit best=-1
  dir=$(cgroup_v2_dir) || { echo -1; return; }
  root="${CGROUP_ROOT%/}"
  while [ "$dir" = "$root" ] || [ "${dir#"$root"/}" != "$dir" ]; do
    if [ -r "$dir/cpu.max" ]; then
      read -r quota period < "$dir/cpu.max" || true
      if printf '%s' "$quota" | grep -qE '^[0-9]+$' && \
         printf '%s' "$period" | grep -qE '^[0-9]+$' && [ "$period" -gt 0 ]; then
        limit=$((quota / period))
        [ "$limit" -lt 1 ] && limit=1
        [ "$best" -lt 0 ] || [ "$limit" -lt "$best" ] || limit="$best"
        best="$limit"
      fi
    fi
    [ "$dir" = "$root" ] && break
    dir="${dir%/*}"
  done
  echo "$best"
}

cgroup_v2_mem_available_mb() {
  local dir root maximum current available best=-1
  dir=$(cgroup_v2_dir) || { echo -1; return; }
  root="${CGROUP_ROOT%/}"
  while [ "$dir" = "$root" ] || [ "${dir#"$root"/}" != "$dir" ]; do
    if [ -r "$dir/memory.max" ] && [ -r "$dir/memory.current" ]; then
      maximum=$(tr -d '[:space:]' < "$dir/memory.max" 2>/dev/null)
      current=$(tr -d '[:space:]' < "$dir/memory.current" 2>/dev/null)
      if printf '%s' "$maximum" | grep -qE '^[0-9]+$' && \
         printf '%s' "$current" | grep -qE '^[0-9]+$'; then
        if [ "$maximum" -gt "$current" ]; then
          available=$(((maximum - current) / 1048576))
        else
          available=0
        fi
        [ "$best" -lt 0 ] || [ "$available" -lt "$best" ] || available="$best"
        best="$available"
      fi
    fi
    [ "$dir" = "$root" ] && break
    dir="${dir%/*}"
  done
  echo "$best"
}

cgroup_v1_controller_dir() {
  local controller="$1" relative mount_name candidate controllers item
  [ -r "$PROC_SELF_CGROUP" ] || return 1
  relative=$(awk -F: -v wanted="$controller" '
    {
      count=split($2, controllers, ",")
      for (i=1; i<=count; i++) if (controllers[i] == wanted) { print $3; exit }
    }' "$PROC_SELF_CGROUP" 2>/dev/null)
  case "$relative" in
    /*) ;;
    *) return 1 ;;
  esac
  case "/$relative/" in
    */../*) return 1 ;;
  esac
  if [ "$controller" = "cpu" ]; then
    controllers="cpu,cpuacct cpu cpuacct"
  else
    controllers="$controller"
  fi
  for mount_name in $controllers; do
    candidate="${CGROUP_ROOT%/}/$mount_name$relative"
    [ -d "$candidate" ] && { echo "$candidate"; return; }
  done
  return 1
}

cgroup_v1_cpu_limit() {
  local dir root quota period limit best=-1
  dir=$(cgroup_v1_controller_dir cpu) || { echo -1; return; }
  root="$dir"
  while [ "${root%/*}" != "${CGROUP_ROOT%/}" ] && [ "${root%/*}" != "$root" ]; do
    root="${root%/*}"
  done
  while [ "$dir" = "$root" ] || [ "${dir#"$root"/}" != "$dir" ]; do
    if [ -r "$dir/cpu.cfs_quota_us" ] && [ -r "$dir/cpu.cfs_period_us" ]; then
      quota=$(tr -d '[:space:]' < "$dir/cpu.cfs_quota_us" 2>/dev/null)
      period=$(tr -d '[:space:]' < "$dir/cpu.cfs_period_us" 2>/dev/null)
      if printf '%s' "$quota" | grep -qE '^[0-9]+$' && \
         printf '%s' "$period" | grep -qE '^[0-9]+$' && [ "$period" -gt 0 ]; then
        limit=$((quota / period))
        [ "$limit" -lt 1 ] && limit=1
        [ "$best" -lt 0 ] || [ "$limit" -lt "$best" ] || limit="$best"
        best="$limit"
      fi
    fi
    [ "$dir" = "$root" ] && break
    dir="${dir%/*}"
  done
  echo "$best"
}

cgroup_v1_mem_available_mb() {
  local dir root maximum current available best=-1
  dir=$(cgroup_v1_controller_dir memory) || { echo -1; return; }
  root="${CGROUP_ROOT%/}/memory"
  while [ "$dir" = "$root" ] || [ "${dir#"$root"/}" != "$dir" ]; do
    if [ -r "$dir/memory.limit_in_bytes" ] && [ -r "$dir/memory.usage_in_bytes" ]; then
      maximum=$(tr -d '[:space:]' < "$dir/memory.limit_in_bytes" 2>/dev/null)
      current=$(tr -d '[:space:]' < "$dir/memory.usage_in_bytes" 2>/dev/null)
      if printf '%s' "$maximum" | grep -qE '^[0-9]+$' && \
         printf '%s' "$current" | grep -qE '^[0-9]+$' && \
         [ "$maximum" -lt 1152921504606846976 ]; then
        if [ "$maximum" -gt "$current" ]; then
          available=$(((maximum - current) / 1048576))
        else
          available=0
        fi
        [ "$best" -lt 0 ] || [ "$available" -lt "$best" ] || available="$best"
        best="$available"
      fi
    fi
    [ "$dir" = "$root" ] && break
    dir="${dir%/*}"
  done
  echo "$best"
}

probe_cpus() {
  if [ -n "${GBRAIN_TEST_RESOURCE_CPUS:-}" ]; then
    echo "$GBRAIN_TEST_RESOURCE_CPUS"; return
  fi
  local n="" cgroup_limit candidate_limit
  n=$(nproc 2>/dev/null) && [ -n "$n" ] || n=$(sysctl -n hw.logicalcpu 2>/dev/null)
  [ -n "$n" ] || n=1
  cgroup_limit=$(cgroup_v2_cpu_limit)
  candidate_limit=$(cgroup_v1_cpu_limit)
  if [ "$candidate_limit" -ge 1 ] && \
     { [ "$cgroup_limit" -lt 1 ] || [ "$candidate_limit" -lt "$cgroup_limit" ]; }; then
    cgroup_limit="$candidate_limit"
  fi
  if [ "$cgroup_limit" -ge 1 ] && [ "$cgroup_limit" -lt "$n" ]; then
    n="$cgroup_limit"
  fi
  echo "$n"
}

probe_mem_available_mb() {
  if [ -n "${GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB:-}" ]; then
    echo "$GBRAIN_TEST_RESOURCE_MEM_AVAILABLE_MB"; return
  fi
  local available=-1 cgroup_available candidate_available
  if [ -r /proc/meminfo ]; then
    available=$(awk '/^MemAvailable:/ { print int($2 / 1024); found=1; exit }
         END { if (!found) print -1 }' /proc/meminfo)
  elif command -v vm_stat >/dev/null 2>&1; then
    available=$(vm_stat 2>/dev/null | awk '
      /page size of/ { page_size=$8 }
      /Pages free:|Pages inactive:|Pages speculative:/ {
        gsub(/\./, "", $3); pages += $3
      }
      END { if (page_size > 0) print int(pages * page_size / 1048576); else print -1 }
    ')
  fi
  cgroup_available=$(cgroup_v2_mem_available_mb)
  candidate_available=$(cgroup_v1_mem_available_mb)
  if [ "$candidate_available" -ge 0 ] && \
     { [ "$cgroup_available" -lt 0 ] || [ "$candidate_available" -lt "$cgroup_available" ]; }; then
    cgroup_available="$candidate_available"
  fi
  if [ "$cgroup_available" -ge 0 ] && \
     { [ "$available" -lt 0 ] || [ "$cgroup_available" -lt "$available" ]; }; then
    available="$cgroup_available"
  fi
  echo "$available"
}

probe_psi_full_x100() {
  if [ -n "${GBRAIN_TEST_RESOURCE_PSI_FULL_X100:-}" ]; then
    echo "$GBRAIN_TEST_RESOURCE_PSI_FULL_X100"; return
  fi
  if [ -r /proc/pressure/memory ]; then
    awk '$1 == "full" {
      for (i=2; i<=NF; i++) if ($i ~ /^avg10=/) {
        split($i, part, "="); printf "%.0f\n", part[2] * 100; found=1; exit
      }
    } END { if (!found) print -1 }' /proc/pressure/memory
    return
  fi
  echo -1
}

probe_swap_free_pct() {
  if [ -n "${GBRAIN_TEST_RESOURCE_SWAP_FREE_PCT:-}" ]; then
    echo "$GBRAIN_TEST_RESOURCE_SWAP_FREE_PCT"; return
  fi
  if [ -r /proc/meminfo ]; then
    awk '
      /^SwapTotal:/ { total=$2 }
      /^SwapFree:/ { free=$2 }
      END {
        if (total > 0) print int(free * 100 / total)
        else print -1
      }
    ' /proc/meminfo
    return
  fi
  if command -v sysctl >/dev/null 2>&1; then
    LC_ALL=C sysctl -n vm.swapusage 2>/dev/null | awk '
      function to_mib(value, unit, number) {
        unit=substr(value, length(value), 1); number=value + 0
        if (unit == "T") return number * 1048576
        if (unit == "G") return number * 1024
        if (unit == "M") return number
        if (unit == "K") return number / 1024
        return number / 1048576
      }
      {
        for (i=1; i<=NF; i++) {
          if ($i == "total" && $(i+1) == "=") total=to_mib($(i+2))
          if ($i == "free" && $(i+1) == "=") free=to_mib($(i+2))
        }
      }
      END { if (total > 0 && free >= 0) print int(free * 100 / total); else print -1 }
    '
    return
  fi
  echo -1
}

probe_load_per_cpu_x100() {
  if [ -n "${GBRAIN_TEST_RESOURCE_LOAD_PER_CPU_X100:-}" ]; then
    echo "$GBRAIN_TEST_RESOURCE_LOAD_PER_CPU_X100"; return
  fi
  local load1=""
  if [ -r /proc/loadavg ]; then
    read -r load1 _ < /proc/loadavg
  else
    load1=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{},' | awk '{ print $1 }')
  fi
  if [ -n "$load1" ]; then
    awk -v load_value="$load1" -v cpus="$RESOURCE_CPUS" \
      'BEGIN { if (cpus > 0) printf "%.0f\n", load_value * 100 / cpus; else print -1 }'
  else
    echo -1
  fi
}

RESOURCE_CPUS=$(probe_cpus)
RESOURCE_MEM_AVAILABLE_MB=$(probe_mem_available_mb)
RESOURCE_PSI_FULL_X100=$(probe_psi_full_x100)
RESOURCE_SWAP_FREE_PCT=$(probe_swap_free_pct)
RESOURCE_LOAD_PER_CPU_X100=$(probe_load_per_cpu_x100)

for resource_value in "$RESOURCE_CPUS"; do
  if ! printf '%s' "$resource_value" | grep -qE '^[0-9]+$'; then
    echo "ERROR: invalid non-negative resource probe: $resource_value" >&2; exit 2
  fi
done
for resource_value in "$RESOURCE_MEM_AVAILABLE_MB" "$RESOURCE_PSI_FULL_X100" \
  "$RESOURCE_SWAP_FREE_PCT" "$RESOURCE_LOAD_PER_CPU_X100"; do
  if ! printf '%s' "$resource_value" | grep -qE '^-?[0-9]+$'; then
    echo "ERROR: invalid signed resource probe: $resource_value" >&2; exit 2
  fi
done
if [ "$RESOURCE_CPUS" -lt 1 ]; then
  echo "ERROR: CPU resource probe must be positive" >&2; exit 2
fi

# Profiles are intentionally conservative. Two 2-GiB Bun shards previously
# saturated swap and starved Hermes; only abundant, idle headroom unlocks 2×2.
if { [ "$RESOURCE_MEM_AVAILABLE_MB" -ge 0 ] && \
     [ "$RESOURCE_MEM_AVAILABLE_MB" -lt 4096 ]; } || \
   [ "$RESOURCE_PSI_FULL_X100" -ge 500 ] || \
   [ "$RESOURCE_LOAD_PER_CPU_X100" -ge 150 ] || \
   { [ "$RESOURCE_SWAP_FREE_PCT" -ge 0 ] && \
     [ "$RESOURCE_SWAP_FREE_PCT" -lt 5 ] && \
     { [ "$RESOURCE_MEM_AVAILABLE_MB" -lt 0 ] || \
       [ "$RESOURCE_MEM_AVAILABLE_MB" -lt 8192 ]; }; }; then
  RESOURCE_PROFILE="critical"
  # A single PGLite-heavy file can exceed 1 GiB RSS. Start a fresh Bun process
  # for every file so retained heaps cannot accumulate and starve Hermes.
  AUTO_N=1; AUTO_INTRA_CONC=1; AUTO_BATCH_SIZE=1; AUTO_SHARD_TIMEOUT=1800
elif [ "$RESOURCE_CPUS" -lt 4 ] || \
     [ "$RESOURCE_MEM_AVAILABLE_MB" -lt 0 ] || \
     [ "$RESOURCE_PSI_FULL_X100" -lt 0 ] || \
     [ "$RESOURCE_SWAP_FREE_PCT" -lt 0 ] || \
     [ "$RESOURCE_LOAD_PER_CPU_X100" -lt 0 ] || \
     [ "$RESOURCE_MEM_AVAILABLE_MB" -lt 8192 ] || \
     [ "$RESOURCE_PSI_FULL_X100" -ge 100 ] || \
     { [ "$RESOURCE_SWAP_FREE_PCT" -ge 0 ] && \
       [ "$RESOURCE_SWAP_FREE_PCT" -lt 15 ] && \
       [ "$RESOURCE_MEM_AVAILABLE_MB" -lt 16384 ]; } || \
     [ "$RESOURCE_LOAD_PER_CPU_X100" -ge 90 ]; then
  RESOURCE_PROFILE="busy"
  AUTO_N=1; AUTO_INTRA_CONC=1; AUTO_BATCH_SIZE=10; AUTO_SHARD_TIMEOUT=1200
elif [ "$RESOURCE_CPUS" -ge 12 ] && \
     [ "$RESOURCE_MEM_AVAILABLE_MB" -ge 24576 ] && \
     [ "$RESOURCE_PSI_FULL_X100" -le 25 ] && \
     [ "$RESOURCE_SWAP_FREE_PCT" -ge 50 ] && \
     [ "$RESOURCE_LOAD_PER_CPU_X100" -le 50 ]; then
  RESOURCE_PROFILE="high-headroom"
  AUTO_N=2; AUTO_INTRA_CONC=2; AUTO_BATCH_SIZE=20; AUTO_SHARD_TIMEOUT=900
else
  RESOURCE_PROFILE="balanced"
  AUTO_N=2; AUTO_INTRA_CONC=1; AUTO_BATCH_SIZE=10; AUTO_SHARD_TIMEOUT=900
fi

# ──────────────────────────────────────────────────────────────────────────
# Argument parsing. --shards N override wins over $SHARDS; both are clamped.
# ──────────────────────────────────────────────────────────────────────────
SHARDS_OVERRIDE=""
MAX_CONCURRENCY_OVERRIDE=""
BATCH_SIZE_OVERRIDE=""
SHARD_TIMEOUT_OVERRIDE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --shards)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "ERROR: missing value for --shards" >&2; exit 2; }
      SHARDS_OVERRIDE="$2"; shift 2 ;;
    --shards=*)
      [ -n "${1#*=}" ] || { echo "ERROR: missing value for --shards" >&2; exit 2; }
      SHARDS_OVERRIDE="${1#*=}"; shift ;;
    --max-concurrency)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "ERROR: missing value for --max-concurrency" >&2; exit 2; }
      MAX_CONCURRENCY_OVERRIDE="$2"; shift 2 ;;
    --max-concurrency=*)
      [ -n "${1#*=}" ] || { echo "ERROR: missing value for --max-concurrency" >&2; exit 2; }
      MAX_CONCURRENCY_OVERRIDE="${1#*=}"; shift ;;
    --batch-size)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "ERROR: missing value for --batch-size" >&2; exit 2; }
      BATCH_SIZE_OVERRIDE="$2"; shift 2 ;;
    --batch-size=*)
      [ -n "${1#*=}" ] || { echo "ERROR: missing value for --batch-size" >&2; exit 2; }
      BATCH_SIZE_OVERRIDE="${1#*=}"; shift ;;
    --timeout|--shard-timeout)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "ERROR: missing value for $1" >&2; exit 2; }
      SHARD_TIMEOUT_OVERRIDE="$2"; shift 2 ;;
    --timeout=*|--shard-timeout=*)
      option_name="${1%%=*}"
      [ -n "${1#*=}" ] || { echo "ERROR: missing value for $option_name" >&2; exit 2; }
      SHARD_TIMEOUT_OVERRIDE="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$SHARDS_OVERRIDE" ]; then
  N="$SHARDS_OVERRIDE"
elif [ -n "${SHARDS:-}" ]; then
  N="$SHARDS"
else
  N="$AUTO_N"
fi
if ! printf '%s' "$N" | grep -qE '^[0-9]+$' || [ "$N" -lt 1 ]; then
  echo "ERROR: invalid shard count: $N" >&2; exit 2
fi
[ "$N" -gt 8 ] && N=8

if [ -n "$MAX_CONCURRENCY_OVERRIDE" ]; then
  INTRA_CONC="$MAX_CONCURRENCY_OVERRIDE"
elif [ -n "${GBRAIN_TEST_MAX_CONCURRENCY:-}" ]; then
  INTRA_CONC="$GBRAIN_TEST_MAX_CONCURRENCY"
else
  INTRA_CONC="$AUTO_INTRA_CONC"
fi
if ! printf '%s' "$INTRA_CONC" | grep -qE '^[0-9]+$' || [ "$INTRA_CONC" -lt 1 ]; then
  echo "ERROR: invalid max concurrency: $INTRA_CONC" >&2; exit 2
fi

if [ -n "$BATCH_SIZE_OVERRIDE" ]; then
  BATCH_SIZE="$BATCH_SIZE_OVERRIDE"
elif [ -n "${GBRAIN_TEST_BATCH_SIZE:-}" ]; then
  BATCH_SIZE="$GBRAIN_TEST_BATCH_SIZE"
else
  BATCH_SIZE="$AUTO_BATCH_SIZE"
fi
if ! printf '%s' "$BATCH_SIZE" | grep -qE '^[0-9]+$'; then
  echo "ERROR: invalid batch size: $BATCH_SIZE" >&2; exit 2
fi

if [ -n "$SHARD_TIMEOUT_OVERRIDE" ]; then
  SHARD_TIMEOUT="$SHARD_TIMEOUT_OVERRIDE"
elif [ -n "${GBRAIN_TEST_SHARD_TIMEOUT:-}" ]; then
  SHARD_TIMEOUT="$GBRAIN_TEST_SHARD_TIMEOUT"
else
  SHARD_TIMEOUT="$AUTO_SHARD_TIMEOUT"
fi
if ! printf '%s' "$SHARD_TIMEOUT" | grep -qE '^[0-9]+$' || [ "$SHARD_TIMEOUT" -lt 1 ]; then
  echo "ERROR: invalid shard timeout: $SHARD_TIMEOUT" >&2; exit 2
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
# ──────────────────────────────────────────────────────────────────────────
# Resolve `timeout` command. macOS without coreutils has neither; we degrade
# to bg-pid + sleep cap. For now, prefer gtimeout (brew coreutils) → timeout.
# ──────────────────────────────────────────────────────────────────────────
TIMEOUT_BIN=""
if [ "${GBRAIN_TEST_DISABLE_TIMEOUT_BIN:-0}" = "1" ]; then TIMEOUT_BIN=""
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
fi

START_TS=$(date +%s)
if [ "$RESOURCE_PSI_FULL_X100" -lt 0 ]; then RESOURCE_PSI_DISPLAY="unknown"
else RESOURCE_PSI_DISPLAY=$(printf '%d.%02d%%' \
  "$((RESOURCE_PSI_FULL_X100 / 100))" "$((RESOURCE_PSI_FULL_X100 % 100))"); fi
if [ "$RESOURCE_LOAD_PER_CPU_X100" -lt 0 ]; then RESOURCE_LOAD_DISPLAY="unknown"
else RESOURCE_LOAD_DISPLAY=$(printf '%d.%02d' \
  "$((RESOURCE_LOAD_PER_CPU_X100 / 100))" "$((RESOURCE_LOAD_PER_CPU_X100 % 100))"); fi
if [ "$RESOURCE_SWAP_FREE_PCT" -lt 0 ]; then RESOURCE_SWAP_DISPLAY="unknown"
else RESOURCE_SWAP_DISPLAY="${RESOURCE_SWAP_FREE_PCT}%"; fi
echo "[unit-parallel] profile=$RESOURCE_PROFILE | resources=cpus:$RESOURCE_CPUS,mem:${RESOURCE_MEM_AVAILABLE_MB}MiB,psi_full:$RESOURCE_PSI_DISPLAY,swap_free:$RESOURCE_SWAP_DISPLAY,load_per_cpu:$RESOURCE_LOAD_DISPLAY | N=$N shards | --max-concurrency=$INTRA_CONC | batch-size=$BATCH_SIZE | timeout=${SHARD_TIMEOUT}s | logs=$LOG_DIR" >&2

if [ "$DRY_RUN" = "1" ]; then
  echo "[unit-parallel] dry-run: would spawn $N shards with the above settings."
  for i in $(seq 1 "$N"); do
    SHARD="$i/$N" bash scripts/run-unit-shard.sh --dry-run-list 2>/dev/null \
      | sed "s|^|  [s$i] |"
  done
  exit 0
fi

# Refuse overlapping full-suite runs in the same worktree. A stale lock is
# recovered only when its recorded PID is no longer alive. Incomplete or
# symbolic locks fail closed; stale recovery first renames the directory
# atomically so concurrent contenders cannot delete a newly acquired lock.
if mkdir "$RUN_LOCK_DIR" 2>/dev/null; then
  RUN_LOCK_HELD=1
else
  if [ -L "$RUN_LOCK_DIR" ]; then
    echo "ERROR: unsafe symbolic test lock: $RUN_LOCK_DIR" >&2
    exit 2
  fi
  if [ ! -d "$RUN_LOCK_DIR" ]; then
    echo "ERROR: invalid test lock: $RUN_LOCK_DIR" >&2
    exit 2
  fi
  if [ -L "$RUN_LOCK_DIR/pid" ]; then
    echo "ERROR: unsafe symbolic test lock pid: $RUN_LOCK_DIR/pid" >&2
    exit 2
  fi
  if [ ! -f "$RUN_LOCK_DIR/pid" ]; then
    echo "ERROR: test lock is initializing or invalid: $RUN_LOCK_DIR" >&2
    exit 2
  fi
  lock_pid=$(cat "$RUN_LOCK_DIR/pid" 2>/dev/null)
  if ! printf '%s' "$lock_pid" | grep -qE '^[0-9]+$'; then
    echo "ERROR: test lock is initializing or invalid: $RUN_LOCK_DIR" >&2
    exit 2
  fi
  if kill -0 "$lock_pid" 2>/dev/null; then
    echo "ERROR: unit test suite already running (pid=$lock_pid)" >&2
    exit 2
  fi

  stale_lock_dir="${RUN_LOCK_DIR}.stale.$$"
  if [ -e "$stale_lock_dir" ] || [ -L "$stale_lock_dir" ] || \
     ! mv "$RUN_LOCK_DIR" "$stale_lock_dir" 2>/dev/null; then
    echo "ERROR: stale test lock changed during recovery: $RUN_LOCK_DIR" >&2
    exit 2
  fi
  if ! mkdir "$RUN_LOCK_DIR" 2>/dev/null; then
    echo "ERROR: cannot acquire test lock after stale recovery: $RUN_LOCK_DIR" >&2
    exit 2
  fi
  RUN_LOCK_HELD=1
  if [ ! -L "$stale_lock_dir" ] && [ -d "$stale_lock_dir" ] && \
     [ ! -L "$stale_lock_dir/pid" ] && [ -f "$stale_lock_dir/pid" ]; then
    rm -f "$stale_lock_dir/pid"
    rmdir "$stale_lock_dir" 2>/dev/null || true
  fi
fi
if ! (umask 077; set -C; printf '%s\n' "$$" > "$RUN_LOCK_DIR/pid") 2>/dev/null; then
  release_run_lock
  echo "ERROR: cannot initialize test lock: $RUN_LOCK_DIR" >&2
  exit 2
fi

# Clear prior artifacts only after acquiring the single-run lock, so a second
# invocation can never truncate the active suite's logs before being refused.
rm -f "$LOG_DIR"/shard-*.log "$LOG_DIR"/shard-*.exit \
  "$LOG_DIR"/shard-*.wedged "$LOG_DIR"/shard-*.completed 2>/dev/null
: > "$FAILURES_LOG"
: > "$SUMMARY_FILE"

# ──────────────────────────────────────────────────────────────────────────
# Spawn shards. Each child captures its own exit code into a sentinel file
# so $? is recoverable per-shard (we never trust `wait`'s aggregate value).
# ──────────────────────────────────────────────────────────────────────────
for i in $(seq 1 "$N"); do
  (
    SHARD_LOG="$LOG_DIR/shard-$i.log"
    timed_out=0
    if [ -n "$TIMEOUT_BIN" ]; then
      completion_marker="$LOG_DIR/shard-$i.completed"
      rm -f "$completion_marker"
      "$TIMEOUT_BIN" --kill-after=5s "${SHARD_TIMEOUT}s" \
        bash -c '
          shard="$1"; concurrency="$2"; batch_size="$3"
          shard_log="$4"; completion_marker="$5"
          env SHARD="$shard" bash scripts/run-unit-shard.sh \
            --max-concurrency="$concurrency" --batch-size="$batch_size" \
            > "$shard_log" 2>&1
          child_rc=$?
          (umask 077; printf "%s\n" "$child_rc" > "$completion_marker") || exit 125
          exit "$child_rc"
        ' _ "$i/$N" "$INTRA_CONC" "$BATCH_SIZE" "$SHARD_LOG" "$completion_marker"
      rc=$?
      if [ -f "$completion_marker" ]; then
        completed_rc=$(cat "$completion_marker" 2>/dev/null)
        if printf '%s' "$completed_rc" | grep -qE '^[0-9]+$'; then
          rc="$completed_rc"
        fi
        rm -f "$completion_marker"
      elif [ "$rc" = "124" ]; then
        timed_out=1
      fi
    else
      timeout_marker="$LOG_DIR/shard-$i.wedged"
      rm -f "$timeout_marker"
      env SHARD="$i/$N" \
        bash scripts/run-unit-shard.sh --max-concurrency="$INTRA_CONC" \
        --batch-size="$BATCH_SIZE" \
        > "$SHARD_LOG" 2>&1 &
      pid=$!
      (
        sleep "$SHARD_TIMEOUT"
        echo "WEDGED" > "$timeout_marker"
        terminate_pid_tree "$pid"
      ) &
      cap_pid=$!
      wait "$pid" 2>/dev/null
      rc=$?
      if [ -f "$timeout_marker" ]; then
        wait "$cap_pid" 2>/dev/null || true
        rc=124
        timed_out=1
      else
        kill "$cap_pid" 2>/dev/null
        wait "$cap_pid" 2>/dev/null || true
      fi
    fi
    echo "$rc" > "$LOG_DIR/shard-$i.exit"
    [ "$timed_out" = "1" ] && echo "WEDGED" > "$LOG_DIR/shard-$i.wedged"
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

# bun_summary_count: parses Bun's summary lines (one per `bun test` invocation
# inside a shard — there's only one when we pass an explicit file list).
# Looks for ` N pass` / ` N fail` / ` N skip` patterns and sums them across
# all summary blocks the shard emitted. `bun test` prints these near the end
# of its output. Format: leading whitespace + integer + space + label.
bun_summary_count() {
  local label="$1"; local file="$2"
  if [ ! -f "$file" ]; then echo 0; return; fi
  awk -v label="$label" '
    $1 ~ /^[0-9]+$/ && $2 == label { total += $1 }
    END { print total + 0 }
  ' "$file"
}

heartbeat() {
  while true; do
    sleep 10
    local line=""
    for i in $(seq 1 "$N"); do
      if [ -f "$LOG_DIR/shard-$i.exit" ]; then
        local rc; rc=$(cat "$LOG_DIR/shard-$i.exit" 2>/dev/null || echo "?")
        local status="✓"
        [ "$rc" != "0" ] && status="✗"
        line="$line [s$i: done $status]"
      else
        local lf="$LOG_DIR/shard-$i.log"
        if [ -f "$lf" ]; then
          # Heartbeat: prefer Bun's per-test "✓" (passed) and "(fail)" markers
          # so we see live progress; the "N pass" summary line only appears at
          # the very end of the shard and would always show 0 mid-run.
          local p f
          p=$(grep_count '^[[:space:]]+✓' "$lf")
          f=$(grep_count '^\(fail\)' "$lf")
          line="$line [s$i: ${p}p ${f}f ...]"
        else
          line="$line [s$i: starting]"
        fi
      fi
    done
    printf '[heartbeat] %s\n' "$line" >&2
  done
}
heartbeat &
HB_PID=$!

# Wait for every shard. Don't care about wait's exit code.
for pid in "${SHARD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

kill "$HB_PID" 2>/dev/null
wait "$HB_PID" 2>/dev/null
HB_PID=""

# ──────────────────────────────────────────────────────────────────────────
# Aggregate failures (single writer; serial; never concurrent).
# Bun failure block format: from `(fail) ...` line through next `(pass)`,
# `(skip)`, blank line, or `__bun_test_summary__` marker.
# ──────────────────────────────────────────────────────────────────────────
TOTAL_FAILURES=0
TOTAL_PASS=0
TOTAL_SKIP=0
TOTAL_RC=0
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

  if [ -f "$WEDGED_FILE" ]; then
    TOTAL_RC=1
    {
      echo "--- shard $i: WEDGED after ${SHARD_TIMEOUT}s ---"
      [ -f "$SHARD_LOG" ] && tail -50 "$SHARD_LOG"
      echo ""
    } >> "$FAILURES_LOG"
    echo "shard $i/$N: WEDGED after ${SHARD_TIMEOUT}s (rc=$rc)" >> "$SUMMARY_FILE"
    continue
  fi

  echo "shard $i/$N: pass=$pass_count fail=$fail_count skip=$skip_count rc=$rc" >> "$SUMMARY_FILE"

  if [ "$rc" != "0" ]; then
    TOTAL_RC=1
    if [ "$fail_count" -gt 0 ] && [ -f "$SHARD_LOG" ]; then
      # Extract each (fail) block: from `(fail)` line through next `(pass)`,
      # `(skip)`, blank line, or `__bun_test_summary__`. Single awk pass.
      awk -v shard="$i" '
        /^\(fail\) / { in_block=1; print "--- shard " shard ": " $0; next }
        in_block {
          if (/^\(pass\)/ || /^\(skip\)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' "$SHARD_LOG" >> "$FAILURES_LOG"
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
    s_fail=$(bun_summary_count "fail" "$LOG_DIR/serial.log")
    TOTAL_FAILURES=$((TOTAL_FAILURES + s_fail))
    if [ "$s_fail" -gt 0 ]; then
      awk '
        /^\(fail\) / { in_block=1; print "--- shard serial: " $0; next }
        in_block {
          if (/^\(pass\)/ || /^\(skip\)/ || /^[[:space:]]*$/ || /__bun_test_summary__/) { in_block=0; print ""; next }
          print $0
        }
      ' "$LOG_DIR/serial.log" >> "$FAILURES_LOG"
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
    echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP"
  } >&2
  exit 1
fi

echo "[unit-parallel] elapsed=${ELAPSED}s | pass=$TOTAL_PASS fail=$TOTAL_FAILURES skip=$TOTAL_SKIP" >&2
exit 0
