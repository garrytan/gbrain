#!/usr/bin/env bash
# Usage: brain.sh <lane-home-dir> <gbrain args...>
# Runs TS gbrain from the master checkout against an isolated, keyless PGLite brain.
H="$1"; shift
mkdir -p "$H"
export PATH="$HOME/.bun/bin:$PATH"
BUN=/home/ubuntu/.bun/bin/bun
env -u DATABASE_URL -u GBRAIN_DATABASE_URL -u OPENAI_API_KEY -u OPENAI_API_KEY__OPEN_AI_KEY -u ANTHROPIC_API_KEY -u VOYAGE_API_KEY \
  HOME="$H" GBRAIN_HOME="$H" GBRAIN_SELF_UPGRADE_MODE=off GBRAIN_SKIP_STARTUP_HOOKS=1 GBRAIN_SWEEP=0 TZ=UTC \
  "$BUN" run /code/garrytan/gbrain/src/cli.ts "$@"
