#!/bin/bash
# GBrain → Gemini 橋接啟動腳本
# 前置條件：Chrome 已開啟 gemini.google.com（已登入 Google 帳號）
# 用法: bash scripts/ask-gemini.sh "你的問題"

if [ -z "$1" ]; then
  echo "用法: bash scripts/ask-gemini.sh \"你的問題\""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export GBRAIN_QUERY="$1"
browser-harness -c "$(cat "$SCRIPT_DIR/ask-gemini.py")"
