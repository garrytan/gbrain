#!/bin/sh
# gbrain for skill evals: the pinned checkout, keyless (model keys stripped so the brain never makes paid calls).
exec env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CODEX_API_KEY -u GEMINI_API_KEY -u VOYAGE_API_KEY -u JEV_TYPESAFE_API_KEY -u TYPESAFE_API_KEY -u UBICLOUD_API_TOKEN \
  /usr/local/bin/bun "${GBRAIN_EVAL_SRC:-$EVAL_ROOT/gbrain-src}/src/cli.ts" "$@"
