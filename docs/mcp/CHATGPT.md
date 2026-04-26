# Connect GBrain to ChatGPT

**Status (v0.26.0):** Unblocked. GBrain's `gbrain serve --http` ships OAuth 2.1
with PKCE, which is the ChatGPT MCP connector's hard requirement. Before v1.0,
this was a P0 TODO — the only major AI client that could not connect.

ChatGPT does not support bearer-token MCP servers. You must use the OAuth 2.1
HTTP server.

## Setup

### 1. Start the HTTP server

```bash
gbrain serve --http --port 3131
```

Save the admin bootstrap token printed on stderr. Open
`http://localhost:3131/admin` and paste it to access the dashboard.

### 2. Register a ChatGPT client

ChatGPT uses the authorization code flow with PKCE (browser-based OAuth).
Register from the `/admin` dashboard:

1. Click **Register client**.
2. Name: `chatgpt`.
3. Grant type: `authorization_code`.
4. Scopes: `read`, `write` (leave `admin` unchecked for ChatGPT).
5. Redirect URI: ChatGPT's OAuth redirect (copy it from the ChatGPT
   connector setup screen — something like
   `https://chat.openai.com/connector_platform_oauth_redirect`).
6. Hit **Register**. The credential-reveal modal shows the `client_id` once
   with Copy and Download JSON buttons. There is no client secret for
   PKCE-based public clients.

Host-repo wrappers can register programmatically:

```ts
await oauthProvider.registerClientManual(
  'chatgpt',
  ['authorization_code'],
  'read write',
  ['https://chat.openai.com/connector_platform_oauth_redirect'],
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
4. Client ID: the `client_id` you saved in step 2.
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
