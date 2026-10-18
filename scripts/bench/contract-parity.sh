#!/usr/bin/env bash
# Master-vs-branch run of scripts/bench/contract-parity.ts (LHF wave 2, item G).
#
#   scripts/bench/contract-parity.sh <base-ref> [--engine pglite|postgres] [--admin-url <url>] [--pages 400]
#     [--latency] [--rtt-ms 30] [--iterations 5] [--rounds 2] [--passes main,federated] [--work <dir>]
#
# Builds the fixture template once from <base-ref>, captures parity receipts
# from both trees and compares them (exit 1 on any difference). With
# --latency it also runs interleaved latency captures (base, branch, base,
# branch, ... for --rounds rounds) at --rtt-ms and compares the last pair.
# The base tree is a git worktree; when it predates the harness, the
# harness file is copied into it.
set -euo pipefail

BASE_REF="${1:?usage: contract-parity.sh <base-ref> [options]}"; shift
ENGINE=pglite; ADMIN_URL=""; PAGES=400; LATENCY=0; RTT=0; ITER=5; ROUNDS=2; PASSES=""; WORK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --admin-url) ADMIN_URL="$2"; shift 2 ;;
    --pages) PAGES="$2"; shift 2 ;;
    --latency) LATENCY=1; shift ;;
    --rtt-ms) RTT="$2"; shift 2 ;;
    --iterations) ITER="$2"; shift 2 ;;
    --rounds) ROUNDS="$2"; shift 2 ;;
    --passes) PASSES="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/gbrain-parity-XXXXXX")}"
mkdir -p "$WORK"
BASE_TREE="$WORK/base-tree"
HARNESS=scripts/bench/contract-parity.ts

if [ ! -d "$BASE_TREE" ]; then
  git -C "$REPO" worktree add --detach "$BASE_TREE" "$BASE_REF" >/dev/null
  (cd "$BASE_TREE" && bun install --frozen-lockfile >/dev/null)
fi
for f in "$HARNESS" scripts/bench/managed-sync-catchup-lib.ts test/helpers/segmented-chunks-fixture.ts; do
  [ -f "$BASE_TREE/$f" ] || { mkdir -p "$(dirname "$BASE_TREE/$f")"; cp "$REPO/$f" "$BASE_TREE/$f"; }
done
cp "$REPO/$HARNESS" "$BASE_TREE/$HARNESS"

PG_ARGS=(--engine "$ENGINE")
[ -n "$ADMIN_URL" ] && PG_ARGS+=(--admin-url "$ADMIN_URL")
PASS_ARGS=()
[ -n "$PASSES" ] && PASS_ARGS=(--passes "$PASSES")

if [ ! -f "$WORK/template/template.json" ]; then
  (cd "$BASE_TREE" && bun "$HARNESS" template --out "$WORK/template" --pages "$PAGES" "${PG_ARGS[@]}")
fi
(cd "$BASE_TREE" && bun "$HARNESS" capture --template "$WORK/template" --out "$WORK/base.json" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"})
(cd "$REPO" && bun "$HARNESS" capture --template "$WORK/template" --out "$WORK/branch.json" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"})
status=0
(cd "$REPO" && bun "$HARNESS" compare "$WORK/base.json" "$WORK/branch.json") || status=$?

if [ "$LATENCY" = 1 ]; then
  for round in $(seq 1 "$ROUNDS"); do
    (cd "$BASE_TREE" && bun "$HARNESS" latency --template "$WORK/template" --out "$WORK/base-latency-$round.json" --rtt-ms "$RTT" --iterations "$ITER" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"})
    (cd "$REPO" && bun "$HARNESS" latency --template "$WORK/template" --out "$WORK/branch-latency-$round.json" --rtt-ms "$RTT" --iterations "$ITER" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"})
    (cd "$REPO" && bun "$HARNESS" compare "$WORK/base-latency-$round.json" "$WORK/branch-latency-$round.json" | grep -E '^(latency|statement)') || true
  done
fi
echo "receipts: $WORK"
exit "$status"
