# Connect GBrain to ChatGPT

ChatGPT's MCP connector requires OAuth 2.1 with PKCE — it does not support
bearer-token MCP servers. GBrain's `gbrain serve --http` speaks exactly that,
so ChatGPT connects natively.

This page covers only the ChatGPT-specific parts. The full server setup —
starting `gbrain serve --http`, the admin bootstrap token, the `/admin`
dashboard, tunnels, and `--bind` / `--public-url` — lives in
[DEPLOY.md](DEPLOY.md). Do steps 1 (start the server) and 3 (expose it)
from there, then come back for the ChatGPT client.

## Setup

### 1. Start and expose the server (DEPLOY.md steps 1 + 3)

Follow [DEPLOY.md — OAuth 2.1 Setup](DEPLOY.md#oauth-21-setup) to start
`gbrain serve --http`, save the admin bootstrap token, and expose the server
at a public HTTPS URL (e.g. `https://your-brain.ngrok.app`). ChatGPT's
connector auto-discovers the spec-compliant endpoint at
`/.well-known/oauth-authorization-server`.

### 2. Register a ChatGPT client

The ChatGPT-specific delta: ChatGPT uses the **authorization code flow with
PKCE** (browser-based OAuth), so the client needs the `authorization_code`
grant type and a redirect URI. Register from the `/admin` dashboard:

1. Click **Register client**.
2. Name: `chatgpt`.
3. Grant type: `authorization_code`.
4. Scopes: `read`, `write` (leave `admin` unchecked for ChatGPT).
5. Redirect URI: ChatGPT's OAuth redirect — **always copy the exact value
   from the ChatGPT connector setup screen** (it looks like
   `https://chatgpt.com/connector_platform_oauth_redirect`, but the domain
   has changed before; trust the setup screen, not this doc).
6. Hit **Register**. The credential-reveal modal shows the `client_id` once
   with Copy and Download JSON buttons. There is no client secret for
   PKCE-based public clients.

Host-repo wrappers can register programmatically:

```ts
await oauthProvider.registerClientManual(
  'chatgpt',
  ['authorization_code'],
  'read write',
  ['<ChatGPT redirect URI from the connector setup screen>'],
);
```

### 3. Add the connector in ChatGPT

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
scopes granted at consent time are enforced on every tool call. Operations
flagged `localOnly: true` in `src/core/operations.ts` (10 today — `sync_brain`
and the `file_*` ops among them) are rejected over HTTP regardless of scope.
The HTTP server fails closed for any attempt to reach local filesystem
surface area.

Recommended ChatGPT scope: `read write`. Leave `admin` for your local CLI
and the admin dashboard.

## Deep research

ChatGPT's **deep research** mode has a stricter MCP contract than normal
chat: the server must expose a `search`/`fetch` tool PAIR, where every
`search` result carries an `id` and `fetch(id)` returns
`{ id, title, text, url, metadata }`. GBrain ships both:

- `search` results carry `id` (the page slug) alongside the native fields.
- `fetch` takes that `id` and returns the OpenAI shape — `text` is the
  page's full canonical markdown, `url` is a stable `gbrain://page/...`
  URI for the citation slot, and `metadata` carries type/source/tags.

`fetch` is a thin read-only adapter over the same page read as `get_page`
(same source scoping, same privacy fences for remote readers). Normal chat
keeps using the richer gbrain-native tools; deep research uses the pair.

**DCR zero-scope gotcha.** If the connector registers itself via dynamic
client registration (`--enable-dcr`) and the registration request omits
`scope`, the client is registered with an EMPTY scope — and every token it
mints is zero-scope. The connector then connects fine but every tool call
(including deep research's `search`/`fetch`) fails with
`insufficient_scope`. Fix: rescope the client to `read` (or `read write`)
from the `/admin` dashboard or the CLI, then reconnect. Manual
registration per step 2 above never hits this — you pick the scopes
explicitly.

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
