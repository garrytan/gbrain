#!/bin/sh
# kos-deep-lint.sh — monthly v1 deep lint via Minions shell job.
# Triggered on day 1 of each month at 09:00 by launchd (com.jarvis.kos-deep-lint).
# NOTE: This hits the v1 repo at /Users/chenyuanquan/Projects/jarvis-knowledge-os
# which uses its own kos CLI, not gbrain. Retained during v1→v2 overlap period.
set -eu

GBRAIN="/Users/chenyuanquan/.bun/bin/gbrain"

PARAMS=$(cat <<'JSON'
{
  "cmd": "cd /Users/chenyuanquan/Projects/jarvis-knowledge-os && ./kos lint --deep",
  "cwd": "/Users/chenyuanquan/Projects/jarvis-knowledge-os"
}
JSON
)

exec env GBRAIN_ALLOW_SHELL_JOBS=1 "$GBRAIN" jobs submit shell \
  --params "$PARAMS" \
  --follow \
  --max-attempts 1 \
  --timeout-ms 1200000 \
  --queue deep-lint
