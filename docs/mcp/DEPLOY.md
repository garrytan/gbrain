# Deploy MBrain Remote MCP Server

Access your brain from any device, any AI client. MBrain's MCP server runs
locally via `mbrain serve` (stdio) or remotely via the built-in
`mbrain serve --http` Streamable HTTP transport behind a public tunnel.

## Two Paths

### Local (zero setup)

```bash
mbrain serve
```

Works with Claude Code, Cursor, Windsurf, and any MCP client that supports stdio.
No server, no tunnel, no token needed.

### Remote (any device, any AI client)

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app)
  → mbrain serve --http
  → Supabase Postgres (via pooler connection string)
```

This requires:
1. A machine running `mbrain serve --http`
2. A public tunnel (ngrok, Tailscale, or cloud host)
3. Bearer token auth for most clients, or opt-in OAuth for ChatGPT-style clients

## Remote Setup

### 1. Start HTTP MCP

Run the MCP server on a local interface first:

```bash
mbrain serve --http --host 127.0.0.1 --port 8787
```

The HTTP server exposes:

- `/mcp` — Streamable HTTP MCP endpoint, protected by Bearer tokens
- `/health` — unauthenticated minimal health check with transport status

For ChatGPT-style OAuth clients, set an owner approval token and enable OAuth:

```bash
export MBRAIN_OAUTH_APPROVAL_TOKEN='choose-a-long-random-token'
export MBRAIN_OAUTH_SIGNING_SECRET='choose-a-separate-32-plus-byte-random-secret'
mbrain serve --http \
  --host 127.0.0.1 \
  --port 8787 \
  --oauth \
  --public-url https://your-brain.ngrok.app
```

OAuth adds discovery, Dynamic Client Registration, authorization, and token
endpoints while still issuing ordinary MBrain bearer tokens under the hood.
Use a separate `MBRAIN_OAUTH_SIGNING_SECRET` for refresh-token signing; if it is
unset, MBrain warns and falls back to the approval token for local testing only.

### 2. Set up the tunnel

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for full setup.
Quick version:

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787 --url your-brain.ngrok.app  # Hobby tier for fixed domain
```

### 3. Create access tokens

```bash
# Use the same Postgres connection string that `mbrain serve --http` uses.
export DATABASE_URL='postgresql://...'

# Create a token for each client
bun run src/commands/auth.ts create "claude-desktop"

# List all tokens
bun run src/commands/auth.ts list

# Revoke a token
bun run src/commands/auth.ts revoke "claude-desktop"
```

Tokens are per-client. Create one for each device/app. Revoke individually
if compromised. Tokens are stored SHA-256 hashed in your database.

### 4. Connect your AI client

- **Claude Code:** [setup guide](CLAUDE_CODE.md)
- **Claude Desktop:** [setup guide](CLAUDE_DESKTOP.md) (must use GUI, not JSON config)
- **Claude Cowork:** [setup guide](CLAUDE_COWORK.md)
- **Perplexity:** [setup guide](PERPLEXITY.md)
- **ChatGPT:** [setup guide](CHATGPT.md) (requires `--oauth`)

### 5. Verify

```bash
bun run src/commands/auth.ts test \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  --token YOUR_TOKEN
```

## Operations

All 30 MBrain operations are available remotely, including `sync_brain` and
`file_upload` (no timeout limits with self-hosted server).

## Deployment Options

See [ALTERNATIVES.md](ALTERNATIVES.md) for a comparison of ngrok, Tailscale
Funnel, and cloud hosts (Fly.io, Railway).

## Troubleshooting

**"missing_auth" error**
Include the Authorization header: `Authorization: Bearer YOUR_TOKEN`

When OAuth is enabled, the 401 response also advertises the protected-resource
metadata endpoint through `WWW-Authenticate`.

**"invalid_token" error**
Run `bun run src/commands/auth.ts list` to see active tokens.

**"oauth_not_configured" error**
OAuth routes are enabled but `MBRAIN_OAUTH_APPROVAL_TOKEN` is missing. Set it
and restart `mbrain serve --http --oauth`.

**"service_unavailable" error**
Database connection failed. Check your Supabase dashboard for outages.

**Claude Desktop doesn't connect**
Remote servers must be added via Settings > Integrations, NOT
`claude_desktop_config.json`. See [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md).

## Expected Latencies

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| get_page | < 100ms | Single DB query |
| list_pages | < 200ms | DB query with filters |
| search (keyword) | 100-300ms | Full-text search |
| query (hybrid) | 1-3s | Embedding + vector + keyword + RRF |
| put_page | 100-500ms | Write + trigger search_vector update |
| get_stats | < 100ms | Aggregate query |
