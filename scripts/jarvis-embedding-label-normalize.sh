#!/usr/bin/env bash
# jarvis-embedding-label-normalize.sh — daily cosmetic fix for the gbrain embed
# mislabel bug. The daemon stamps the per-chunk `content_chunks.model` column
# with a stale gateway default (`zeroentropyai:zembed-1`) on EVERY write
# (mailagent/舆情 daily writes, corpus-synth/synthesis-sweep re-runs, any MCP
# put_page), even though the vector itself is the real openai:text-embedding-3-
# large@1536 via avman (§6.32 convergence). The label is purely cosmetic — the
# dynamic column resolver routes by COLUMN name, not the model label — but a
# drifting label trips the embedding-gateway-guard's "mixed-model" regression
# check and muddies diagnostics. This normalizes it daily.
#
# SAFETY GUARD: only relabels when the brain's embedding config is still
# openai:text-embedding-3-large. If the config ever legitimately switches
# models, this refuses to relabel — so it never MASKS a real model change /
# incoherence (which is exactly what the guard should catch).
#
# Manual: bash scripts/jarvis-embedding-label-normalize.sh [--dry]
set -uo pipefail
DB="${GBRAIN_DATABASE_URL:-postgresql://chenyuanquan@127.0.0.1:5432/gbrain}"
STALE_LABEL="zeroentropyai:zembed-1"
CANON="openai:text-embedding-3-large"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Guard: confirm the brain is still on the canonical te3 model (DB config plane).
cfg=$(psql "$DB" -At -c "SELECT value FROM config WHERE key='embedding_model'" 2>/dev/null)
if [ "$cfg" != "$CANON" ]; then
  echo "$(ts) SKIP: embedding_model='$cfg' != '$CANON' — refusing to relabel (would mask a real model change)"
  exit 0
fi

n=$(psql "$DB" -At -c "SELECT count(*) FROM content_chunks WHERE model='$STALE_LABEL' AND embedding IS NOT NULL" 2>/dev/null)
n=${n:-0}
if [ "$n" -eq 0 ]; then echo "$(ts) ok: 0 mislabeled chunks, nothing to do"; exit 0; fi

if [ "$DRY" = 1 ]; then
  echo "$(ts) [dry] would relabel $n chunks '$STALE_LABEL' -> '$CANON'"
  exit 0
fi
psql "$DB" -c "UPDATE content_chunks SET model='$CANON' WHERE model='$STALE_LABEL'" >/dev/null 2>&1
echo "$(ts) relabeled $n chunks '$STALE_LABEL' -> '$CANON'"
