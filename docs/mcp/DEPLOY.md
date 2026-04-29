# Deploy GBrain Remote MCP Server

> **v0.22.7+:** Use `gbrain serve --http` for remote access. It includes built-in
> bearer token auth, default-deny CORS, two-bucket rate limiting, body cap, and
> per-request audit log. **Postgres-only** (PGLite is local-only by design).
> See [SECURITY.md](../../SECURITY.md) for env vars and tunable defaults.

Access your brain from any device, any AI client. GBrain's MCP server runs locally
via `gbrain serve` (stdio). For remote access, expose it via the built-in HTTP
transport behind a public tunnel.

## Two Paths

### Local (zero setup)

```bash
gbrain serve
```

Works with Claude Code, Cursor, Windsurf, and any MCP client that supports stdio.
No server, no tunnel, no token needed. Works on both PGLite and Postgres engines.

### Remote (any device, any AI client) — Postgres only

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app)
  → gbrain serve --http  (built-in transport with bearer auth)
  → Postgres (pooler connection or self-hosted)
```

This requires:
1. A Postgres-backed brain (the `access_tokens` table only exists on Postgres;
   running `gbrain serve --http` against a PGLite install fails fast at startup)
2. A machine running `gbrain serve --http`
3. A public tunnel (ngrok, Tailscale, or cloud host)
4. A bearer token created via `gbrain auth create <name>`

## Remote Setup

### 1. Set up the tunnel

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for full setup.
Quick version:

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787 --url your-brain.ngrok.app  # Hobby tier for fixed domain
```

### 2. Create access tokens

```bash
# Create a token for each client
gbrain auth create "claude-desktop"

# List all tokens
gbrain auth list

# Revoke a token
gbrain auth revoke "claude-desktop"
```

Tokens are per-client. Create one for each device/app. Revoke individually
if compromised. Tokens are stored SHA-256 hashed in your database.

### 3. Connect your AI client

- **Claude Code:** [setup guide](CLAUDE_CODE.md)
- **Claude Desktop:** [setup guide](CLAUDE_DESKTOP.md) (must use GUI, not JSON config)
- **Claude Cowork:** [setup guide](CLAUDE_COWORK.md)
- **Perplexity:** [setup guide](PERPLEXITY.md)

### 4. Verify

```bash
gbrain auth test \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  --token YOUR_TOKEN
```

## Operations

All 30 GBrain operations are available remotely, including `sync_brain` and
`file_upload` (no timeout limits with self-hosted server).

**Security note on `file_upload`:** remote MCP callers are confined to the working
directory where `gbrain serve` was launched. Symlinks, `..` traversal, and absolute
paths outside cwd are rejected. Page slugs and filenames are allowlist-validated
(alphanumeric + hyphens; no control chars, RTL overrides, or backslashes). Local
CLI callers (`gbrain file upload ...`) keep unrestricted filesystem access since
the user owns the machine.

## Deployment Options

See [ALTERNATIVES.md](ALTERNATIVES.md) for a comparison of ngrok, Tailscale
Funnel, and cloud hosts (Fly.io, Railway).

## Troubleshooting

**"missing_auth" error**
Include the Authorization header: `Authorization: Bearer YOUR_TOKEN`

**"invalid_token" error**
Run `gbrain auth list` to see active tokens.

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

**Note:** `gbrain serve --http` (built-in HTTP transport) is planned but not yet
implemented. Currently, remote MCP requires a custom HTTP wrapper. See the
production deployment pattern in the [voice recipe](../../recipes/twilio-voice-brain.md)
for a reference implementation.
