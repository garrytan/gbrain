#!/usr/bin/env bash
# scripts/native/heartbeat.sh: the darwin-x64 native-locks heartbeat.
#
# A wedged macOS runner uploads no log at all, not even for the steps that passed, so while the job runs a background
# loop posts its state as the commit status `diag/native-heartbeat/<cell>`, one context per cell so two cells never
# overwrite each other. GitHub keeps every status a commit receives, so the
# last one before a wedge shows what was running. A status carries only the cell, the current step or suite and its
# elapsed seconds, free memory, swap in use, the load average and the busiest process names; never the environment.
#
#   heartbeat.sh start        start the loop (it posts on every label change and every GBRAIN_HEARTBEAT_INTERVAL_S)
#   heartbeat.sh mark LABEL   the current step or suite; needs no token, the loop posts it
#   heartbeat.sh stop RESULT  end the loop, its in-flight post included, then post the terminal `success` status (retried
#                             on a failed request), so nothing is left pending
#   heartbeat.sh describe     print the description the next status would carry
#
# start and stop read GH_TOKEN, GITHUB_REPOSITORY, GBRAIN_HEARTBEAT_SHA and GBRAIN_HEARTBEAT_CELL. Every command does
# nothing unless GBRAIN_HEARTBEAT_ENABLED=1 (the workflow sets 0 for a fork's pull request, whose token cannot write).
# bash 3.2 compatible.
set -u

dir="${GBRAIN_HEARTBEAT_DIR:-${RUNNER_TEMP:-/tmp}/gbrain-native-heartbeat}"
interval="${GBRAIN_HEARTBEAT_INTERVAL_S:-30}"

safe() { tr -cd 'A-Za-z0-9._/-' | cut -c1-"$1"; }
cell=$(printf '%s' "${GBRAIN_HEARTBEAT_CELL:-}" | safe 32)
CONTEXT="diag/native-heartbeat${cell:+/$cell}"

mem_free_pct() {
  if command -v memory_pressure >/dev/null 2>&1; then
    memory_pressure -Q 2>/dev/null | awk -F': *' '/free percentage/ { gsub(/%/, "", $2); print $2; exit }'
  elif [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { if (t) printf "%d", a * 100 / t }' /proc/meminfo
  fi
}

swap_used() {
  if [ "$(uname)" = Darwin ]; then
    sysctl -n vm.swapusage 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "used") { print $(i + 2); exit } }'
  elif [ -r /proc/meminfo ]; then
    awk '/^SwapTotal:/ { t = $2 } /^SwapFree:/ { f = $2 } END { printf "%dM", (t - f) / 1024 }' /proc/meminfo
  fi
}

load_1m() {
  if [ "$(uname)" = Darwin ]; then sysctl -n vm.loadavg 2>/dev/null | awk '{ print $2 }'
  elif [ -r /proc/loadavg ]; then awk '{ print $1 }' /proc/loadavg
  fi
}

top_names() {
  ps -A -o %cpu= -o comm= 2>/dev/null | sort -rn | head -3 | awk '{ $1 = ""; n = split($0, p, "/"); name = p[n];
    gsub(/[^A-Za-z0-9._-]/, "", name); printf "%s%s", sep, substr(name, 1, 24); sep = "," }'
}

describe() {
  local label since now
  label=$(cat "$dir/label" 2>/dev/null || echo setup)
  since=$(cat "$dir/since" 2>/dev/null || date +%s)
  now=$(date +%s)
  printf '%s %s %ss | free %s%% | swap %s | load %s | top %s' "$cell" "$(printf '%s' "${label##*/}" | safe 48)" "$((now - since))" \
    "$(mem_free_pct)" "$(swap_used)" "$(load_1m)" "$(top_names)" | tr -cd 'A-Za-z0-9 ._/|%:,=+-' | cut -c1-140
}

# A failed post names curl's exit code and the HTTP status on stderr (the loop discards it; stop's lands in the job log).
post() {
  local url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" code rc
  code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${GH_TOKEN:-}" -H 'Accept: application/vnd.github+json' \
    "${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY:-}/statuses/${GBRAIN_HEARTBEAT_SHA:-}" \
    -d "{\"state\":\"$1\",\"context\":\"$CONTEXT\",\"description\":\"$2\",\"target_url\":\"$url\"}" 2>/dev/null)
  rc=$?
  case "$code" in 2[0-9][0-9]) [ "$rc" = 0 ] && return 0 ;; esac
  echo "heartbeat: $1 post failed (curl exit $rc, HTTP ${code:-000})" >&2
  return 1
}

loop() {
  local end last="" label next=0 now
  end=$(( ${GBRAIN_JOB_DEADLINE:-$(( $(date +%s) + 1200 ))} + 300 ))
  while [ ! -e "$dir/stopped" ] && [ "$(date +%s)" -lt "$end" ]; do
    label=$(cat "$dir/label" 2>/dev/null)
    now=$(date +%s)
    if [ "$label" != "$last" ] || [ "$now" -ge "$next" ]; then
      post pending "$(describe)" || true
      last=$label
      next=$((now + interval))
    fi
    sleep 2
  done
}

[ "${GBRAIN_HEARTBEAT_ENABLED:-0}" = 1 ] || exit 0
case "${1:-}" in
  start)
    mkdir -p "$dir" && rm -f "$dir/stopped"
    echo setup > "$dir/label"; date +%s > "$dir/since"
    # Its own process group (job control on), so stop can end the loop together with a post it has in flight.
    set -m
    loop </dev/null >/dev/null 2>&1 &
    echo $! > "$dir/pid"
    ;;
  mark)
    mkdir -p "$dir"
    printf '%s\n' "${2:-}" > "$dir/label"; date +%s > "$dir/since"
    ;;
  stop)
    touch "$dir/stopped"
    if pid=$(cat "$dir/pid" 2>/dev/null) && [ -n "$pid" ]; then
      kill -TERM -- "-$pid" 2>/dev/null
      for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.5; done
    fi
    final=$(printf '%s finished %s |%s' "$cell" "$(printf '%s' "${2:-}" | safe 16)" "$(describe | cut -d'|' -f2-)" | cut -c1-140)
    for attempt in 1 2 3; do
      post success "$final" && break
      [ "$attempt" = 3 ] || sleep 2
    done
    ;;
  describe) describe; echo ;;
  *) echo "usage: heartbeat.sh start | mark LABEL | stop RESULT | describe" >&2; exit 2 ;;
esac
