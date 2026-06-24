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
OAuth setup state requires the Postgres engine; use bearer-token HTTP MCP for
SQLite/PGLite local profiles. Postgres-backed setup state survives server
restarts, prunes unapproved DCR registrations after one hour, and caps pending
registrations at 128.
Use a separate `MBRAIN_OAUTH_SIGNING_SECRET` for refresh-token signing; it is
required, and `mbrain serve --http --oauth` exits at startup if either secret
is missing (the old approval-token fallback was removed). Refresh tokens are
one-use and rotate the underlying access-token binding; replay returns
`invalid_grant`.

OAuth credential endpoints (`/oauth/token`, `/oauth/authorize`,
`/oauth/register`) are rate limited per client TCP address (10 requests per
minute). Behind a reverse proxy (ngrok, nginx, Cloudflare) every client shares
the proxy's address and therefore one bucket; `X-Forwarded-For` is deliberately
not trusted. Browser CORS is allowlist-only: set `MBRAIN_HTTP_ALLOWED_ORIGINS`
(comma-separated origins) or rely on the `--public-url` origin; with neither,
no CORS headers are emitted.

For HTTP MCP clients such as ChatGPT Developer Mode, `tools/list` returns full
tool descriptors with titles, descriptions, and MCP read/write/destructive
annotations. Stdio keeps compact descriptors for frame-budget safety, and
`resources/list` returns an explicit empty list for clients that probe resources.

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

# Create a read/default token for each client
bun run src/commands/auth.ts create "claude-desktop"

# Add explicit capabilities only for clients that need them
bun run src/commands/auth.ts create "writer-client" --scope canonical_write
bun run src/commands/auth.ts create "raw-source-client" --scope raw_source
bun run src/commands/auth.ts create "trusted-client" --scope canonical_write --scope raw_source

# List all tokens
bun run src/commands/auth.ts list

# Revoke a token
bun run src/commands/auth.ts revoke "claude-desktop"
```

Tokens are per-client. Create one for each device/app. Revoke individually
if compromised. Tokens are stored SHA-256 hashed in your database. Default
tokens get only the `mcp` scope; remote `put_page` requires `canonical_write`,
and raw-source access requires `raw_source`.

OAuth grants default to the `mcp` scope as well. To let OAuth clients request
privileged scopes, start HTTP OAuth with an explicit allowlist:

```bash
MBRAIN_OAUTH_ALLOWED_SCOPES='mcp,canonical_write,raw_source' \
mbrain serve --http --oauth --public-url https://YOUR-DOMAIN.ngrok.app
```

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

For OAuth runtime confidence without ChatGPT credentials:

```bash
DATABASE_URL='postgresql://...' bun run smoke:http-oauth
```

That smoke starts the real HTTP MCP server locally, completes DCR + PKCE,
uses the issued token against `/mcp`, refreshes it, confirms the refreshed token
works while the pre-refresh token is rejected, rejects refresh-token replay,
checks the next refresh-token link in the chain, and checks Postgres token plus
request-log evidence.

To prove the OAuth setup state is Postgres-backed and survives server restarts:

```bash
DATABASE_URL='postgresql://...' \
MBRAIN_SMOKE_RESTART_OAUTH_STATE=1 \
bun run smoke:http-oauth
```

When validating a public tunnel or hosted URL, also verify that OAuth metadata
advertises that public HTTPS issuer:

```bash
DATABASE_URL='postgresql://...' \
MBRAIN_HTTP_PUBLIC_URL='https://YOUR-DOMAIN.ngrok.app' \
bun run smoke:http-oauth
```

This confirms the OAuth discovery documents and unauthenticated `/mcp`
challenge use the same public issuer remote clients will see. It does not prove
the public URL is reachable from outside your network; keep the tunnel health
check and client-side live validation as separate gates.

## Operations

The shared MBrain operation registry is available remotely, including
`sync_brain` and `file_upload` (no timeout limits with self-hosted server).

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
