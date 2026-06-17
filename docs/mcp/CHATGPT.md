# Connect GBrain to ChatGPT

**Status (v0.26.0):** Unblocked. GBrain's `gbrain serve --http` ships OAuth 2.1
with PKCE, which is the ChatGPT MCP connector's hard requirement. Before v1.0,
this was a P0 TODO — the only major AI client that could not connect.

ChatGPT does not support bearer-token MCP servers. You must use the OAuth 2.1
HTTP server.

For HTTP MCP protocol, engine, OAuth, scope, and `localOnly` rules, use
[`DEPLOY.md`](DEPLOY.md). This page only covers ChatGPT wiring.

## Setup

### 1. Choose the public URL and start the HTTP server

```bash
gbrain serve --http --port 3131 \
  --public-url https://your-brain.ngrok.app
```

Save the admin bootstrap token printed on stderr if you want to use the admin
dashboard for request logs after setup.

`--public-url` is the OAuth issuer URL ChatGPT will discover. If ngrok assigns a
different URL, restart `gbrain serve` with that exact URL before connecting
ChatGPT. Keep the default loopback bind when ngrok runs on the same machine; add
`--bind 0.0.0.0` only when a tunnel or reverse proxy connects from another host.

### 2. Register a ChatGPT client

ChatGPT uses the authorization code flow with PKCE (browser-based OAuth).
Register it with the CLI so the client is created as a public PKCE client:

```bash
gbrain auth register-client chatgpt \
  --grant-types authorization_code,refresh_token \
  --scopes "read write" \
  --redirect-uri https://chatgpt.com/connector/oauth/<HASH> \
  --token-endpoint-auth-method none
```

Copy the exact redirect URI from the ChatGPT connector setup screen; the
`<HASH>` value is connector-specific. The command prints a `client_id` and no
client secret.

The admin dashboard's OAuth-client modal currently creates confidential
`client_credentials` clients for agents. Do not use that modal for ChatGPT
until it exposes grant type, redirect URI, and public-client controls.

Host-repo wrappers can register programmatically:

```ts
await oauthProvider.registerClientManual(
  'chatgpt',
  ['authorization_code', 'refresh_token'],
  'read write',
  ['https://chatgpt.com/connector/oauth/<HASH>'],
  'default',
  undefined,
  'none',
);
```

### 3. Expose the server publicly

```bash
brew install ngrok
ngrok http 3131 --url your-brain.ngrok.app
```

Your OAuth issuer URL becomes `https://your-brain.ngrok.app`. ChatGPT's
connector auto-discovers the spec-compliant endpoint at
`/.well-known/oauth-authorization-server`.

### 4. Add the connector in ChatGPT

1. Open ChatGPT > Settings > Connectors.
2. Click **Add connector**.
3. MCP server URL: `https://your-brain.ngrok.app/mcp`.
4. Client ID: the `client_id` printed in step 2.
5. Click **Connect**. ChatGPT opens the OAuth consent page, you approve, and
   the connector is live.

Start a new conversation and ask ChatGPT to search your brain. The MCP tool
calls show up in the admin dashboard's live SSE feed in real time.

## Scopes

ChatGPT clients can request any combination of `read`, `write`, `admin`. The
scopes granted at consent time are enforced on every tool call. Four
operations are `localOnly` and rejected over HTTP regardless of scope:
`sync_brain`, `file_upload`, `file_list`, `file_url`. The HTTP server fails
closed for any attempt to reach local filesystem surface area.

Recommended ChatGPT scope: `read write`. Leave `admin` for your local CLI
and the admin dashboard.

## Troubleshooting

**"Invalid redirect_uri" during the ChatGPT connector OAuth handshake**
The registered `redirect-uri` must match ChatGPT's exactly. If ChatGPT
rejects your server, re-run `gbrain auth register-client chatgpt` with the
redirect URI shown by ChatGPT's error page.

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
