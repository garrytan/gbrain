# Deploy GBrain Remote MCP Server

> `gbrain serve --http` ships full OAuth 2.1 (client credentials, auth code +
> PKCE, refresh rotation, optional DCR), an embedded React admin dashboard at
> `/admin`, scoped operations, and a live SSE activity feed. Legacy bearer
> tokens still work — `verifyAccessToken` falls back to the `access_tokens`
> table; tokens with no `scopes` grant are grandfathered to `read+write+admin`,
> while tokens minted with `gbrain auth create --scopes …` (or by
> `gbrain bootstrap harness`) are honored at exactly their granted scopes.
> Both the legacy fallback and the OAuth tables work on PGLite and Postgres
> (both engine schemas carry `access_tokens`). See [SECURITY.md](../../SECURITY.md) for env vars and
> tunable defaults.

Access your brain from any device, any AI client. GBrain ships two transports:
`gbrain serve` (stdio) for local agents, and `gbrain serve --http` for remote
clients over OAuth 2.1.

## Three Paths

### Local stdio (zero setup)

```bash
gbrain serve                  # full operation catalog (default)
gbrain serve --surface verbs  # just the 7 memory verbs (quickstart surface)
```

Works with Claude Code, Cursor, Windsurf, and any MCP client that supports stdio.
No server, no tunnel, no token needed. Works on both PGLite and Postgres engines.
`--surface verbs` exposes exactly the seven-verb memory protocol (`recall`,
`remember`, `entity`, `synthesize`, `forget`, `context_pack`, `delta` —
[MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)) instead of the full catalog;
`--surface starter` sits between (~27 ops: the verbs plus the daily-driver set);
omit the flag (default `full`) for every operation.

### Remote over OAuth 2.1 (recommended)

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

See the [OAuth 2.1 setup](#oauth-21-setup) section below.

### Remote with legacy bearer tokens (simplest)

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app)
  → gbrain serve --http  (built-in transport with bearer auth)
  → Postgres or PGLite
```

This requires:
1. A machine running `gbrain serve --http` (works on both PGLite and Postgres
   brains)
2. A public tunnel (ngrok, Tailscale, or cloud host)
3. A bearer token created via `gbrain auth create <name>`

Existing bearer tokens (no `scopes` grant) are grandfathered as
`read+write+admin` on the OAuth-capable HTTP server, so no migration is
required; `gbrain auth create --scopes read,write` mints narrowed tokens.

## OAuth 2.1 Setup

### 1. Start the HTTP server

```bash
gbrain serve --http --port 3131
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

> `mcp_request_log.params` and the live SSE activity feed default to a redacted
> summary `{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`.
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

**Source-scoped clients.** Multi-source brains can scope a client's write
authority to one source and its read scope to a curated set with the
`--source` and `--federated-read` flags:

```bash
gbrain auth register-client dept-x-agent \
  --grant-types client_credentials \
  --scopes "read write" \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

`--source` controls the write authority — `put_page` / `add_link` / etc only
land in `dept-x`. `--federated-read` controls the read axis independently;
queries return rows from any of the listed sources. Omit both flags for an
unscoped super-client. Clients registered before source scoping existed are
backfilled to `source_id='default'` on `gbrain upgrade`. Within a source,
slug-level write fencing is also available: `--bound-slug-prefixes p1/,p2/`
rejects slug-mutating writes outside the listed prefixes (update later with
`gbrain auth rescope-client <id> --bound-slug-prefixes <p1,p2|none>`).

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

DCR requests may include an optional `token_ttl_seconds` field (integer,
seconds) to request a per-client access-token lifetime. The server clamps the
request into an admin-configured window — never rejects over it — persists the
effective value as the client's TTL override, and echoes it back as
`token_ttl_seconds` in the registration response. Subsequent `/token` responses
for that client carry the matching `expires_in`. Clients that omit the field
keep the server default (`--token-ttl`). The window defaults fail-closed: min
300 seconds, max bounded by your `--token-ttl` — a self-registering client
cannot request a longer-lived token than the server default unless you
explicitly widen the window:

```bash
gbrain config set oauth.dcr_ttl_min_seconds 600
gbrain config set oauth.dcr_ttl_max_seconds 86400
```

### 3. Expose the server

**Bind explicitly.** `gbrain serve --http` defaults to `127.0.0.1`.
To accept connections from the ngrok tunnel (or any non-loopback source),
restart with `--bind`:

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url https://your-brain.ngrok.app
```

When `--public-url` is set without `--bind`, a stderr WARN fires at
startup so the misconfiguration ("the tunnel is up but my agent gets
ECONNREFUSED") is loud.

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 3131 --url your-brain.ngrok.app
```

Your OAuth issuer URL becomes `https://your-brain.ngrok.app`. The MCP SDK's
router exposes the spec-compliant discovery endpoint at
`/.well-known/oauth-authorization-server`.

### 4. Scopes and localOnly

Every operation is tagged `read | write | admin`. Operations flagged
`localOnly: true` in `src/core/operations.ts` (10 today — `sync_brain` and
the `file_*` ops among them) are rejected over HTTP regardless of scope.
Remote agents cannot reach local filesystem surface area.

| Scope | What it allows |
|-------|---------------|
| `read` | `search`, `query`, `get_page`, `list_pages`, graph traversal |
| `write` | `put_page`, `delete_page`, `add_link`, `add_timeline_entry` |
| `admin` | Client management, token revocation, sweep, local-only ops |

Write ops can additionally be fenced per client with `--bound-slug-prefixes`
(see [Register OAuth clients](#2-register-oauth-clients) above).

## Legacy Bearer Token Setup

Bearer tokens are the simple path when you don't need per-client scoping.
Without a `--scopes` grant they grandfather to `read+write+admin` on the
HTTP server; pass `--scopes read,write` at creation to narrow one.

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

Tokens are per-client. Create one for each device/app. Names are not
unique: `gbrain auth revoke "<name>"` revokes EVERY active token carrying
that name — use `gbrain auth list` (shows each token's id and scopes) and
`gbrain auth revoke --id <uuid>` to revoke exactly one. Tokens are stored
SHA-256 hashed in your database.

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

GBrain's full operation catalog (100+ operations in `src/core/operations.ts`)
is available remotely, with no timeout limits on a self-hosted server. The
only exceptions are the operations flagged `localOnly: true` — `sync_brain`
and the `file_*` ops among them — which are rejected over HTTP regardless of
scope (see [Scopes and localOnly](#4-scopes-and-localonly) above).

**Security note on file access:** the `file_*` operations being localOnly is
the first line of defense; as defense-in-depth, `file_upload` also confines
any caller that isn't verifiably the trusted local CLI to the working
directory where `gbrain serve` was launched. Symlinks, `..` traversal, and
absolute paths outside cwd are rejected, and page slugs and filenames are
allowlist-validated (alphanumeric + hyphens; no control chars, RTL overrides,
or backslashes). Local CLI callers (`gbrain files upload ...`) keep
unrestricted filesystem access since the user owns the machine.

## Deployment Options

See [ALTERNATIVES.md](ALTERNATIVES.md) for a comparison of ngrok, Tailscale
Funnel, and cloud hosts (Fly.io, Railway).

### Co-located Docker workloads (self-hosted Postgres)

OAuth scopes and source scoping guard the `gbrain serve --http` path. They do
NOT guard raw Postgres. If the brain's Postgres runs as a container on the same
Docker host as other workloads (agent runtimes, n8n, staging fixtures), any
container sharing Docker's default `bridge` network can open a direct DB
session — no OAuth token required — and read every source. That silently
recreates a privileged path underneath the isolation you configured at the MCP
layer.

Network-zone the host so untrusted containers can never reach Postgres:

```
Docker host
├── gbrain-net          ← ONLY the brain's Postgres (+ gbrain serve, if containerized)
├── agent-<id>-net      ← each untrusted agent runtime, isolated
└── default bridge      ← no secret-bearing databases
```

Operator checklist:

```text
[ ] Postgres is on a user-defined Docker network, not the default bridge
    (or nothing else runs on that bridge)
[ ] If Postgres publishes a host port at all, it binds loopback only
    (`-p 127.0.0.1:5432:5432`, never `0.0.0.0`)
[ ] Untrusted agent containers have no DATABASE_URL or Postgres password
[ ] Untrusted agents reach the brain via OAuth/Bearer against serve --http only
    (host loopback via host.docker.internal / host gateway — never gbrain-net)
[ ] OAuth clients are least-privilege: scoped --source / --federated-read,
    pre-minted short-lived tokens preferred over long-lived client secrets
[ ] Isolation verified: a team-scoped client cannot read internal-only sources
```

Optional defense-in-depth: a dedicated Postgres role (or RLS) limited to the
allowed `source_id`s, so even a leaked connection string can't read everything.

### Run gbrain under a real init (tini / `--init`)

If `gbrain serve` is your container's entrypoint, it runs as PID 1 and
inherits every orphaned process in the container. Prefer a real init so
orphan exits are reaped by something built for the job:

```dockerfile
# Dockerfile: wrap the entrypoint with tini
ENTRYPOINT ["/usr/bin/tini", "--", "gbrain", "serve", "--http"]
```

or at run time:

```bash
docker run --init ... gbrain serve --http
```

Without an init, gbrain installs its own PID-1 orphan reaper (Linux only):
a low-frequency `/proc` scan that `waitpid()`s zombies re-parented to it,
so long-lived containers don't accumulate defunct entries in the PID table.
It is fail-open and can be disabled with `GBRAIN_PID1_REAP=0` — but tini /
`--init` remains the recommended setup.

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

**Note:** `gbrain serve --http` has OAuth 2.1 + the admin dashboard baked
into the binary. The custom HTTP wrapper pattern (see
[voice recipe](../../recipes/twilio-voice-brain.md)) is still supported for
teams that need bespoke middleware, but for most remote deployments the
built-in server is the recommended path.
