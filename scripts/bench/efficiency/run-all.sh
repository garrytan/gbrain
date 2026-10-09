#!/usr/bin/env bash
# Efficiency bench orchestrator (GBRA-66). Opt-in, never run in CI.
#
#   scripts/bench/efficiency/run-all.sh [datasets...]     (default: default-pull synth-1x synth-full)
#
# Env:
#   BENCH_WORK      work dir (default ~/.capy/work/brain); brain data never leaves it
#   BENCH_ENGINES   "pglite postgres" (default)
#   BENCH_N         samples per hot path (default 20)
#   BENCH_EMBED     1 = embed during import (default 1); BENCH_EMBED_SKIP="pglite:synth-full" skips pairs
#   BENCH_MAX_USD   per-embed cap passed to gbrain embed --max-usd (default 2)
#   BENCH_PG_PORT   host port of the pgvector container (default 5440)
#   BUN             bun >= 1.4 binary (default: bun on PATH)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-bun}"
W="${BENCH_WORK:-$HOME/.capy/work/brain}"
ENGINES="${BENCH_ENGINES:-pglite postgres}"
N="${BENCH_N:-20}"
PORT="${BENCH_PG_PORT:-5440}"
DATASETS=("$@")
[ ${#DATASETS[@]} -eq 0 ] && DATASETS=(default-pull synth-1x synth-full)

if [[ " $ENGINES " == *" postgres "* ]] && ! docker inspect gbra66-bench-pg >/dev/null 2>&1; then
  docker run -d --name gbra66-bench-pg -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:${PORT}:5432" pgvector/pgvector:pg16 >/dev/null
  until docker exec gbra66-bench-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
fi

# Data prep: pull -> importable dir, shapes, synthetic brains.
if [ -f "$W/pull/manifest-default.json" ]; then
  [ -d "$W/import/default-pull" ] || "$BUN" "$HERE/materialize-pull.ts" --source default
  [ -f "$W/shape-default.json" ] || "$BUN" "$HERE/synth-brain.ts" shape --manifest "$W/pull/manifest-default.json" --source default --pull-dir "$W/pull/default" --out "$W/shape-default.json"
fi
[ -f "$W/shape-full.json" ] || "$BUN" "$HERE/synth-brain.ts" full-shape --base "$W/shape-default.json" --out "$W/shape-full.json"
[ -d "$W/import/synth-1x" ] || "$BUN" "$HERE/synth-brain.ts" gen --shape "$W/shape-default.json" --out "$W/import/synth-1x"
[ -d "$W/import/synth-full" ] || "$BUN" "$HERE/synth-brain.ts" gen --shape "$W/shape-full.json" --out "$W/import/synth-full"

for ds in "${DATASETS[@]}"; do
  for eng in $ENGINES; do
    embed=()
    if [ "${BENCH_EMBED:-1}" = 1 ] && [[ " ${BENCH_EMBED_SKIP:-} " != *" $eng:$ds "* ]]; then embed=(--embed --max-usd "${BENCH_MAX_USD:-2}"); fi
    "$BUN" "$HERE/bench-import.ts" --engine "$eng" --data "$W/import/$ds" --label "$ds" --pg-url "postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres" "${embed[@]}"
    home="$W/engines/$eng-$ds"
    rm -rf "$home/sync-repo"
    first_src="$(ls "$W/import/$ds" | grep -v '\.json$' | head -1)"
    [ -d "$W/import/$ds/default" ] && first_src=default
    cp -r "$W/import/$ds/$first_src" "$home/sync-repo"
    "$BUN" "$HERE/bench-hot.ts" --engine "$eng" --label "$ds" --n "$N" --doctor-n "${BENCH_DOCTOR_N:-$N}" --sync-dir "$home/sync-repo"
  done
done
"$BUN" "$HERE/report.ts"
