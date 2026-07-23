# Connect GBrain to ChatGPT

**Status:** Protocol-compatible, security-gated. GBrain's HTTP server exposes
the OAuth 2.1 + PKCE endpoints ChatGPT requires, but the current built-in
`/authorize` route does not authenticate an operator or present a consent
decision before issuing a code.

ChatGPT does not support bearer-token MCP servers. You must use the OAuth 2.1
HTTP server.

Do not expose the stock authorization-code flow publicly by itself. Continue
only when the deployment places an authenticated consent policy around
`/authorize` and verifies that the approving identity is allowed to grant the
requested brain scopes. Without that policy, possession of the public client
id is enough to complete a PKCE flow; stop and do not register the connector.
See [`../../SECURITY.md`](../../SECURITY.md).

For HTTP MCP protocol, engine, OAuth, scope, and `localOnly` rules, use
[`DEPLOY.md`](DEPLOY.md). This page only covers ChatGPT wiring.

## Setup

### 1. Enforce authenticated consent

Put an identity-aware authorization/consent layer in front of `/authorize`.
The exact proxy or identity-provider configuration is deployment-specific and
is not supplied by GBrain today. Configure that layer to listen on a separate
local port, proxy allowed traffic to GBrain on loopback port 3131, and require
authenticated approval before forwarding `/authorize`. Prove with an
unauthorized browser session that no authorization code is issued before
continuing.

### 2. Choose the public URL and start the HTTP server

```bash
gbrain serve --http --port 3131 \
  --public-url https://your-brain.ngrok.app
```

Save the admin bootstrap token printed on stderr. Open
`http://localhost:3131/admin` and paste it to access the dashboard.

`--public-url` is the OAuth issuer URL ChatGPT will discover. If ngrok assigns a
different URL, restart `gbrain serve` with that exact URL before connecting
ChatGPT. Keep GBrain on its default loopback bind. Only the consent proxy may
reach port 3131; public traffic must not tunnel or route directly to it.

### 3. Register a ChatGPT client

ChatGPT uses the authorization code flow with PKCE (browser-based OAuth).
Copy the exact redirect URI from ChatGPT's connector setup screen, then
register a public client explicitly from the host:

```bash
gbrain auth register-client chatgpt \
  --grant-types authorization_code,refresh_token \
  --scopes "read" \
  --redirect-uri "https://chat.openai.com/connector_platform_oauth_redirect" \
  --token-endpoint-auth-method none
```

Replace the example redirect URI with the exact value ChatGPT provides. Add
`write` to `--scopes` only when ChatGPT must modify the brain; never grant
`admin`. Save the returned `client_id`. A public PKCE client uses
`token_endpoint_auth_method=none` and has no client secret.

### 4. Expose the server publicly

```bash
brew install ngrok
ngrok http <consent-proxy-port> --url your-brain.ngrok.app
```

Replace `<consent-proxy-port>` with the local listener owned by the
authenticated consent layer, not GBrain's port 3131. Your OAuth issuer URL
becomes `https://your-brain.ngrok.app`. ChatGPT's connector auto-discovers the
spec-compliant endpoint at
`/.well-known/oauth-authorization-server`.

### 5. Add the connector in ChatGPT

1. Open ChatGPT > Settings > Connectors.
2. Click **Add connector**.
3. MCP server URL: `https://your-brain.ngrok.app/mcp`.
4. Client ID: the `client_id` you saved in step 3.
5. Click **Connect**. ChatGPT opens the authorization page. The external
   policy must authenticate the approving user and record their consent before
   allowing the code flow to continue.

Start a new conversation and ask ChatGPT to search your brain. The MCP tool
calls show up in the admin dashboard's live SSE feed in real time.

## Scopes

ChatGPT clients can request any combination of `read`, `write`, `admin`. The
scopes granted at consent time are enforced on every tool call. Operations
marked `localOnly` are rejected over HTTP regardless of scope. Examples include
`sync_brain`, `file_upload`, `file_list`, and `file_url`. The registry in
`src/core/operations.ts` is authoritative, and the HTTP server fails closed
for attempts to reach local filesystem surface area.

Recommended starting scope: `read`. Add `write` only for an explicit editing
workflow. Leave `admin` for your local CLI and the admin dashboard.

## Troubleshooting

**"Invalid redirect_uri" during the ChatGPT connector OAuth handshake**
The registered `redirect-uri` must match ChatGPT's exactly. If ChatGPT
rejects your server, check the admin dashboard's **Agents** table for the
client, confirm the redirect URI matches what the error page shows, and
re-register with the correct URI.

**ChatGPT shows an MCP connection error after approval**
Open `/admin`, watch the SSE feed, and try again. If no request arrives, the
connector isn't reaching your ngrok URL. If a request arrives but fails,
the Request Log tab shows the exact error.

**"Unsupported grant_type" on the token endpoint**
ChatGPT uses `authorization_code`, which the MCP SDK supports natively.
If you see this error, verify the client was registered with
`--grant-types authorization_code` and not `client_credentials`.

## See also

- [DEPLOY.md](DEPLOY.md) — full OAuth 2.1 setup reference
- [ALTERNATIVES.md](ALTERNATIVES.md) — tunnel options (ngrok, Tailscale, Fly)
