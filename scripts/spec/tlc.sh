#!/usr/bin/env bash
# Model-checks every spec under spec/tla/ with TLC (spec/tla/README.md).
#
#   bash scripts/spec/tlc.sh                    every config of every spec
#   bash scripts/spec/tlc.sh drain-lease        one spec
#   bash scripts/spec/tlc.sh drain-lease DrainLease.cfg
#
# Each spec directory holds one module <M>.tla and its configs <M>*.cfg. A config passes only when TLC prints
# "Model checking completed. No error has been found."; anything else fails with a code:
#   TLC_VIOLATION  a property is violated: read the trace in the log, then fix the code, or fix the spec when the
#                  spec is wrong and say why in the PR
#   TLC_TIMEOUT    TLC did not finish within TLC_TIMEOUT_S (default 600): the state space grew; shrink the config
#   TLC_ERROR      TLC stopped (parse or semantic error, out of memory): the log names the line
# Env: TLA2TOOLS (a jar to use; otherwise scripts/spec/tla-jar.sh downloads the pinned one), TLC_OUT (logs; default
# .context/tlc), TLC_WORKERS (default: every CPU; configs run one at a time), TLC_TIMEOUT_S, TLC_JAVA_OPTS, TLC_NIGHTLY (1 also runs
# the *Nightly.cfg configs, which take too long for every pull request).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
jar="$(bash "$root/scripts/spec/tla-jar.sh")"
out="${TLC_OUT:-$root/.context/tlc}"
limit="${TLC_TIMEOUT_S:-600}"
timeout_bin="$(command -v timeout || command -v gtimeout || true)"
[ -n "$timeout_bin" ] || { echo "TLC_ERROR: GNU timeout not found (on macOS: brew install coreutils)" >&2; exit 2; }
mkdir -p "$out"

specs=()
if [ $# -ge 1 ]; then specs=("$root/spec/tla/$1"); else for d in "$root"/spec/tla/*/; do specs+=("${d%/}"); done; fi
jobs=()
for dir in "${specs[@]}"; do
  [ -d "$dir" ] || { echo "TLC_ERROR: no spec directory $dir" >&2; exit 2; }
  module="$(cd "$dir" && ls *.tla | head -1)"; module="${module%.tla}"
  if [ $# -ge 2 ]; then cfgs=("$2"); else
    cfgs=(); for c in "$dir"/"$module"*.cfg; do
      case "$c" in *Nightly.cfg) [ "${TLC_NIGHTLY:-0}" = 1 ] || { echo "skip $(basename "$dir")/$(basename "$c") (nightly only; TLC_NIGHTLY=1 runs it)"; continue; } ;; esac
      cfgs+=("$(basename "$c")")
    done
  fi
  for cfg in "${cfgs[@]}"; do [ -f "$dir/$cfg" ] || { echo "TLC_ERROR: no config $dir/$cfg" >&2; exit 2; }; jobs+=("$dir|$module|$cfg"); done
done
cpus="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
# One config at a time with every CPU: the configs differ in size by 100x, so running them side by side leaves the
# largest on a fraction of the machine.
workers="${TLC_WORKERS:-$cpus}"

run() { # dir module cfg -> runs TLC on a private copy, so its states/ directory never lands in the tree
  local dir="$1" module="$2" cfg="$3" work="$out/$(basename "$1")-${3%.cfg}" rc=0
  rm -rf "$work"; mkdir -p "$work/tmp"; cp "$dir/$module.tla" "$dir/$cfg" "$work/"
  (cd "$work" && "$timeout_bin" --kill-after=10 "$limit" java ${TLC_JAVA_OPTS:--XX:+UseParallelGC} -Djava.io.tmpdir="$work/tmp" \
     -cp "$jar" tlc2.TLC -workers "$workers" -config "$cfg" -metadir "$work/states" "$module.tla") > "$work/tlc.log" 2>&1 || rc=$?
  echo "$rc" > "$work/rc"
}
for job in "${jobs[@]}"; do IFS='|' read -r d m c <<< "$job"; run "$d" "$m" "$c"; done

status=0
for job in "${jobs[@]}"; do
  IFS='|' read -r d m c <<< "$job"
  work="$out/$(basename "$d")-${c%.cfg}"; log="$work/tlc.log"; rc="$(cat "$work/rc")"; name="$(basename "$d")/$c"
  if grep -q "Model checking completed. No error has been found." "$log"; then
    echo "ok   $name: $(grep -oE '[0-9]+ distinct states found' "$log" | tail -1) ($(grep -oE 'Finished in [^ ]+' "$log" | head -1))"
  elif [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    echo "FAIL TLC_TIMEOUT $name: TLC did not finish within ${limit}s. Log: $log" >&2; status=1
  elif v="$(grep -oE '(Invariant|Action property|Temporal properties|Property) [A-Za-z0-9_]* ?(is|were) violated' "$log" | head -1)" && [ -n "$v" ]; then
    echo "FAIL TLC_VIOLATION $name: $v. The counterexample trace is in $log; spec/tla/README.md maps each action to its code." >&2; status=1
  else
    echo "FAIL TLC_ERROR $name: TLC exited $rc without a result. Log: $log" >&2; grep -m3 -iE 'error|exception' "$log" >&2 || tail -5 "$log" >&2; status=1
  fi
done
exit "$status"
