# Deploy GBrain Remote MCP Server

> `gbrain serve --http` ships full OAuth 2.1 (client credentials, auth code +
> PKCE, refresh rotation, optional DCR), an embedded React admin dashboard at
> `/admin`, scoped operations, and a live SSE activity feed. Legacy bearer
> tokens also work: `verifyAccessToken` falls back to the `access_tokens`
> table; tokens with no `scopes` grant carry `read+write+admin`,
> while tokens minted with `gbrain auth create --scopes …` (or by
> `gbrain bootstrap harness`) are honored at exactly their granted scopes.
> Both the legacy fallback and the OAuth tables work on PGLite and Postgres
> (both engine schemas carry `access_tokens`). See [SECURITY.md](../../SECURITY.md) for env vars and
> tunable defaults.

Access your brain from any device, any AI client. GBrain ships two transports:
`gbrain serve` (stdio) for local agents, and `gbrain serve --http` for remote
clients over OAuth 2.1. The recommended way to publish `serve --http` from your
own computer is `gbrain mcp expose`, which puts it on your Tailscale tailnet
with HTTPS and keeps it running as a user service — see
[Use your brain from anywhere over MCP](../guides/remote-mcp.md).

**Say to your agent:** *"use my brain over mcp"* — *"put my brain on
tailscale"* — the `remote-mcp` skill runs `gbrain mcp expose` for you after
you confirm the printed plan.

For **owner login, client registration, setup instructions, permission edits,
token invalidation, revocation, or deletion**, start with
[MCP administration](ADMIN.md). For the connecting harness, use
[hosted setup](../guides/hosted-harness-access.md). The owner bootstrap credential
is separate from OAuth `admin` scope; only the former authenticates the owner
dashboard and client-management API.

Authorization-code connections require owner approval in the admin dashboard.
Existing sessions are preserved. Before upgrading an installation with queued
work, follow the [authorization and worker upgrade guide](../guides/authorization-upgrade.md)
for the coordinated cutover, consent recovery, and Bun requirements.

**The owner-approval step.** `/authorize` never returns an authorization code
on its own. It records a pending request and redirects the browser to the admin
dashboard (`/admin/?oauth_request=…`), where the brain owner signs in (bootstrap
token or magic link), reviews the client name, redirect URI and requested
scopes, and approves or denies. Only an approval mints the code, which is then
delivered to the client's registered redirect URI; a denial returns
`error=access_denied`. This applies to every authorization-code client,
including clients that self-registered via DCR — self-registration alone never
yields a token. Pending requests expire after ten minutes, do not survive a
server restart, and are bounded: at most ten awaiting-decision requests per
client and a fixed server-wide ceiling. Beyond either, `/authorize` sends the
client back to its registered redirect URI with `error=too_many_requests`
(and no code) until earlier requests are decided or expire; a `429` status on
`/authorize` comes only from the MCP SDK's per-IP rate limit.

**Say to the server-hosting harness:** *"Expose my existing brain over HTTPS,
configure a protected owner credential, and help connect my native OAuth client.
Use manual registration unless I request self-service registration. Preserve
the OAuth request when issuing my owner login link."*

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

### Tailscale (recommended): `gbrain mcp expose`

```bash
gbrain mcp expose            # tailnet-only HTTPS: your own devices
gbrain mcp expose --funnel   # public HTTPS on the same name: cloud agents (Grok Bot, Muse, ChatGPT, …)
gbrain mcp expose --status   # re-probe the receipt, service and health
```

One command on the brain host: installs Tailscale if needed (after a consent
prompt), signs in, publishes `gbrain serve --http` on your MagicDNS name with
Tailscale-terminated TLS, provisions the admin bootstrap token in a private
file, installs a launchd / systemd user service so the server survives
reboots, and prints the MCP URL
(`https://your-machine.your-tailnet.ts.net/mcp`) plus separate owner-login, native OAuth, and machine-client next steps. Engine-free — it works while a PGLite brain's `serve` holds the
write lock. Default reach is your tailnet only; `--funnel` is the explicit
opt-in for agents that run in a vendor's cloud. Steps, flags, `--remove`,
and the troubleshooting table: [remote MCP guide](../guides/remote-mcp.md).

```
Your AI client
  → https://your-machine.your-tailnet.ts.net/mcp   (Tailscale terminates TLS)
  → gbrain serve --http on 127.0.0.1:3131           (user service)
  → Postgres or PGLite
```

Then choose the intended client's connection method. Native OAuth/PKCE uses
[owner registration](ADMIN.md#native-oauth-with-pkce). For a private machine
handoff, provision through the running server (the only way on PGLite while
`serve` is live):

```bash
gbrain mcp grant agent-example --harness codex --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/agent-example.json
```

### Other tunnels and cloud hosts

Any HTTPS front works: ngrok, Cloudflare Tunnel, or a cloud host (Fly.io,
Railway) for a brain that must answer while your laptop is closed —
[ALTERNATIVES.md](ALTERNATIVES.md) compares them. You run `gbrain serve --http`
yourself and pass `--public-url` whenever the server is reachable at anything
other than `http://localhost:<port>` so the OAuth issuer in discovery metadata
matches what clients hit (RFC 8414 §3.3).

#### Remote over OAuth 2.1

```bash
ngrok http 3131 --url your-brain.ngrok.app
```

Keep the tunnel running in its own terminal, then start the brain server once:

```bash
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
```

Built-in HTTP transport with OAuth 2.1, scoped operations, an admin dashboard
at `/admin`, and a live SSE activity feed. Zero external dependencies. This is
the only auth shape that works with ChatGPT (OAuth 2.1 + PKCE is required by
the ChatGPT MCP connector).

Supported clients:
- **ChatGPT** — requires OAuth 2.1 + PKCE. Works natively with `--http`.
- **Claude Desktop / Cowork** — OAuth 2.1 or legacy bearer tokens.
- **Perplexity** — OAuth 2.1 client credentials grant.
- **Claude Code, Cursor, Windsurf** — can use OAuth or legacy bearer.

See the [OAuth 2.1 setup](#oauth-21-setup) section below.

#### Remote with legacy bearer tokens (simplest)

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → HTTPS front (Tailscale name, ngrok domain, or cloud host)
  → gbrain serve --http  (MCP bearer access; separate owner administration)
  → Postgres or PGLite
```

This requires:
1. A machine running `gbrain serve --http` (works on both PGLite and Postgres
   brains)
2. An HTTPS front (Tailscale via `gbrain mcp expose`, ngrok, or a cloud host)
3. A bearer token created via `gbrain auth create <name>`

Bearer tokens created without a `scopes` grant carry `read+write+admin` on
the HTTP server; `gbrain auth create --scopes read,write` mints narrowed
tokens.

## OAuth 2.1 Setup

### 1. Start the HTTP server

If `gbrain mcp expose` already started the service, keep using it and its
configured MCP URL. Continue to owner login or client registration; do not
start another server or repeat the publishing step.

For a manually managed server, choose the HTTPS front and `--public-url` from
[step 3](#3-expose-the-server) before starting it. This local-only example
starts one foreground process:

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
token is hidden so it never lands in log storage. For headless deploys,
set `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` through the service's protected environment
before starting. `--print-admin-token` can force printing at that process's
startup on a trusted terminal; starting a separate process with this flag does
not recover the existing server's token. If the existing process's generated
credential was lost, restart that service through the normal maintenance path
with a configured credential. See [owner credential recovery](ADMIN.md#set-up-or-recover-the-owner-credential).

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

### Owner login links for AI agents

**Say to the server-hosting or authorized administrator harness:** *"Give me
the GBrain admin login link"*. The recommended command wraps the existing HTTP
mint endpoint:

```bash
gbrain mcp admin login-link --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --json
```

During OAuth connection, add `--oauth-request REQUEST_ID` from the pending
browser URL. This preserves consent when the owner opens the login link in a
fresh tab or browser. Expired/restarted requests require a new connection from
the native client; its PKCE verifier stays in that client. Full commands and
recovery instructions: [MCP administration](ADMIN.md).

When an authenticated owner asks **"Give me the GBrain admin login link"**,
use the existing single-use login flow. A static `/admin/` URL opens the login
page; it does not authenticate the owner.

1. Use the requesting owner's authorization and a private destination for the login link.
2. Obtain the running server's bootstrap credential through the host's existing
   protected credential mechanism. `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` is the supported
   deployment setting. Never expose its value in chat, logs, shell arguments,
   or a URL. If the credential is unavailable, report that specific setup blocker;
   do not claim the login-link capability is missing.
3. Send `POST /admin/api/issue-magic-link` to the running server, with the
   bootstrap credential in the `Authorization: Bearer` header through that
   protected mechanism. An MCP client bearer token or client secret is not the
   server bootstrap credential.
4. The response contains `url` and `expires_in` (300 seconds). The returned URL
   uses the server's configured `--public-url`; without it, the fallback is
   localhost. Ensure the deployment has an owner-reachable public URL rather
   than substituting a remembered tunnel address.
5. Deliver the returned short-lived login link only to the requesting owner in
   private. In a shared channel, acknowledge private delivery without reproducing
   the link. Never put it into a public issue or commit.

**Do not GET or fetch the generated login URL to verify it.** That redeems the
single-use nonce before the owner can use it. Check the base `/admin/` page and
non-secret response metadata separately. The link expires after five minutes,
cannot be replayed, and is invalidated by a server restart. Successful redemption
establishes the admin browser session and redirects to `/admin/`.

This logs the owner into the dashboard; it does not create, reveal, or rotate an
MCP client credential. Register the intended OAuth client separately on the
[Agents page](#2-register-oauth-clients), then use its setup instructions and
explicit private download when needed. For unattended deployments, provision the
bootstrap credential through the operator's protected configuration before
starting the server; generated secrets are deliberately hidden in captured logs.

### 2. Register OAuth clients

Register from the **`/admin` dashboard's Agents page**. Choose machine
credentials, public PKCE (`none`), or confidential PKCE (POST/Basic) according
to the intended harness. Native OAuth requires its actual redirect URI. Review
permissions and connection metadata before registration, then use the setup
instructions for that client. Public clients have no secret; confidential
delivery is explicit and recoverable from the protected host journal while
the live secret still matches.

For a running server, use the owner HTTP CLI:

```bash
gbrain mcp admin register agent-example \
  --redirect-uri https://client.example.com/oauth/callback \
  --token-endpoint-auth-method none --scopes read,write --source default \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --dry-run --json
```

Review and repeat without `--dry-run`. Machine credentials use `gbrain mcp
grant … --credentials-out PRIVATE_FILE` instead. See [registration and
setup](ADMIN.md#register-and-connect-a-client) for both flows. The legacy
`gbrain auth register-client` command remains a local database-maintenance path;
do not open an already running PGLite brain through it.

**Source-scoped clients.** Multi-source brains can scope a client's write
authority to one source and its read scope to a curated set with the
`--source` and `--federated-read` flags:

```bash
gbrain mcp grant dept-x-agent --harness generic --profile memory-writer \
  --source dept-x --federated-read dept-x,shared,parent-canon \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token \
  --credentials-out /absolute/private/dept-x-agent.json --json
```

`--source` controls the write authority — `put_page` / `add_link` / etc only
land in `dept-x`. `--federated-read` controls the read axis independently;
queries return rows from any of the listed sources. New registrations that omit
both flags use source `default`; omission does not create an unscoped
super-client. A client with no recorded source is backfilled to
`source_id='default'` on `gbrain upgrade`. Within a source,
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

### Dynamic client registration (DCR)

For self-service client registration (Dynamic Client Registration, RFC 7591),
start the server with `--enable-dcr`. DCR is off by default.

**Say to your agent:** *"Start my brain's MCP server with self-service client
registration — your agent runs `gbrain serve --http --enable-dcr`, and you
approve each new connection in the admin UI."*

A self-registered client goes through three gates:

1. **Scope ceiling at registration.** Dynamic registration may request at most
   `read write`. A request naming `admin`, `sources_admin`, `users_admin`, or
   `agent` is rejected with HTTP 400 `invalid_client_metadata` (never silently
   narrowed), and the error text points at the operator path. Under
   `--enable-dcr-insecure`, a `client_credentials` registration is capped at
   `read` — a grant that skips owner approval never carries `write`. While
   DCR is enabled (either mode), OAuth discovery advertises the `read write`
   self-registration ceiling as `scopes_supported` (authorization-server and
   protected-resource metadata alike), so a client that registers with the
   advertised scopes succeeds;
   with DCR off, discovery lists every scope an operator-registered client
   may hold. `agent` is never advertised — it needs delegation bindings no
   OAuth request can carry.
2. **Owner approval on `/authorize`.** Every authorization-code connection
   redirects to the admin dashboard, where you see the client, its redirect
   URI, and the requested scopes, and approve or deny. No code is minted
   until you approve. Consent never widens the registered scope.
3. **Per-request clamp.** Issued codes and tokens are re-intersected with the
   client's current registered scope, so a later `rescope-client` takes effect
   on the next request.

To give a self-registered client more than `read write`, use the
[owner permission-edit path](ADMIN.md#inspect-clients-and-edit-access)
(or the admin dashboard's Agents page), then reconnect for fresh authorization.
Alternatively, pre-register through `gbrain mcp admin register` with the intended
scopes. The legacy `gbrain auth rescope-client` / `register-client` commands are
local database-maintenance paths; do not open a live PGLite database through them.
`gbrain doctor` warns about active clients that hold a privileged scope but
look self-registered.

Native MCP clients register cleanly: `redirect_uris` may use an app custom
scheme (RFC 8252, e.g. `myapp://callback`) or `http://` loopback alongside
`https://`; scopes the server doesn't know are filtered rather than fatal;
and malformed registration metadata is rejected with HTTP 400
`invalid_client_metadata` (never a 500), so a client can correct and retry.

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

**Tailscale (recommended).** `gbrain mcp expose` does this whole section for
you — Tailscale install/login, `tailscale serve` (or `funnel`), the admin
token file, a user service, and the health checks — and keeps the server on
its default loopback bind, because Tailscale terminates TLS on the tailnet
and forwards to `127.0.0.1`. The manual equivalent is the
[Tailnet / LAN-only](#tailnet--lan-only-no-public-tunnel) shape below. Full
walkthrough: [remote MCP guide](../guides/remote-mcp.md).

Choose this managed-service path before starting a manual server. If a server
already answers at the intended HTTPS endpoint, use that deployment. Publishing
an independently managed server with `--no-service` requires that server's own
configured owner credential; an expose-created file does not change it.

**ngrok (alternative).** ngrok also connects to loopback on the same
machine, so the default bind is right there too:

```bash
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
```

**Bind explicitly only when the front is on another host.** `gbrain serve
--http` defaults to `127.0.0.1`. To accept connections from a reverse proxy
or tunnel agent running on a different machine (or a container), restart with
`--bind`:

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url https://brain.example.com
```

When `--public-url` is set without `--bind`, a stderr WARN fires at
startup so a real misconfiguration ("the tunnel is up but my agent gets
ECONNREFUSED") is loud; in the Tailscale and same-machine-ngrok shapes the
WARN is expected and harmless. Binding `0.0.0.0` without
`GBRAIN_HTTP_CORS_ORIGIN` warns too: browser-based clients get no CORS header
until you set the allowlist (see [SECURITY.md — CORS](../../SECURITY.md#cors)).

`--source-guard` is a stdio-lane flag: with `--http` it prints a warning and
is ignored. HTTP writes are fenced by each token's scopes instead, so
operators migrating from stdio mint narrowed tokens
(`gbrain auth create <name> --scopes read`) rather than relying on the guard.

For the ngrok alternative, start the tunnel after the server:

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 3131 --url your-brain.ngrok.app
```

Your OAuth issuer URL is whatever `--public-url` names
(`https://your-machine.your-tailnet.ts.net` under Tailscale,
`https://your-brain.ngrok.app` under ngrok). The MCP SDK's
router exposes the spec-compliant discovery endpoint at
`/.well-known/oauth-authorization-server`. The protected resource is the
`/mcp` endpoint itself: its RFC 9728 metadata is served at
`/.well-known/oauth-protected-resource/mcp` (the bare
`/.well-known/oauth-protected-resource` root stays as an alias for older
clients), and every 401 carries `WWW-Authenticate: Bearer
resource_metadata="<that URL>"`, so an MCP client pointed at
`https://your-machine.your-tailnet.ts.net/mcp` finds the token endpoint from a
fresh connection without any pasted URLs.

**Dual-mode auth on `/mcp`.** The same route verifies OAuth 2.1 access
tokens and `gbrain auth create` bearers (OAuth first, then the
`access_tokens` fallback). The 401 + `resource_metadata` challenge is emitted
by the MCP SDK middleware for ANY request lacking an `Authorization` header
(RFC 9728 / MCP auth spec §5.1 discovery) and says nothing about whether a
configured token works. A client status probe that omits the header will
therefore report `needsAuth` / `authentication_required` even while the
configured bearer succeeds. Judge auth from `whoami`
(`transport: legacy|oauth`) or `gbrain auth test <url> --token <t>`; treat a
client's needsAuth flag as advisory unless the authenticated call itself
returns 401 / `invalid_token`.

#### Tailnet / LAN-only (no public tunnel)

Two shapes work without exposing anything to the internet. In both, clients
authenticate with `gbrain auth create` bearer tokens.

**Tailscale Serve (HTTPS, tailnet-only).** This is what `gbrain mcp expose`
automates (plus the admin token file, the user service and the health
checks). By hand: keep the default `127.0.0.1` bind, let Tailscale terminate
TLS on the tailnet, and point `--public-url` at your MagicDNS name:

```bash
gbrain serve --http --port 3131 --public-url https://your-machine.your-tailnet.ts.net
tailscale serve --bg 3131
```

Clients on the tailnet use `https://your-machine.your-tailnet.ts.net/mcp`.
The "--public-url is set but --bind is not" WARN is expected in this shape —
Tailscale Serve forwards to loopback. `tailscale serve` stays inside your
tailnet; `tailscale funnel` (or `gbrain mcp expose --funnel`) is public
exposure for cloud agents (see [ALTERNATIVES.md](ALTERNATIVES.md)).

**Plain HTTP, bearer-only.** Bind the tailnet/LAN interface and omit
`--public-url` entirely:

```bash
gbrain serve --http --port 3131 --bind 100.x.y.z   # or --bind 0.0.0.0
```

The OAuth issuer defaults to `http://localhost:3131`, which the MCP SDK
accepts, and bearer-token verification never reads the issuer. Clients connect
to `http://100.x.y.z:3131/mcp` with `Authorization: Bearer …`. OAuth discovery
is the one thing this shape does not offer (the advertised issuer is
loopback), so OAuth-only clients such as ChatGPT need the HTTPS shape above.
Passing `--public-url http://100.x.y.z:3131` instead fails at startup — see
[Troubleshooting](#troubleshooting).

### 4. Scopes and localOnly

Every operation is tagged `read | write | admin`. Operations flagged
`localOnly: true` in `src/core/operations.ts` (`sync_brain` and the
`file_*` ops among them) are rejected over HTTP regardless of scope.
Remote agents cannot reach local filesystem surface area.

| Scope | What it allows |
|-------|---------------|
| `read` | `search`, `query`, `get_page`, `list_pages`, graph traversal |
| `write` | `put_page`, `delete_page`, `add_link`, `add_timeline_entry` |
| `admin` | Eligible admin-tagged brain operations; local-only restrictions still apply. Does not grant dashboard or client-management authority. |

Write ops can additionally be fenced per client with `--bound-slug-prefixes`
(see [Register OAuth clients](#2-register-oauth-clients) above).

## Legacy Bearer Token Setup

Bearer tokens are the simple path when you don't need per-client scoping.
Without a `--scopes` grant they carry `read+write+admin` on the
HTTP server; pass `--scopes read,write` at creation to narrow one.

### 1. Publish the server

Tailscale (recommended): `gbrain mcp expose` (add `--funnel` for cloud
clients) — [remote MCP guide](../guides/remote-mcp.md). ngrok alternative,
see the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md); quick version:

```bash
gbrain serve --http --port 8787
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787 --url your-brain.ngrok.app  # Hobby tier for fixed domain
```

### 2. Create access tokens

These commands open the database. On PGLite, mint the token before publishing
the service in step 1, or use the running server's owner API to provision a
scoped machine handoff. A second database process fails with `live_serve`;
do not remove its lock. Postgres supports concurrent local maintenance.

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
  https://your-machine.your-tailnet.ts.net/mcp \
  --token YOUR_TOKEN
```

(Substitute your ngrok domain or cloud host URL when you used one of those.)

## Operations

GBrain's operation catalog (100+ operations in `src/core/operations.ts`) is
available subject to the selected surface, scope and operation-specific limits.
Operations flagged `localOnly: true` are rejected over HTTP regardless of scope
(see [Scopes and localOnly](#4-scopes-and-localonly) above). Code-inspection
operations and stored contradiction reports also have temporary local-only
restrictions, even when listed in the catalog. The [MCP surface runbook](../operations/mcp-surface-runbook.md)
explains these limits and the separate chunk-rebuild requirement. Rebuild
indexes from a local installation on the brain host; a thin client cannot
rebuild the host's indexes.

**Several brains behind one tool catalog?** Give each server an identity so a
connected agent can tell them apart: `gbrain config set mcp.instructions
"<identity>"` rides the initialize response of every transport (stdio, OAuth
HTTP, legacy bearer) under a `Deployment identity:` banner, appended below the
canonical agent contract — no transport can weaken the contract. Restart
`gbrain serve` after setting it (the response is built once per process);
`GBRAIN_MCP_INSTRUCTIONS` in the serve process's environment overrides the
configured value for that process, and a blank variable falls back to it.
**Say to your agent:** *"Tell connected agents which brain this is"* — your
agent runs `gbrain config set mcp.instructions "<identity>"`.

**Security note on file access:** the `file_*` operations being localOnly is
the first line of defense; as defense-in-depth, `file_upload` also confines
any caller that isn't verifiably the trusted local CLI to the working
directory where `gbrain serve` was launched. Symlinks, `..` traversal, and
absolute paths outside cwd are rejected, and page slugs and filenames are
allowlist-validated (alphanumeric + hyphens; no control chars, RTL overrides,
or backslashes). Local CLI callers (`gbrain files upload ...`) keep
unrestricted filesystem access since the user owns the machine.

## Deployment Options

Tailscale via `gbrain mcp expose` is the recommended shape for a brain on your
own computer ([remote MCP guide](../guides/remote-mcp.md)). See
[ALTERNATIVES.md](ALTERNATIVES.md) for how Tailscale Serve / Funnel compare
with ngrok and always-on cloud hosts (Fly.io, Railway).

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

**Client status shows needsAuth / authentication_required but tool calls succeed**
The client probed `/mcp` without an `Authorization` header and read the
spec-mandated discovery 401 as a failed login. Both OAuth tokens and legacy
bearers are accepted on `/mcp`; confirm with `whoami` (`transport: legacy`)
or `gbrain auth test <url> --token <t>` and only re-authenticate if THAT
call returns 401. See
[Dual-mode auth on /mcp](#3-expose-the-server).

**"service_unavailable" error**
Database connection failed. Check your Supabase dashboard for outages.

**"Issuer URL must be HTTPS" at startup**
The MCP SDK rejects a non-HTTPS OAuth issuer unless the host is `localhost`
or `127.0.0.1`, so `--public-url http://<lan-or-tailnet-ip>:3131` exits
before the server listens. Either terminate TLS in front (Tailscale Serve,
ngrok, Cloudflare Tunnel) and pass the `https://` URL, or drop `--public-url`
for a bearer-only LAN endpoint — both shapes are in
[Tailnet / LAN-only](#tailnet--lan-only-no-public-tunnel). Last resort, for
plain-HTTP OAuth discovery on a private network you fully control: the SDK's
own `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=1` opt-in. Bearer auth works
either way; OAuth clients may still refuse a non-HTTPS issuer.

**Claude Desktop doesn't connect**
Remote servers must be added via Settings > Integrations, NOT
`claude_desktop_config.json`. See [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md).

**`gbrain mcp expose` stops on a Tailscale error or `verify.tailnet: pending`**
The pre-checks (`tailscale_https_not_enabled`, `tailscale_funnel_not_enabled`
— exit 2 with the admin-console URL, nothing published), the classified
errors (`https_not_enabled`, `funnel_not_enabled`, `needs_operator`,
`daemon_not_running`, …), the pending-certificate wait, and the
service/`--status` checks are tabled in the
[remote MCP guide](../guides/remote-mcp.md#troubleshooting).

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
[voice recipe](../../recipes/twilio-voice-brain.md)) is supported for
teams that need bespoke middleware, but for most remote deployments the
built-in server is the recommended path.
