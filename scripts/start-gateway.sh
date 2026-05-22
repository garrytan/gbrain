#!/bin/bash
# 啟動 GBrain 本地密碼閘道器
# Usage: bash scripts/start-gateway.sh

source ~/.gbrain/gateway.env
exec bun /Users/ryan/gbrain/scripts/local-gateway.ts
