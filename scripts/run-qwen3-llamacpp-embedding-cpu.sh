#!/usr/bin/env bash
set -euo pipefail

LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"
LLAMA_CPP_BUILD_DIR="${MBRAIN_LLAMA_CPP_BUILD_DIR:-/tmp/llama.cpp-mbrain/build-mbrain}"
LLAMA_CACHE="${LLAMA_CACHE:-/tmp/llama.cpp-cache}"
MODEL="${MBRAIN_LLAMA_CPP_MODEL:-mradermacher/Qwen3-Embedding-0.6B-GGUF:Q4_K_M}"
BIND_HOST="${MBRAIN_LLAMA_CPP_BIND_HOST:-127.0.0.1}"
PORT="${MBRAIN_LLAMA_CPP_PORT:-8080}"
THREADS="${MBRAIN_LLAMA_CPP_THREADS:-20}"
CTX_SIZE="${MBRAIN_LLAMA_CPP_CTX_SIZE:-8192}"
BATCH_SIZE="${MBRAIN_LLAMA_CPP_BATCH_SIZE:-8192}"
UBATCH_SIZE="${MBRAIN_LLAMA_CPP_UBATCH_SIZE:-8192}"
ALIAS="${MBRAIN_LOCAL_EMBEDDING_MODEL:-qwen3-embedding:0.6b}"

if command -v "$LLAMA_SERVER" >/dev/null 2>&1; then
  LLAMA_SERVER="$(command -v "$LLAMA_SERVER")"
elif [[ "$LLAMA_SERVER" == "llama-server" && -x "$LLAMA_CPP_BUILD_DIR/bin/llama-server" ]]; then
  LLAMA_SERVER="$LLAMA_CPP_BUILD_DIR/bin/llama-server"
else
  echo "llama-server not found. Install llama.cpp, then rerun this script." >&2
  exit 127
fi

mkdir -p "$LLAMA_CACHE"
export LLAMA_CACHE

for arg in "$@"; do
  case "$arg" in
    -h|--help|--usage|--version)
      exec "$LLAMA_SERVER" "$arg"
      ;;
  esac
done

exec "$LLAMA_SERVER" \
  -hf "$MODEL" \
  --embeddings \
  --pooling last \
  --host "$BIND_HOST" \
  --port "$PORT" \
  -t "$THREADS" \
  -tb "$THREADS" \
  -c "$CTX_SIZE" \
  -b "$BATCH_SIZE" \
  -ub "$UBATCH_SIZE" \
  -a "$ALIAS" \
  --no-webui \
  "$@"
