# Connect MBrain to ChatGPT

**Status: OAuth foundation available; live ChatGPT validation still pending**

ChatGPT requires OAuth for remote MCP. Bearer token authentication alone is not
accepted by ChatGPT's MCP integration.

MBrain's self-hosted HTTP server can now expose OAuth 2.1/Dynamic Client
Registration routes on top of `mbrain serve --http`. The implementation is
single-user and opt-in: the owner approves the browser authorization request with
an approval token, and the token endpoint stores the issued MCP bearer token in
the existing `access_tokens` table.

Before a live ChatGPT pass, agents can run the local runtime confidence smoke:

```bash
DATABASE_URL='postgresql://...' bun run smoke:http-oauth
```

That smoke starts the real HTTP MCP server, simulates DCR + PKCE, calls MCP
tools with the issued token, refreshes it, and verifies Postgres evidence. It
does not replace live ChatGPT Developer Mode validation.

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
grants, and the existing MBrain bearer-token table for issued access tokens.
Refresh grants rotate the client session's access token binding, so older
access tokens from the same refresh chain are rejected.

## Current limits

- DCR client registrations and authorization codes are in-memory. If the server
  restarts during setup, reconnect from ChatGPT so it can register again.
- No admin UI is included. The approval token is the owner confirmation step.
- OAuth is not enabled unless `--oauth` or `MBRAIN_HTTP_OAUTH=1` is set.
- PGLite remains a local/offline runtime and does not issue remote OAuth tokens.
- `bun run smoke:http-oauth` proves the local protocol/runtime path, not
  ChatGPT's production connector UI or a public HTTPS tunnel.
- Live ChatGPT Developer Mode validation is still required before marking this
  guide as fully verified.

## Troubleshooting

**OAuth metadata shows `http://localhost`**
Pass `--public-url https://YOUR-DOMAIN` or set `MBRAIN_HTTP_PUBLIC_URL`.

**Authorization fails with `oauth_not_configured`**
Set `MBRAIN_OAUTH_APPROVAL_TOKEN` before starting the server.

**Token exchange fails after restart**
Restart the ChatGPT connection flow so the client registration and authorization
code are recreated in the current server process.
