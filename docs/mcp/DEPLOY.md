# Deploy GBrain Remote MCP Server

> **v0.26.0+:** `gbrain serve --http` ships full OAuth 2.1 (client credentials,
> auth code + PKCE, refresh rotation, optional DCR), an embedded React admin
> dashboard at `/admin`, scoped operations, and a live SSE activity feed.
> Pre-v0.26 legacy bearer tokens still work — `verifyAccessToken` falls back
> to the `access_tokens` table and grandfathers tokens to `read+write+admin`.
> The HTTP/auth/logging path is engine-aware on current releases: OAuth tables,
> legacy bearer tokens, and MCP request logs work through the active
> `BrainEngine` on both PGLite and Postgres. Use Postgres or Supabase for
> shared, large, multi-machine, or always-on production deployments; keep PGLite
> for local/default and small self-hosted cases. See
> [SECURITY.md](../../SECURITY.md) for env vars and tunable defaults.

Access your brain from any device, any AI client. GBrain ships two transports:
`gbrain serve` (stdio) for local agents, and `gbrain serve --http` (v0.26.0+)
for remote clients over OAuth 2.1.

This page is the protocol reference for remote MCP. Client-specific pages should
link here instead of repeating auth, scope, engine, or `localOnly` rules.

## Three Paths

### Local stdio (zero setup)

```bash
gbrain serve
```

Works with Claude Code, Cursor, Windsurf, and any MCP client that supports stdio.
No server, no tunnel, no token needed. Works on both PGLite and Postgres engines.

### Remote over OAuth 2.1 (recommended, v0.26.0+)

Run the server and tunnel as two separate long-lived processes. In terminal 1:

```bash
# Keep the service on loopback; ngrok terminates TLS and forwards locally.
gbrain serve --http --port 3131 \
  --public-url https://your-brain.ngrok.app
```

After the server is listening, run the tunnel in terminal 2:

```bash
ngrok http 3131 --url your-brain.ngrok.app
```

Built-in HTTP transport with OAuth 2.1, scoped operations, an admin dashboard
at `/admin`, and a live SSE activity feed. Zero external dependencies. This is
the only path that works with ChatGPT (OAuth 2.1 + PKCE is required by the
ChatGPT MCP connector). Pass `--public-url` whenever the server is reachable
at anything other than `http://localhost:<port>` so the OAuth issuer in
discovery metadata matches what clients hit (RFC 8414 §3.3).
For an always-on deployment, supervise both processes and restart them
independently; do not place the two foreground commands sequentially in one
shell script.

Supported clients:
- **ChatGPT**: requires OAuth 2.1 + PKCE. Works natively with `--http`.
- **Claude Desktop**: add the remote connector through Settings >
  Integrations. The current client guide documents bearer-token setup.
- **Cowork**: use the remote MCP settings exposed by the client; bearer-token
  setup is documented in the client guide.
- **Perplexity**: OAuth 2.1 client credentials grant.
- **Claude Code, Codex, Cursor, Windsurf, and other coding agents**: use the
  matching client page. The GBrain server supports OAuth and legacy bearer
  tokens, but each client has its own supported connector/auth shape.

See the OAuth 2.1 setup section below.

### Remote with legacy bearer tokens (compatibility path)

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app)
  → gbrain serve --http  (built-in transport with bearer auth)
  → active BrainEngine (PGLite or Postgres)
```

This requires:
1. A machine running `gbrain serve --http`.
2. A public tunnel, private mesh, or cloud host when the client is not local.
3. A bearer token created via `gbrain auth create <name>`.

Pre-v1.0 tokens are grandfathered as `read+write+admin` scopes when you upgrade
to the HTTP server, so no migration is required. Treat this as a compatibility
path for existing local or trusted clients. For cloud connectors, team brains,
and least-privilege deployments, register OAuth clients instead.

## OAuth 2.1 Setup (v0.26.0+)

### 1. Start the HTTP server

```bash
gbrain serve --http --port 3131 \
  --public-url https://your-brain.ngrok.app
```

On first start in an interactive terminal, the server prints an **admin
bootstrap token** to stderr:

```
Admin bootstrap token: 3a1f9c...
Open http://localhost:3131/admin and paste it to log in.
```

On a non-TTY start (systemd, Docker, any piped or captured logs) the generated
token is hidden so it never lands in log storage. For headless deploys either
set `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` to a value you control before starting, or
run `gbrain serve --http --print-admin-token` once on a trusted terminal to
force printing.

Save this token. Open `http://localhost:3131/admin` and paste it to access the
dashboard. The dashboard shows live activity, registered clients, request logs,
and per-client config export.

For local-only OAuth testing, omit `--public-url` and use
`http://localhost:3131` as the issuer. For any public tunnel, reverse proxy, or
cloud MCP client, set `--public-url` to the exact external URL before
registering clients.

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

Register `authorization_code` clients only when an authenticated consent policy
is enforced around `/authorize`. The built-in route currently issues codes
without authenticating an operator or presenting a consent decision; manual
pre-registration of a public PKCE client does not fix that boundary. See
[`../../SECURITY.md`](../../SECURITY.md).

Or from the CLI — faster for scripting:

```bash
gbrain auth register-client perplexity \
  --grant-types client_credentials \
  --scopes "read write"
```

**v0.34 — source-scoped clients.** Multi-source brains can scope a client's
write authority to one source and its read scope to a curated set with the
new `--source` and `--federated-read` flags:

```bash
gbrain auth register-client dept-x-agent \
  --grant-types client_credentials \
  --scopes "read write" \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

`--source` controls the write authority — `put_page` / `add_link` / etc only
land in `dept-x`. `--federated-read` controls the read axis independently;
queries return rows from any of the listed sources. Omit both flags for the
v0.33-compatible super-client shape. Pre-v0.34 clients are backfilled to
`source_id='default'` on `gbrain upgrade`.

Host-repo wrappers can register programmatically:

```ts
await oauthProvider.registerClientManual(
  'perplexity',
  ['client_credentials'],
  'read write',
  [],  // redirect_uris, empty for CC
);
```

Dynamic Client Registration (RFC 7591) is off by default. Do not enable it on a
public stock server. `--enable-dcr` permits unauthenticated registration, and
the current `/authorize` route has no authenticated consent gate.
`--enable-dcr-insecure` additionally permits `client_credentials`. Use either
flag only behind a deliberate authenticated registration and consent policy.

### 3. Expose the server

**v0.34 — bind explicitly.** `gbrain serve --http` defaults to `127.0.0.1`.
To accept connections from a reverse proxy, mesh, LAN, or tunnel process that is
not on the same host, restart with `--bind`:

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url https://your-brain.ngrok.app
```

When `--public-url` is set without `--bind`, a stderr WARN fires at startup
because public deployments usually need an explicit network boundary. A
same-machine tunnel can still use loopback; if the tunnel cannot reach the
server, use the bound form above.

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 3131 --url your-brain.ngrok.app
```

Your OAuth issuer URL becomes `https://your-brain.ngrok.app`. The MCP SDK's
router exposes the spec-compliant discovery endpoint at
`/.well-known/oauth-authorization-server`.

### 4. Scopes and localOnly

Every HTTP tool call is checked against two gates before the handler runs:

1. Scope. Operations declare a required OAuth scope. `write` implies `read`;
   `admin` implies `read`, `write`, `sources_admin`, and `users_admin`.
   The `agent` scope is separate and is not implied by `admin`.
2. Local-only filtering. The HTTP server exposes only operations whose
   `localOnly` flag is false. Local filesystem and host-control surfaces are
   rejected over HTTP regardless of scope.

Current local-only examples include `sync_brain`, `file_upload`, `file_list`,
and `file_url`. Remote agents cannot reach those local filesystem or host-sync
surfaces through MCP.

| Scope | What it allows |
|-------|---------------|
| `read` | `search`, `query`, `get_page`, `list_pages`, graph traversal |
| `write` | `put_page`, `delete_page`, `add_link`, `add_timeline_entry` |
| `sources_admin` | Source-management operations without broad `admin` |
| `users_admin` | User-account administration when enabled |
| `admin` | Client management, token revocation, remote doctor/status, source/user admin, read/write |
| `agent` | Remote agent job submission; not implied by `admin` |

`admin` is powerful, but it still does not override `localOnly`.

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

The remote tool list is generated from the current operation registry after
filtering out `localOnly` operations. Do not rely on a hard-coded operation
count. In practice, normal read/write brain operations are remote-callable when
the client has the right scope, while host-local operations such as sync and
file upload stay local-only.

Useful remote identity and diagnostic operations:

- `get_brain_identity` is `read` scope and returns `{version, engine,
  page_count, chunk_count, last_sync_iso, update_available, latest_version}` for
  thin-client banners and smoke tests.
- `get_health` is `admin` scope and exposes the host health dashboard data.
- `run_doctor` is `admin` scope and returns the remote/thin-client structured
  doctor report. Thin-client `gbrain doctor` and `gbrain remote doctor` use
  this class of checks instead of opening a local empty PGLite brain.

Protected job names and protected onboard handlers have extra gates beyond
plain `admin`; if MCP returns a protected-job or missing-scope error, do not
retry through another route unless the operator intentionally switches to a
trusted local CLI flow.

## Deployment Options

See [ALTERNATIVES.md](ALTERNATIVES.md) for a comparison of ngrok, Tailscale
Funnel, and cloud hosts (Fly.io, Railway).

## Troubleshooting

**"missing_auth" error**
Include the Authorization header: `Authorization: Bearer YOUR_TOKEN`

**"invalid_token" error**
Run `gbrain auth list` to see active tokens.

**"service_unavailable" error**
Database or engine liveness failed. Check the host's database, pooler, and
`/health` output. On Supabase/Postgres, also check the dashboard and pooler
mode.

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
