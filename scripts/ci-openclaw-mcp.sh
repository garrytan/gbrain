#!/usr/bin/env bash
# Tier 2 (e2e.yml): register gbrain's stdio MCP server with OpenClaw, then
# prove OpenClaw sees it (#8002).
#
# OpenClaw 2026.4.9 reads its MCP servers from `mcp.servers` in
# ~/.openclaw/openclaw.json, and its embedded agent (`openclaw agent --local`)
# loads them from there. The job used to write `mcpServers` into
# ~/.openclaw/config.json, which OpenClaw never reads, so the agent ran with no
# gbrain tools. `openclaw mcp set` writes the file OpenClaw reads, and
# `openclaw mcp show` reads it back.
#
# gbrain serves its starter surface (31 tools): OpenClaw's default agent model
# is openai/gpt-5.4, OpenAI refuses a request with more than 128 tools, and
# OpenClaw adds about 31 of its own to gbrain's 158 on the full surface.
#
# The server runs behind scripts/ci-mcp-tap.sh, which logs every request to
# $GBRAIN_TEST_TIER2_MCP_TAP_LOG for test/e2e/skills.test.ts.
#
# Environment: DATABASE_URL and GBRAIN_TEST_TIER2_MCP_TAP_LOG (required);
# OPENCLAW, the CLI to call (default openclaw; the test overrides it).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must name the Tier 2 test database}"
: "${GBRAIN_TEST_TIER2_MCP_TAP_LOG:?GBRAIN_TEST_TIER2_MCP_TAP_LOG must name the tap log}"
openclaw=${OPENCLAW:-openclaw}

server=$(GBRAIN_REPO="$PWD" bun -e '
  const e = process.env;
  console.log(JSON.stringify({
    command: "bash",
    args: ["scripts/ci-mcp-tap.sh", e.GBRAIN_TEST_TIER2_MCP_TAP_LOG, "--", "bun", "run", "src/cli.ts", "serve", "--surface", "starter"],
    cwd: e.GBRAIN_REPO,
    env: { DATABASE_URL: e.DATABASE_URL },
  }));
')
: > "$GBRAIN_TEST_TIER2_MCP_TAP_LOG"
"$openclaw" mcp set gbrain "$server"
shown=$("$openclaw" mcp show gbrain --json 2>&1) || true
if ! EXPECTED="$server" SHOWN="$shown" bun -e '
  let b;
  try { b = JSON.parse(process.env.SHOWN); } catch { process.exit(1); }
  const a = JSON.parse(process.env.EXPECTED);
  const same = ["command", "cwd"].every(k => a[k] === b[k])
    && JSON.stringify(a.args) === JSON.stringify(b.args)
    && JSON.stringify(a.env) === JSON.stringify(b.env);
  process.exit(same ? 0 : 1);
'; then
  echo "::error::OpenClaw does not report the gbrain MCP server that was just saved; \`openclaw mcp show gbrain --json\` printed: $shown" >&2
  exit 1
fi
echo "OpenClaw reports the gbrain MCP server: $server"
