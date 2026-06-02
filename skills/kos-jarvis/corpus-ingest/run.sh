#!/usr/bin/env bash
# corpus-ingest — one-command bulk-ingest pipeline (D→I→K→W) for ONE isolated source.
#
# Turns a folder of frontmatter'd .md files (prepared by a format adapter — see
# docs/omada/{extract-ug,crawl-faq}.py for examples) into a queryable knowledge
# asset: facts (RAG) + entities + graph + corpus-level viewpoints (wisdom).
#
# Stages (each idempotent/incremental — safe to re-run; --from/--to-stage to scope):
#   0 register      ensure the isolated source exists (gbrain sources add)
#   1 ingest        parallel `gbrain put` every *.md under the source dir (skips slugs already in DB)
#   2 embed         gbrain embed --stale (20-way concurrent) — RAG-queryable
#   3 enrich        enrich-sweep --tier3-only (Haiku NER → entity stubs; NER-cached)
#   4 graph         extract links --by-mention + timeline (entity↔source graph)
#   5 entity-synth  synthesis-sweep (per-entity Opus dossiers) — OPT-IN (--entity-synth);
#                   right for entity-rich corpora (people/companies), NOT product/knowledge docs
#   6 corpus-synth  corpus-synth (corpus-level Opus viewpoint/insight pages) — the universal W layer
#
# Usage:
#   run.sh --source omada --path ~/omada-kb                 # full D→I→K→W (corpus-synth W)
#   run.sh --source omada --path ~/omada-kb --entity-synth  # also per-entity dossiers
#   run.sh --source omada --plan                            # show stage plan + counts, no LLM/writes
#   run.sh --source omada --from-stage 6                    # just re-run corpus W (incremental)
#   run.sh --source omada --refresh-stale                   # incremental refresh (stale entity dossiers)
#
# Exit: 0 ok | 1 fatal
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"
DB="${GBRAIN_DATABASE_URL:-postgresql://chenyuanquan@127.0.0.1:5432/gbrain}"
[ -f .env.local ] && { set -a; . ./.env.local; set +a; }

SRC=""; DIR=""; FROM=0; TO=6; ENTITY_SYNTH=0; REFRESH_STALE=0
PUTC=8; SYNC=3; MIN_EVID=3; MIN_NB=3; TOKBUD=120000; PLAN=0
while [ $# -gt 0 ]; do case "$1" in
  --source) SRC="$2"; shift 2;;
  --path) DIR="$2"; shift 2;;
  --from-stage) FROM="$2"; shift 2;;
  --to-stage) TO="$2"; shift 2;;
  --entity-synth) ENTITY_SYNTH=1; shift;;
  --refresh-stale) REFRESH_STALE=1; shift;;
  --put-concurrency) PUTC="$2"; shift 2;;
  --synth-concurrency) SYNC="$2"; shift 2;;
  --min-evidence) MIN_EVID="$2"; shift 2;;
  --min-neighbors) MIN_NB="$2"; shift 2;;
  --token-budget) TOKBUD="$2"; shift 2;;
  --plan|--dry) PLAN=1; shift;;
  -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0;;
  *) echo "unknown flag: $1" >&2; exit 1;;
esac; done
[ -z "$SRC" ] && { echo "--source <name> required" >&2; exit 1; }

q() { psql "$DB" -At -F'|' -c "$1"; }
sql_lit() { printf "%s" "$1" | sed "s/'/''/g"; }
stage_on() { [ "$1" -ge "$FROM" ] && [ "$1" -le "$TO" ]; }
hdr() { echo; echo "=== [stage $1/$2] $3  @ $(date +%H:%M:%S) ==="; }

SRCL="$(sql_lit "$SRC")"
# resolve source dir from registry if --path omitted
if [ -z "$DIR" ]; then
  DIR="$(q "SELECT local_path FROM sources WHERE id='$SRCL'" | head -1)"
fi

echo "corpus-ingest: source=$SRC  dir=${DIR:-<none>}  stages=$FROM..$TO  entity-synth=$ENTITY_SYNTH  $([ $PLAN = 1 ] && echo '[PLAN]')"

# ── stage 0: register ─────────────────────────────────────────────
if stage_on 0; then
  hdr 0 6 "register source"
  if [ -n "$(q "SELECT id FROM sources WHERE id='$SRCL'")" ]; then
    echo "  source '$SRC' already registered ($DIR)"
  elif [ "$PLAN" = 1 ]; then
    echo "  [plan] would register source '$SRC' --path ${DIR:-~/$SRC-kb} --no-federated"
  else
    [ -z "$DIR" ] && DIR="$HOME/$SRC-kb"
    mkdir -p "$DIR"
    bin/gbrain sources add "$SRC" --path "$DIR" --no-federated
  fi
fi

# ── stage 1: ingest (parallel put of new *.md) ────────────────────
if stage_on 1; then
  hdr 1 6 "ingest *.md (parallel put, ${PUTC}-way)"
  if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
    echo "  no source dir ($DIR) — skipping ingest"
  else
    existing="$(q "SELECT slug FROM pages WHERE source_id='$SRCL' AND deleted_at IS NULL")"
    : > /tmp/ci-new-$SRC.txt
    while IFS= read -r f; do
      rel="${f#"$DIR"/}"; slug="${rel%.md}"
      grep -qxF "$slug" <<<"$existing" || echo "$f" >> /tmp/ci-new-$SRC.txt
    done < <(find "$DIR" -type f -name '*.md')
    n=$(wc -l < /tmp/ci-new-$SRC.txt | tr -d ' ')
    echo "  $n new .md to ingest (already in DB are skipped)"
    if [ "$PLAN" = 1 ]; then echo "  [plan] would put $n pages"; elif [ "$n" -gt 0 ]; then
      xargs -P "$PUTC" -I{} sh -c 'f="$1"; rel="${f#'"$DIR"'/}"; slug="${rel%.md}"; bin/gbrain put "$slug" --source '"$SRC"' < "$f" >/dev/null 2>&1 && echo ok || echo "FAIL $slug"' _ {} < /tmp/ci-new-$SRC.txt > /tmp/ci-put-$SRC.log
      echo "  put ok=$(grep -c '^ok' /tmp/ci-put-$SRC.log) fail=$(grep -c '^FAIL' /tmp/ci-put-$SRC.log)"
    fi
  fi
fi

# ── stage 2: embed --stale ────────────────────────────────────────
if stage_on 2; then
  hdr 2 6 "embed --stale (20-way concurrent)"
  if [ "$PLAN" = 1 ]; then
    q "SELECT '  stale chunks: '||count(*) FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='$SRCL' AND c.embedding IS NULL"
  else
    bin/gbrain embed --stale --source "$SRC" --batch-size 256 2>&1 | tail -2
  fi
fi

# ── stage 3: enrich (Haiku NER → entities) ────────────────────────
if stage_on 3; then
  hdr 3 6 "enrich-sweep --tier3-only (Haiku NER)"
  if [ "$PLAN" = 1 ]; then
    GBRAIN_SOURCE="$SRC" bun run skills/kos-jarvis/enrich-sweep/run.ts --plan --tier3-only 2>&1 | grep -E 'pages|unique entities|new stubs' | head
  else
    GBRAIN_SOURCE="$SRC" bun run skills/kos-jarvis/enrich-sweep/run.ts --tier3-only 2>&1 | tail -4
  fi
fi

# ── stage 4: graph (links + timeline) ─────────────────────────────
if stage_on 4; then
  hdr 4 6 "extract links --by-mention + timeline"
  if [ "$PLAN" = 1 ]; then echo "  [plan] would (re)build by-mention links + timeline for source $SRC"; else
    bin/gbrain extract links --by-mention --source db --source-id "$SRC" 2>&1 | tail -2
    bin/gbrain extract timeline --source db --source-id "$SRC" 2>&1 | tail -1
  fi
fi

# ── stage 5: per-entity synthesis (OPT-IN) ────────────────────────
if stage_on 5; then
  hdr 5 6 "synthesis-sweep (per-entity dossiers)"
  qual=$(q "WITH n AS (SELECT e.id, count(DISTINCT nb.id) c FROM pages e JOIN links l ON (l.to_page_id=e.id OR l.from_page_id=e.id) JOIN pages nb ON nb.id=(CASE WHEN l.from_page_id=e.id THEN l.to_page_id ELSE l.from_page_id END) WHERE e.source_id='$SRCL' AND e.type IN ('person','company','concept','project','entity') AND e.deleted_at IS NULL AND nb.type='source' AND nb.deleted_at IS NULL GROUP BY e.id) SELECT count(*) FROM n WHERE c>=$MIN_NB")
  echo "  entities with >=$MIN_NB source-neighbors: ${qual:-0}"
  if [ "$ENTITY_SYNTH" != 1 ]; then
    echo "  SKIP (per-entity is opt-in via --entity-synth; corpus-synth (stage 6) is the universal W layer)."
    [ "${qual:-0}" -ge 30 ] && echo "  NOTE: $qual entities qualify — this corpus may be entity-rich; consider --entity-synth."
  elif [ "$PLAN" = 1 ]; then
    echo "  [plan] would synthesize ~$qual per-entity dossiers (Opus)"
  else
    rs=""; [ "$REFRESH_STALE" = 1 ] && rs="--refresh-stale"
    bun run skills/kos-jarvis/synthesis-sweep/run.ts --source "$SRC" --min-neighbors "$MIN_NB" --concurrency "$SYNC" --token-budget "$TOKBUD" $rs 2>&1 | tail -5
  fi
fi

# ── stage 6: corpus-synth (universal W layer) ─────────────────────
if stage_on 6; then
  hdr 6 6 "corpus-synth (corpus-level viewpoints)"
  if [ "$PLAN" = 1 ]; then
    bun run skills/kos-jarvis/corpus-synth/run.ts --source "$SRC" --plan 2>&1 | grep -E 'docs in map|PLAN'
  else
    bun run skills/kos-jarvis/corpus-synth/run.ts --source "$SRC" --min-evidence "$MIN_EVID" --concurrency "$SYNC" 2>&1 | tail -6
  fi
fi

# ── report ────────────────────────────────────────────────────────
echo; echo "=== corpus-ingest report: source=$SRC @ $(date +%H:%M:%S) ==="
q "SELECT CASE WHEN slug LIKE 'synthesis/%' THEN 'W: viewpoint pages'
               WHEN type IN ('person','company','concept','project','entity') THEN 'K: entities'
               ELSE 'D: source pages' END AS layer,
          count(*) AS pages,
          count(*) FILTER (WHERE (SELECT count(*) FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NULL)>0) AS pages_with_null_emb
   FROM pages p WHERE source_id='$SRCL' AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC"
echo "=== corpus-ingest DONE ==="
