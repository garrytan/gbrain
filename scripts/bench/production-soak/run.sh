#!/usr/bin/env bash
# scripts/bench/production-soak/run.sh — one soak cell end to end on one
# machine (GBRA-174): generate the fixture, load it, soak it, and leave the
# scoreboard in <out>. Every step is deterministic up to the soak itself.
#
#   bash scripts/bench/production-soak/run.sh [--pages 600000] [--rtt-ms 65] [--hours 3] [--seed 7] [--out ~/soak/out] [--label name] [--managed-passes 20] [--extract-budget-s 1200]
#
# Postgres gets a quarter of the machine's RAM as shared_buffers. The fixture
# and the database stay on the machine; only <out> (events, scoreboard, logs)
# is meant to be copied back.
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="$HOME/.bun/bin:$PATH"
PAGES=600000 RTT=65 HOURS=3 SEED=7 OUT="$HOME/soak/out" LABEL="" EXTRA=() LOAD_EXTRA=()
while [ $# -gt 0 ]; do
  case $1 in
    --pages) PAGES=$2; shift 2 ;;
    --rtt-ms) RTT=$2; shift 2 ;;
    --hours) HOURS=$2; shift 2 ;;
    --seed) SEED=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    --managed-passes|--extract-budget-s) LOAD_EXTRA+=("$1" "$2"); shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done
ROOT="${SOAK_ROOT:-$HOME/soak}"
mkdir -p "$ROOT" "$OUT"
export SOAK_PG_SHARED_BUFFERS="$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 4096 ))MB"
t0=$(date +%s)
echo "[soak-run] fixture: $PAGES pages, seed $SEED"
bun scripts/bench/production-soak/fixture.ts --out "$ROOT/fixture" --pages "$PAGES" --seed "$SEED" 2>&1 | tee "$OUT/fixture.log"
echo "[soak-run] load (+$(( $(date +%s) - t0 ))s)"
bun scripts/bench/production-soak/load.ts --fixture "$ROOT/fixture" --work "$ROOT/work" "${LOAD_EXTRA[@]}" 2>&1 | tee "$OUT/load.log"
cp "$ROOT/work/ready.json" "$OUT/ready.json"
echo "[soak-run] soak $HOURS h at $RTT ms (+$(( $(date +%s) - t0 ))s)"
bun scripts/bench/production-soak/soak.ts --fixture "$ROOT/fixture" --work "$ROOT/work" --out "$OUT" --rtt-ms "$RTT" --hours "$HOURS" --label "${LABEL:-rtt$RTT}" "${EXTRA[@]}" 2>&1 | tee "$OUT/soak.log"
echo "[soak-run] done in $(( $(date +%s) - t0 ))s"
