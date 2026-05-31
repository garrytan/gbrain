# Connect MBrain to ChatGPT

**Status: OAuth foundation available; live ChatGPT Developer Mode validation completed**

ChatGPT requires OAuth for remote MCP. Bearer token authentication alone is not
accepted by ChatGPT's MCP integration.

MBrain's self-hosted HTTP server can now expose OAuth 2.1/Dynamic Client
Registration routes on top of `mbrain serve --http`. The implementation is
single-user and opt-in: the owner approves the browser authorization request with
an approval token, and the token endpoint stores the issued MCP bearer token in
the existing `access_tokens` table. OAuth setup state requires the Postgres
engine; SQLite/PGLite local profiles should use bearer-token HTTP MCP instead.

Before opening ChatGPT, or when debugging a regression without ChatGPT, agents
can run the local runtime confidence smoke:

```bash
DATABASE_URL='postgresql://...' bun run smoke:http-oauth
```

That smoke starts the real HTTP MCP server, simulates DCR + PKCE, calls MCP
tools with the issued token, refreshes it, and verifies Postgres evidence. Set
`MBRAIN_SMOKE_RESTART_OAUTH_STATE=1` to prove DCR/client-code state survives
server restarts during setup. It does not require OpenAI or Anthropic API keys.

To check that OAuth discovery will advertise your public HTTPS issuer instead
of `localhost`, run the same smoke with the public URL:

```bash
DATABASE_URL='postgresql://...' \
MBRAIN_HTTP_PUBLIC_URL='https://YOUR-DOMAIN.ngrok.app' \
bun run smoke:http-oauth
```

The resulting JSON should include `"oauthIssuer":
"https://YOUR-DOMAIN.ngrok.app"`.

## Start the server

```bash
export DATABASE_URL='postgresql://...'
export MBRAIN_OAUTH_APPROVAL_TOKEN='choose-a-long-random-token'

mbrain serve --http \
  --host 127.0.0.1 \
  --port 8787 \
  --oauth \
  --public-url https://YOUR-DOMAIN.ngrok.app
```

Set `MBRAIN_OAUTH_SIGNING_SECRET` to a separate 32+ byte random value for
refresh-token signing. If it is unset, MBrain warns and falls back to the
approval token for local testing only.

Then expose the local server with ngrok, Tailscale Funnel, Fly.io, Railway, or
another HTTPS host.

## Endpoints

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET/POST /oauth/authorize`
- `POST /oauth/token`
- `POST /mcp`

OAuth uses public clients, PKCE `S256`, authorization code grants, refresh token
grants, Postgres-backed DCR client and authorization-code state, atomic one-use
authorization-code consumption, and the existing MBrain bearer-token table for
issued access tokens. Unapproved DCR registrations are pruned after one hour,
and pending registrations are capped at 128 to bound the public registration
surface. `mbrain serve --http --oauth` prepares the schema before opening the
HTTP server, so upgraded Postgres installs have the OAuth runtime tables before
ChatGPT begins setup.
Refresh grants rotate the client session's access token binding, so older
access tokens from the same refresh chain are rejected.

HTTP MCP clients receive full tool descriptors with titles, descriptions, and
MCP read/write/destructive annotations so ChatGPT can list MBrain app actions
after OAuth connects. Stdio clients keep compact descriptors to preserve frame
budget headroom.

## Current limits

- Authorization codes are short-lived and one-use, including concurrent exchange
  attempts. If setup takes too long, reconnect from ChatGPT so it can create a
  fresh code.
- If many client registrations are left pending, `/oauth/register` can return
  HTTP 429 until stale setup rows are pruned or an authorization completes.
- No admin UI is included. The approval token is the owner confirmation step.
- OAuth is not enabled unless `--oauth` or `MBRAIN_HTTP_OAUTH=1` is set.
- SQLite and PGLite remain local/offline profiles and do not issue remote OAuth
  setup tokens.
- `bun run smoke:http-oauth` proves the local protocol/runtime path. With
  `MBRAIN_HTTP_PUBLIC_URL`, it also proves the configured public issuer in
  OAuth metadata and challenges. With `MBRAIN_SMOKE_RESTART_OAUTH_STATE=1`, it
  proves setup state survives HTTP server restarts. It still does not prove that
  a specific future public tunnel is reachable from ChatGPT; keep tunnel health
  and client-side checks as deployment-specific gates.
- The guide was validated with ChatGPT Developer Mode on 2026-05-31 using a
  temporary public HTTPS tunnel, Dynamic Client Registration, owner approval,
  OAuth token exchange, action discovery, and a `get_stats` MCP tool call
  against real Postgres.

## Troubleshooting

**OAuth metadata shows `http://localhost`**
Pass `--public-url https://YOUR-DOMAIN` or set `MBRAIN_HTTP_PUBLIC_URL`.

**Authorization fails with `oauth_not_configured`**
Set `MBRAIN_OAUTH_APPROVAL_TOKEN` before starting the server.

**Token exchange fails after restart**
Confirm the restarted server is using the same Postgres `DATABASE_URL`, then run
`MBRAIN_SMOKE_RESTART_OAUTH_STATE=1 bun run smoke:http-oauth` against that
database to verify persisted setup state.
