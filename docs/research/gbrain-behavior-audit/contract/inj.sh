#!/usr/bin/env bash
# inj.sh <home> <args...> ; env INJECT_SQL=regex
H="$1"; shift
env -u DATABASE_URL -u GBRAIN_DATABASE_URL -u OPENAI_API_KEY -u OPENAI_API_KEY__OPEN_AI_KEY -u ANTHROPIC_API_KEY -u VOYAGE_API_KEY \
  HOME="$H" GBRAIN_HOME="$H" GBRAIN_SELF_UPGRADE_MODE=off GBRAIN_SKIP_STARTUP_HOOKS=1 GBRAIN_SWEEP=0 TZ=UTC \
  /home/ubuntu/.bun/bin/bun run --preload=/var/tmp/audit/contract/inject.ts /code/garrytan/gbrain/src/cli.ts "$@"
