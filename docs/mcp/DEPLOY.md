# Deploy GBrain Remote MCP Server

> **v0.26.0+:** `gbrain serve --http` ships full OAuth 2.1 (client credentials,
> auth code + PKCE, refresh rotation, optional DCR), an embedded React admin
> dashboard at `/admin`, scoped operations, and a live SSE activity feed.
> Pre-v0.26 legacy bearer tokens still work — `verifyAccessToken` falls back
> to the `access_tokens` table and grandfathers tokens to `read+write+admin`.
> Postgres-only for the legacy fallback (the `access_tokens` table is Postgres-only);
> OAuth tables work on both PGLite and Postgres. See [SECURITY.md](../../SECURITY.md)
> for env vars and tunable defaults.

Access your brain from any device, any AI client. GBrain ships two transports:
`gbrain serve` (stdio) for local agents, and `gbrain serve --http` (v0.26.0+)
for remote clients over OAuth 2.1.

## Three Paths

### Local stdio (zero setup)

```bash
gbrain serve
```

Works with Claude Code, Cursor, Windsurf, and any MCP client that supports stdio.
No server, no tunnel, no token needed. Works on both PGLite and Postgres engines.

### Remote over OAuth 2.1 (recommended, v0.26.0+)

```bash
gbrain serve --http --port 3131
ngrok http 3131 --url your-brain.ngrok.app
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
```

Built-in HTTP transport with OAuth 2.1, scoped operations, an admin dashboard
at `/admin`, and a live SSE activity feed. Zero external dependencies. This is
the only path that works with ChatGPT (OAuth 2.1 + PKCE is required by the
ChatGPT MCP connector). Pass `--public-url` whenever the server is reachable
at anything other than `http://localhost:<port>` so the OAuth issuer in
discovery metadata matches what clients hit (RFC 8414 §3.3).

Supported clients:
- **ChatGPT** — requires OAuth 2.1 + PKCE. Works natively with `--http`.
- **Claude Desktop / Cowork** — OAuth 2.1 or legacy bearer tokens.
- **Perplexity** — OAuth 2.1 client credentials grant.
- **Claude Code, Cursor, Windsurf** — can use OAuth or legacy bearer.

See the [OAuth 2.1 setup](#oauth-21-setup-v100) section below.

### Remote with legacy bearer tokens (pre-v0.26 deployments) — Postgres only

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

Pre-v1.0 tokens are grandfathered as `read+write+admin` scopes when you upgrade
to the HTTP server, so no migration is required.

## OAuth 2.1 Setup (v0.26.0+)

### 1. Start the HTTP server

```bash
gbrain serve --http --port 3131
```

On first start, the server prints an **admin bootstrap token** to stderr:

```
Admin bootstrap token: 3a1f9c...
Open http://localhost:3131/admin and paste it to log in.
```

Save this token. Open `http://localhost:3131/admin` and paste it to access the
dashboard. The dashboard shows live activity, registered clients, request logs,
and per-client config export.

> **v0.26.9+:** `mcp_request_log.params` and the live SSE activity feed default
> to a redacted summary `{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`.
> Declared param keys are kept (intersected against the operation's spec); unknown
> keys are counted but never named, and byte sizes round up to 1KB so size-probe
> attacks can't binary-search secret content. Operators on a personal laptop who
> want raw payloads back can pass `gbrain serve --http --log-full-params` (loud
> stderr warning fires at startup). Multi-tenant deployments should leave it on
> the redacted default.

### 2. Register OAuth clients

Register clients from the **`/admin` dashboard**:

1. Click **Register client**.
2. Enter a name (e.g. `perplexity`, `chatgpt`).
3. Pick scopes: `read`, `write`, `admin` (checkboxes).
4. Pick grant type: `client_credentials` for machine-to-machine (Perplexity,
   Claude Desktop bearer mode) or `authorization_code` for browser-based
   clients with PKCE (ChatGPT).
5. For `authorization_code` clients, paste the redirect URI.
6. Hit **Register**. The credential-reveal modal shows the `client_id` (and
   `client_secret` for confidential clients) once. Copy or Download JSON
   immediately — secrets are hashed on storage and never shown again.

Or from the CLI — faster for scripting:

```bash
gbrain auth register-client perplexity \
  --grant-types client_credentials \
  --scopes "read write"
```

Host-repo wrappers can register programmatically:

```ts
await oauthProvider.registerClientManual(
  'perplexity',
  ['client_credentials'],
  'read write',
  [],  // redirect_uris, empty for CC
);
```

For self-service client registration (Dynamic Client Registration, RFC 7591),
start the server with `--enable-dcr`. DCR is off by default.

### 3. Expose the server

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 3131 --url your-brain.ngrok.app
```

Your OAuth issuer URL becomes `https://your-brain.ngrok.app`. The MCP SDK's
router exposes the spec-compliant discovery endpoint at
`/.well-known/oauth-authorization-server`.

### 4. Scopes and localOnly

Every operation is tagged `read | write | admin`. Four operations are
`localOnly` and rejected over HTTP regardless of scope: `sync_brain`,
`file_upload`, `file_list`, `file_url`. Remote agents cannot reach local
filesystem surface area.

| Scope | What it allows |
|-------|---------------|
| `read` | `search`, `query`, `get_page`, `list_pages`, graph traversal |
| `write` | `put_page`, `delete_page`, `add_link`, `add_timeline_entry` |
| `admin` | Client management, token revocation, sweep, local-only ops |

## Legacy Bearer Token Setup

Keep using pre-v0.26 bearer tokens if you aren't ready to migrate. They
grandfather to `read+write+admin` scopes on the HTTP server.

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

- **ChatGPT:** [setup guide](CHATGPT.md) (OAuth 2.1 + PKCE, requires `gbrain serve --http`)
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

**Note:** `gbrain serve --http` shipped in v0.26.0 with OAuth 2.1 + admin
dashboard baked into the binary. The custom HTTP wrapper pattern (see
[voice recipe](../../recipes/twilio-voice-brain.md)) is still supported for
teams that need bespoke middleware, but for most remote deployments the
built-in server is the recommended path.
