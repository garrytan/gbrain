#!/bin/sh
# Seeds a repo-less keyless brain for a brain-ops eval task: sh seed.sh <variant>
. "$(dirname "$0")/../_lib/eval.sh"
FIX="$(cd "$(dirname "$0")" && pwd)"
brain_new
brain_import "$FIX/pages"
case "${1:-base}" in
  base) ;;
  meetings)
    cp -R "$FIX/brain" ./brain
    brain_import ./brain ;;
  sailing)
    gbh remember "Bob Example likes sailing on weekends" --entity people/bob-example --provenance "user, 2026-10-01" >/dev/null 2>&1 ;;
  *) echo "unknown variant $1" >&2; exit 2 ;;
esac
remember_state brain_dump
