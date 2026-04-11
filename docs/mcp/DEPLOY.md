# Deploy GBrain Remote MCP Server

Deploy your personal knowledge brain as a serverless MCP endpoint on your existing Supabase instance. Works with Claude Desktop, Claude Code, Cowork, and Perplexity Computer.

## Prerequisites

- GBrain already set up (`gbrain init` completed, data imported)
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- Your Supabase project ref (the `xxx` from `https://xxx.supabase.co`)

## Quick Start

```bash
# 1. Fill in your config
cp .env.production.example .env.production
# Edit .env.production with your DATABASE_URL, SUPABASE_PROJECT_REF, and either OPENAI_API_KEY or VENICE_API_KEY

# 2. Deploy (one command)
bash scripts/deploy-remote.sh

# 3. Create an access token
DATABASE_URL=$DATABASE_URL bun run src/commands/auth.ts create "my-client"
# Save the token — it's shown once

# 4. Test it
bun run src/commands/auth.ts test \
  https://YOUR_REF.supabase.co/functions/v1/gbrain-mcp/mcp \
  --token YOUR_TOKEN
```

## Authentication

GBrain uses bearer tokens stored in your database (SHA-256 hashed). Each token has a name for identification.

```bash
# Create a token
bun run src/commands/auth.ts create "claude-desktop"

# List all tokens
bun run src/commands/auth.ts list

# Revoke a token
bun run src/commands/auth.ts revoke "claude-desktop"
```

Tokens are per-client. Create one for each device/app. Revoke individually if compromised.

## Updating

When you update GBrain (new operations, bug fixes):

```bash
git pull
bash scripts/deploy-remote.sh
```

Your tokens survive upgrades. Check your deployed version:

```bash
curl https://YOUR_REF.supabase.co/functions/v1/gbrain-mcp/health
```

## Operations

All 28 GBrain operations are available remotely except:
- `sync_brain` (may exceed 60s Edge Function timeout)
- `file_upload` (may exceed 60s timeout with large files)

These remain CLI-only via `gbrain serve` (stdio).

## Troubleshooting

**"supabase: command not found"**
Install: `brew install supabase/tap/supabase` or `npm install -g supabase`

**Edge Function deploys but returns 500**
Check that your embedding provider secrets are set: `supabase secrets list`

OpenAI:
`OPENAI_API_KEY`

Venice:
`GBRAIN_EMBEDDING_PROVIDER=venice`
`VENICE_API_KEY`

OpenAI-compatible Venice mode also works:
`OPENAI_API_KEY`
`OPENAI_BASE_URL=https://api.venice.ai/api/v1`

**"missing_auth" error**
Include the Authorization header: `Authorization: Bearer YOUR_TOKEN`

**"invalid_token" error**
Run `bun run src/commands/auth.ts list` to see active tokens. The token may have been revoked or mistyped.

**"service_unavailable" error**
Database connection failed. Check your Supabase dashboard for outages or connection pool limits.

**Claude Desktop doesn't connect**
Remote MCP servers must be added via Settings > Integrations, NOT claude_desktop_config.json. See [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md).

## Expected Latencies

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| get_page | < 100ms | Single DB query |
| list_pages | < 200ms | DB query with filters |
| search (keyword) | 100-300ms | Full-text search |
| query (hybrid) | 1-3s | Embedding + vector + keyword + RRF |
| put_page | 100-500ms | Write + trigger search_vector update |
| get_stats | < 100ms | Aggregate query |

Cold start adds ~300-500ms on the first request after idle (Postgres connection setup via pgbouncer).
