#!/bin/bash
# scripts/check-source-scope-onboard.sh
# v0.41.18.0 (A26, T17). Grep guard against SQL sites in src/core/onboard/
# and the 4 new onboard-derived doctor checks that touch source_id-bearing
# tables (pages, content_chunks, takes, links, timeline_entries) WITHOUT
# either:
#   (a) including source_id / source_ids in the WHERE clause, OR
#   (b) carrying the explicit opt-out marker `sourcescope:brain-wide` in
#       an adjacent comment.
#
# Brain-wide metrics (embed_staleness, takes_count, total entity counts)
# are legitimate brain-wide queries — they MUST NOT auto-filter by source
# because the metric IS "across all sources". The opt-out marker is the
# explicit acknowledgement that this is intentional. Any new code touching
# per-source data WITHOUT the marker has to add source-scoping.

set -e

FILES_TO_CHECK=(
  "src/core/onboard/checks.ts"
  "src/core/onboard/impact-capture.ts"
  "src/core/onboard/render.ts"
  "src/commands/onboard.ts"
)

ERR=0

for f in "${FILES_TO_CHECK[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi

  # Skip a file entirely when it doesn't contain SQL at all.
  if ! grep -qE 'executeRaw|SELECT|INSERT|UPDATE|DELETE' "$f"; then
    continue
  fi

  # File-level opt-out: if the file declares `sourcescope:file-brain-wide`
  # in its header (first 30 lines), every SQL site inside is treated as
  # intentionally brain-wide. Use sparingly — only for files whose SQL
  # is structurally always-aggregate (onboard/checks.ts, impact-capture.ts).
  if head -30 "$f" | grep -q 'sourcescope:file-brain-wide'; then
    continue
  fi

  # Search for SQL-ish lines that DO NOT contain source_id and DO NOT have
  # the brain-wide opt-out marker on the same line or within 3 lines above.
  while IFS=: read -r line content; do
    # Skip if source_id mentioned on this or nearby lines (5-line window).
    start=$((line - 4))
    [ "$start" -lt 1 ] && start=1
    if sed -n "${start},${line}p" "$f" | grep -qE 'source_id|sourceIds|sourcescope:brain-wide'; then
      continue
    fi
    echo "[check-source-scope-onboard] $f:$line — SQL site lacks source_id WHERE clause OR brain-wide opt-out marker"
    echo "    $content"
    ERR=1
  done < <(grep -nE 'FROM pages|FROM content_chunks|FROM takes\b|FROM links|FROM timeline_entries|UPDATE pages|UPDATE content_chunks|DELETE FROM pages|DELETE FROM content_chunks' "$f" || true)
done

if [ "$ERR" -eq 1 ]; then
  echo ""
  echo "[check-source-scope-onboard] One or more SQL sites in onboard surfaces lack source_id scoping."
  echo "Either: (a) add source_id = \$N (or source_id = ANY(\$N::text[])) to the WHERE,"
  echo "        or (b) add a comment marker 'sourcescope:brain-wide' within 4 lines above"
  echo "        the SQL to declare intent."
  exit 1
fi

exit 0
