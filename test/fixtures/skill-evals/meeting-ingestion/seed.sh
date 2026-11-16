#!/bin/sh
# Seeds a repo-less keyless brain with people and companies, plus the task's input: sh seed.sh <variant>
. "$(dirname "$0")/../_lib/eval.sh"
FIX="$(cd "$(dirname "$0")" && pwd)"
brain_new
brain_import "$FIX/pages"
case "$1" in
  planning|summary-only|stitched|unknown-speaker|contradiction|secret|deposition|garbled)
    cp "$FIX/transcripts/$1.txt" ./transcript.txt ;;
  duplicate)
    brain_import "$FIX/extra/duplicate"
    cp "$FIX/transcripts/planning.txt" ./transcript.txt ;;
  pitch)
    brain_import "$FIX/extra/pitch" ;;
  *) echo "unknown variant $1" >&2; exit 2 ;;
esac
remember_state brain_dump
