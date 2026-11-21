#!/usr/bin/env bash
# Usage: brain-keyless.sh <home> <gbrain args...>  (keyless; no GBRAIN_SWEEP=0, so startup hooks and the link sweep run as for a user)
H="$1"; shift; mkdir -p "$H"
env -u DATABASE_URL -u GBRAIN_DATABASE_URL -u OPENAI_API_KEY -u OPENAI_API_KEY__OPEN_AI_KEY -u ANTHROPIC_API_KEY -u VOYAGE_API_KEY \
  HOME="$H" GBRAIN_HOME="$H" GBRAIN_SELF_UPGRADE_MODE=off TZ=UTC PATH="/home/ubuntu/.bun/bin:$PATH" \
  /home/ubuntu/.bun/bin/bun run /code/garrytan/gbrain/src/cli.ts "$@"
