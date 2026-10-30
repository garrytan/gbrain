#!/usr/bin/env bash
# scripts/bench/production-soak/ubicloud.sh — run the production-shaped soak
# on ephemeral Ubicloud VMs, one VM per latency, in parallel (GBRA-174).
#
#   UBI_OWNER=<thread> scripts/bench/production-soak/ubicloud.sh start [--pages 600000] [--hours 3]
#     [--rtts 65,2] [--size standard-16] [--storage 640] [--ttl-hours 14] [--out .context/production-soak]
#   scripts/bench/production-soak/ubicloud.sh status  [--out DIR]   # last lines of each cell's run log
#   scripts/bench/production-soak/ubicloud.sh collect [--out DIR]   # copy each finished cell back, destroy its VM
#
# start creates one VM per latency, named with an expiry (--ttl-hours) so the
# operator reaper destroys it if nobody collects it, syncs this checkout
# (uncommitted edits included), bootstraps it (vm-setup.sh) and launches
# run.sh detached on the VM, so the soak does not depend on this machine
# staying awake. collect copies <out>/rtt<N>/out back for every cell whose run
# finished, destroys those VMs and writes the combined <out>/scoreboard.json.
# Check quota first: scripts/ubicloud/ubi-runner.sh usage.
set -euo pipefail
cd "$(dirname "$0")/../../.."
UBI=scripts/ubicloud/ubi-runner.sh
CMD=${1:-}; shift || true
PAGES=600000 HOURS=3 RTTS=65,2 SIZE=standard-16 STORAGE=640 TTL=14 OUT=.context/production-soak EXTRA=()
while [ $# -gt 0 ]; do
  case $1 in
    --pages) PAGES=$2; shift 2 ;;
    --hours) HOURS=$2; shift 2 ;;
    --rtts) RTTS=$2; shift 2 ;;
    --size) SIZE=$2; shift 2 ;;
    --storage) STORAGE=$2; shift 2 ;;
    --ttl-hours) TTL=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done
case $CMD in
  start)
    [ -n "${UBI_OWNER:-}" ] || { echo "set UBI_OWNER to your thread code" >&2; exit 2; }
    mkdir -p "$OUT"
    for rtt in ${RTTS//,/ }; do
      cell="$OUT/rtt$rtt"; mkdir -p "$cell"
      name=$($UBI up -s "$SIZE" -S "$STORAGE" --ttl-hours "$TTL")
      echo "$name" > "$cell/vm"
      echo "rtt $rtt: $name"
      $UBI sync "$name" . work/gbrain >/dev/null
      $UBI ssh "$name" 'cd work/gbrain && bash scripts/bench/production-soak/vm-setup.sh' > "$cell/setup.log" 2>&1
      $UBI ssh "$name" "cd work/gbrain && setsid -f bash scripts/bench/production-soak/run.sh --pages $PAGES --rtt-ms $rtt --hours $HOURS --out \$HOME/soak/out --label rtt$rtt ${EXTRA[*]:-} > \$HOME/soak-run.log 2>&1 < /dev/null; echo launched"
    done
    ;;
  status)
    for cell in "$OUT"/rtt*; do
      [ -f "$cell/vm" ] || continue
      echo "== $(basename "$cell") ($(cat "$cell/vm"))"
      $UBI ssh "$(cat "$cell/vm")" 'tail -n 3 ~/soak-run.log' 2>&1 | cut -c1-240 || true
    done
    ;;
  collect)
    for cell in "$OUT"/rtt*; do
      [ -f "$cell/vm" ] || continue
      name=$(cat "$cell/vm")
      if $UBI ssh "$name" 'grep -q "\[soak-run\] done" ~/soak-run.log'; then
        $UBI ssh "$name" 'cp ~/soak-run.log ~/soak/out/run.log'
        $UBI pull "$name" soak/out "$cell"
        $UBI down "$name" && rm "$cell/vm"
        echo "$(basename "$cell"): collected"
      else
        echo "$(basename "$cell"): still running"
      fi
    done
    bun scripts/bench/production-soak/scoreboard.ts --combine "$OUT" > "$OUT/scoreboard.md" || true
    ;;
  *) echo "usage: ubicloud.sh start|status|collect [options] (see the header)" >&2; exit 2 ;;
esac
