#!/bin/bash
# marker.sh make <path> <seconds> | marker.sh live <path>
# See /var/tmp/trunk/RUNBOOK.md "Lock and marker files".
cmd=$1; m=$2
case "$cmd" in
  make)
    secs=${3:?seconds}; [ "$secs" -le 7200 ] || { echo "expiry over 2h refused" >&2; exit 2; }
    printf 'pid=%s\nexpires=%s\n' "$PPID" "$(( $(date +%s) + secs ))" > "$m" ;;
  live)
    [ -s "$m" ] || exit 1
    pid=$(sed -n 's/^pid=\([0-9]\+\)$/\1/p' "$m"); exp=$(sed -n 's/^expires=\([0-9]\+\)$/\1/p' "$m")
    [ -n "$pid" ] && [ -n "$exp" ] || { echo "stale marker (malformed): $m" >&2; exit 1; }
    kill -0 "$pid" 2>/dev/null || { echo "stale marker (pid $pid dead): $m" >&2; exit 1; }
    [ "$(date +%s)" -lt "$exp" ] || { echo "stale marker (expired $exp): $m" >&2; exit 1; }
    exit 0 ;;
  *) echo "usage: marker.sh make <path> <seconds> | live <path>" >&2; exit 2 ;;
esac
