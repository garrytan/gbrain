#!/usr/bin/env bash
# Tier 2 (e2e.yml) runs gbrain's stdio MCP server behind this tap (#8002).
# Every JSON-RPC message OpenClaw sends the server is appended to <log>, so
# test/e2e/skills.test.ts can require that the agent made a gbrain tool call
# (scripts/mcp-tap-calls.ts reads it). The server's stdout goes straight back
# to the client, untouched.
#
# Usage: scripts/ci-mcp-tap.sh <log> -- <server command...>
set -uo pipefail
if [ $# -lt 3 ] || [ "$2" != -- ]; then
  echo "usage: scripts/ci-mcp-tap.sh <log> -- <server command...>" >&2
  exit 2
fi
log=$1
shift 2
tee -a "$log" | "$@"
