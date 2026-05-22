#!/bin/bash
# 啟動 OpenRouter Proxy（Claude Code → GLM-4.6）
# Usage: bash scripts/start-openrouter-proxy.sh
#
# Claude Code 使用：
#   export ANTHROPIC_BASE_URL=http://localhost:4000
#   export ANTHROPIC_API_KEY=anything

source ~/.gbrain/gateway.env
exec bun /Users/ryan/gbrain/scripts/openrouter-proxy.ts
