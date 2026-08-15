# Security

## Reporting Vulnerabilities

If you discover a security issue in GBrain, please report it privately by opening
a [private security advisory](https://github.com/garrytan/gbrain/security/advisories/new)
on GitHub.

Do not open a public issue for security vulnerabilities.

## Automated security scanning

CI runs three automated security checks alongside secret scanning (Gitleaks):

- **Dependency vulnerabilities** — OSV-Scanner
  (`.github/workflows/osv-scanner.yml`) runs weekly and on any PR that touches
  `package.json` or `bun.lock`.
- **Static analysis (SAST)** — Semgrep CE (`.github/workflows/semgrep.yml`)
  runs on every PR and weekly. It is currently **advisory (non-blocking)**
  while the finding baseline is tuned; the graduation path to a blocking check
  is documented in the workflow file.
- **Release binary provenance** — release builds
  (`.github/workflows/release.yml`) attest each compiled binary with
  [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations).
  Verify a downloaded release binary with:

  ```bash
  gh attestation verify ./gbrain-darwin-arm64 -R garrytan/gbrain
  gh attestation verify ./gbrain-linux-x64 -R garrytan/gbrain
  ```

All security workflows use SHA-pinned actions and least-privilege permissions,
enforced structurally by actionlint on every workflow change.

## Remote MCP Security

### Keep dynamic client registration disabled unless explicitly needed

GBrain disables Dynamic Client Registration (DCR) by default. Keep that
default for internet-reachable deployments and pre-register trusted clients
with operator-approved scopes and source access. Enabling DCR lets network
callers create OAuth client records, so use it only when the deployment's
trust model requires self-service registration and browser approval remains
part of the authorization flow.

Do not enable `--enable-dcr-insecure` on an untrusted network. That option is
reserved for deployments that intentionally allow self-registered
machine-to-machine clients without browser approval.

### Recommended: `gbrain serve --http`

As of v0.22.7, GBrain ships a built-in HTTP transport that uses the
existing `access_tokens` table for authentication:

```bash
# Create a token
gbrain auth create "my-client"

# Start the HTTP server
gbrain serve --http --port 8787

# Connect via ngrok, Tailscale, or any tunnel
ngrok http 8787 --url your-brain.ngrok.app
```

This is the recommended way to expose GBrain remotely. No OAuth, no
registration endpoint, no self-service tokens. Tokens are managed
exclusively via `gbrain auth create/list/revoke`.

### If you must use a custom HTTP wrapper

1. **Require a secret for client registration** — check a header or body
   parameter before creating new OAuth clients
2. **Disable `client_credentials` grant** — only allow `authorization_code`
   with browser-based approval
3. **Restrict scopes** — never issue tokens with unlimited scope
4. **Log all token issuance** — alert on unexpected registrations
5. **Rate-limit registration and token endpoints**

### Pre-registering claude.ai / ChatGPT clients without DCR (v0.41.3+)

The recommended hardening posture above is: ship `gbrain serve --http`
**without** `--enable-dcr` and pre-register every client manually. As of
v0.41.3, `gbrain auth register-client` accepts the OAuth fields
browser-based clients need:

```bash
# Pre-register claude.ai (confidential client; two redirect URIs)
gbrain auth register-client claude-ai \
  --scopes "read write" \
  --redirect-uri https://claude.ai/api/mcp/auth_callback \
  --redirect-uri https://claude.com/api/mcp/auth_callback
# --grant-types is auto-set to authorization_code,refresh_token when
# --redirect-uri is passed; pass --grant-types explicitly to override.

# Pre-register ChatGPT (public PKCE client; no client_secret minted)
gbrain auth register-client chatgpt \
  --scopes "read write" \
  --redirect-uri https://chatgpt.com/connector/oauth/<HASH> \
  --token-endpoint-auth-method none
```

Auth methods (`--token-endpoint-auth-method`):

- `client_secret_post` (default) — confidential client, secret in body
- `client_secret_basic` — confidential client, secret in `Authorization` header
- `none` — public PKCE-only client (no secret minted; ChatGPT custom
  connector, Claude Code, Cursor)

The same validator applies to CLI, admin, and DCR registration paths, so
unknown authentication methods are rejected consistently. Browser-based
clients can be configured entirely through the supported CLI flags; operators
do not need to edit OAuth database rows by hand.

### DCR consent default (v0.42.55+)

The "disable `client_credentials`, only allow `authorization_code`" guidance
above is now the built-in default for the DCR path, not just advice for custom
wrappers. With `--enable-dcr` on, a self-registered client defaults to the
`authorization_code` (browser-approval) grant, and an explicit
`client_credentials` request is rejected with `invalid_client_metadata`.
Operators who genuinely need the machine-to-machine grant on the registration
endpoint opt in with `--enable-dcr-insecure` (which implies `--enable-dcr`); a
startup WARNING prints whenever DCR is enabled, and a second when the insecure
grant is allowed. Pre-registering clients via the CLI / admin API is unchanged.

### Token Management

```bash
gbrain auth create "claude-desktop"   # Create a new token
gbrain auth list                       # List all tokens
gbrain auth revoke "claude-desktop"    # Revoke a token
gbrain auth test <url> --token <tok>   # Smoke-test a remote server
```

Tokens are stored as SHA-256 hashes in the `access_tokens` table. The
plaintext token is shown once at creation and never stored.

## `gbrain serve --http` hardening (v0.22.7+)

The built-in HTTP transport ships with several layers of hardening on by
default. All env vars below are optional; the defaults are intentionally
conservative.

### Bind address (v0.34: loopback by default)

`gbrain serve --http` listens on `127.0.0.1` by default. Personal-laptop
installs cannot accidentally publish the brain to the LAN. Self-hosted
deployments that need remote access pass `--bind 0.0.0.0` (all
interfaces) or `--bind <interface-ip>` (specific NIC). A stderr WARN
fires when `--public-url` is set without `--bind` so the operator sees
the binding before the first request — common cause of "ngrok forwards
to me but the agent can't reach the upstream" misconfigurations.

### Postgres-only

`gbrain serve --http` requires a Postgres engine. PGLite is local-only by
design and the `access_tokens` / `mcp_request_log` tables don't exist in
the PGLite schema. Local agents continue to use stdio (`gbrain serve`).
Running `--http` against a PGLite-backed install fails fast with a clear
error message at startup.

### Docker network isolation (self-hosted Postgres)

OAuth and source scoping enforce isolation on the `serve --http` path only.
Raw Postgres reachability bypasses both: a container that shares Docker's
default `bridge` network with the brain's Postgres can open a direct DB
session without any token and read every source. Put the brain's Postgres on
a user-defined Docker network with nothing untrusted on it, publish its port
loopback-only (if at all), and never put `DATABASE_URL` or a Postgres
password in untrusted agent containers — those should reach the brain
exclusively via OAuth against `serve --http`. Full operator checklist:
[docs/mcp/DEPLOY.md — Co-located Docker workloads](docs/mcp/DEPLOY.md#co-located-docker-workloads-self-hosted-postgres).

### CORS

Default-deny: no `Access-Control-Allow-Origin` header is sent unless an
allowlist is configured. To allow browser-based MCP clients:

```bash
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai gbrain serve --http --port 8787
# Multiple origins: comma-separated
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai,https://your.app gbrain serve --http
```

When the request `Origin` matches the allowlist, the server echoes it
back in `Access-Control-Allow-Origin` (with `Vary: Origin`). Otherwise no
CORS header is sent and the browser blocks the request.

The same allowlist gates the complete MCP and OAuth HTTP surface. Actual
requests and browser preflight requests use one allowlist-gated policy, so
unlisted origins receive no cross-origin authorization. A startup stderr
warning fires when `--bind 0.0.0.0` is set without
`GBRAIN_HTTP_CORS_ORIGIN`, surfacing the default-deny posture before the
first request.

### Rate limiting

Two buckets, both stored in a bounded LRU map (default 10K keys, evicts
least-recently-used on overflow, prunes entries older than 2× the
window):

| Bucket | When it fires | Default | Env var |
|---|---|---|---|
| Pre-auth IP | Before the DB lookup, on every `/mcp` request | 30 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_IP` |
| Post-auth token | After a valid token is resolved | 60 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_TOKEN` |
| LRU cap | Maximum distinct keys across both buckets | 10000 | `GBRAIN_HTTP_RATE_LIMIT_LRU` |

On exhaustion the server returns `429 Too Many Requests` with a
`Retry-After` header.

**Caveat for tunneled deployments (ngrok, Tailscale Funnel, Cloudflare
Tunnel):** all requests share one egress IP, so the pre-auth IP bucket
becomes effectively shared by all clients on that tunnel. The
post-auth token-id bucket is the load-bearing limiter for tunnel-fronted
deployments.

### Reverse-proxy trust

**Loopback-only by default** (v0.41.3+ Express server agrees with the
legacy transport; pre-v0.41.3 the Express server hardcoded `'loopback'`
while docs claimed "disabled by default" — that disagreement is gone).
The default trusts only same-host proxies (127.0.0.1, ::1, fc00::/7);
external forwarded-for headers are ignored regardless. To widen or
narrow trust:

```bash
# Trust exactly one hop — Fly.io, Render, Vercel, single-layer nginx
GBRAIN_HTTP_TRUST_PROXY=1 gbrain serve --http --port 8787

# Trust N hops — Cloudflare → nginx → gbrain
GBRAIN_HTTP_TRUST_PROXY=2 gbrain serve --http --port 8787

# Disable entirely — direct-exposure deployment with no proxy
GBRAIN_HTTP_TRUST_PROXY=0 gbrain serve --http --port 8787

# Named Express modes (uniquelocal, linklocal) or CIDR lists pass through
GBRAIN_HTTP_TRUST_PROXY=uniquelocal gbrain serve --http --port 8787
GBRAIN_HTTP_TRUST_PROXY="10.0.0.0/8,192.168.1.0/24" gbrain serve --http --port 8787
```

Both transports (Express OAuth server in `src/commands/serve-http.ts` and
the legacy bearer transport in `src/mcp/http-transport.ts`) read the same
env var, so single source of truth.

**Critical safety contract:** only widen past `'loopback'` when **both**
of these are true:

1. gbrain is reachable only via a trusted reverse proxy (not directly
   exposed to the internet on the configured port). As of v0.34
   `gbrain serve --http` binds `127.0.0.1` by default, so the
   reverse-proxy-only posture is the out-of-the-box shape; only
   override with `--bind 0.0.0.0` (or a specific interface IP) when
   gbrain itself needs to accept remote connections directly.
2. The proxy strips any client-supplied `X-Forwarded-For` and `X-Real-IP`
   headers, then sets them itself. (nginx with `proxy_set_header
   X-Forwarded-For $remote_addr` does this; Cloudflare and most cloud
   load balancers handle it automatically.)

If gbrain is reachable directly AND `GBRAIN_HTTP_TRUST_PROXY=1` (or any
non-loopback value) is set, clients can spoof their IP by sending
arbitrary `X-Forwarded-For` headers, defeating the pre-auth IP rate
limit. The `'loopback'` default protects against this by ignoring all
forwarded-for headers and using the socket peer address.

### Body size cap

Default 1 MiB, stream-counted (chunked transfers without
`Content-Length` are still capped). Override:

```bash
GBRAIN_HTTP_MAX_BODY_BYTES=2097152 gbrain serve --http   # 2 MiB
```

Over-cap requests get `413 Payload Too Large` immediately, before any
body is materialized in memory.

### Audit log

Every `/mcp` request writes one row to `mcp_request_log`:

```bash
psql "$DATABASE_URL" -c \
  "SELECT created_at, token_name, operation, status, latency_ms
   FROM mcp_request_log
   ORDER BY created_at DESC LIMIT 100"
```

`status` is one of: `success`, `error`, `auth_failed`, `rate_limited`,
`body_too_large`, `parse_error`, `unknown_method`. Failed-auth rows have
`token_name = NULL`. Inserts are fire-and-forget so audit failures
never block requests.

**v0.26.9 redaction default.** The `params` column now stores
`{redacted, kind, declared_keys, unknown_key_count, approx_bytes}` instead
of raw JSON-RPC payloads. Declared keys (intersected against the operation's
spec) preserve for debug visibility; unknown keys are counted but never
named so attackers can't probe key existence; byte sizes bucket to 1KB so
content sizes can't be binary-searched. The same shape is broadcast on the
admin SSE feed at `/admin/events`. Operators on a personal laptop who want
raw payloads back can pass `gbrain serve --http --log-full-params` (loud
stderr warning at startup). Multi-tenant deployments should leave it
on the redacted default.
