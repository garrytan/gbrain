#!/usr/bin/env bash
H="$1"; shift
env -u DATABASE_URL -u OPENAI_API_KEY -u OPENAI_API_KEY__OPEN_AI_KEY -u VOYAGE_API_KEY -u ANTHROPIC_API_KEY HOME="$H" GBRAIN_HOME="$H" TZ=UTC GBRAIN_SKIP_STARTUP_HOOKS=1 /home/ubuntu/.bun/bin/bun run /var/tmp/audit/health/scripts/sql.ts "$@"
