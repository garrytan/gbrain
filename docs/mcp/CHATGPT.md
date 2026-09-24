# Connect GBrain to ChatGPT

Use GBrain's native OAuth authorization-code flow with PKCE for ChatGPT.
Do not give ChatGPT a machine-client handoff or the owner bootstrap credential.
OpenAI's [authentication guide](https://developers.openai.com/plugins/build/auth)
documents PKCE, predefined OAuth clients, and DCR; machine-to-machine client
credentials are not a ChatGPT connection method. Checked **2026-09-17**.

This page covers only the ChatGPT-specific parts. The full server setup —
starting `gbrain serve --http`, the admin bootstrap token, the `/admin`
dashboard, tunnels, and `--bind` / `--public-url` — lives in
[DEPLOY.md](DEPLOY.md). Do steps 1 (start the server) and 3 (expose it)
from there, then come back for the ChatGPT client. Owner login and client
management use [ADMIN.md](ADMIN.md); OAuth `admin` scope cannot perform them.

## Setup

### 1. Start and expose the server (DEPLOY.md steps 1 + 3)

ChatGPT's connector runs in OpenAI's cloud, so the server needs a public
HTTPS URL. On the brain host, `gbrain mcp expose --funnel` starts
`gbrain serve --http` as a user service, publishes it with Tailscale Funnel at
`https://your-machine.your-tailnet.ts.net`, and keeps the admin bootstrap
token in `~/.gbrain/serve/admin-token` for the `/admin` login
([remote MCP guide](../guides/remote-mcp.md)). Alternatively follow
[DEPLOY.md — OAuth 2.1 Setup](DEPLOY.md#oauth-21-setup) to start
`gbrain serve --http` yourself and expose it through ngrok
(`https://your-brain.ngrok.app`) or a cloud host. ChatGPT's
connector auto-discovers the spec-compliant endpoint at
`/.well-known/oauth-authorization-server` and the `/mcp` protected-resource
metadata at `/.well-known/oauth-protected-resource/mcp`.

**Say to your agent:** *"expose my brain over mcp"* — *"use my brain over mcp"*.

### 2. Register a ChatGPT client

Copy the **exact redirect URI from ChatGPT's MCP management/setup screen**.
OpenAI currently documents both a stable callback and a connection-specific
callback, depending on issuer identification; a remembered sample URL is not a
reliable registration value. See the [redirect requirements](https://developers.openai.com/plugins/build/auth#redirect-url).

For a manually configured public client, select public PKCE (`none`) in the
GBrain dashboard, or have the authorized administrator run the command below.
Substitute the intended server's configured URL and owner credential file;
the Funnel setup above uses `https://your-machine.your-tailnet.ts.net/mcp`
and `~/.gbrain/serve/admin-token`.

```bash
gbrain mcp admin register chatgpt-example \
  --redirect-uri 'EXACT_REDIRECT_URI_FROM_CHATGPT' \
  --token-endpoint-auth-method none --profile memory-writer --source default \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --dry-run --json
```

Review and repeat without `--dry-run`, then run `gbrain mcp admin setup
CLIENT_ID --harness chatgpt --flow authorization-code` with the same server URL
and owner credential. This registration includes authorization-code and refresh
grants. A public client has no secret. PKCE alone does not imply a public client:
if the configured client uses confidential POST/Basic authentication, register
that actual method and explicitly deliver its secret through a private file.

If the owner prefers self-registration, enable DCR on the existing service and
let ChatGPT register its client. Manual registration does not require DCR.
GBrain's supported registration paths here are manual registration and DCR;
do not advertise CIMD or signed-client-assertion support from this guide.

### 3. Add the connector in ChatGPT

Use ChatGPT's current [developer-mode setup](https://developers.openai.com/api/docs/guides/developer-mode):
enable Developer mode in Settings → Security and login, then create a
developer-mode app from the Plugins page. Select OAuth and enter the actual
MCP URL (`https://your-machine.your-tailnet.ts.net/mcp` for the Funnel setup
above) and predefined client details, or use owner-enabled DCR. Refresh the
app after changing server instructions/tools, and select it for the conversation.

Start the connection inside ChatGPT. If GBrain asks for owner login, send the
pending `oauth_request` ID to the authorized administrator; they run
`mcp admin login-link --oauth-request REQUEST_ID` against this server. Open
that returned link privately, review consent, and approve. The link may open
in a fresh browser while retaining the same request. If it expired or the
server restarted, initiate the connection again in ChatGPT.

Start a new conversation and ask ChatGPT to search your brain. The MCP tool
calls show up in the admin dashboard's live SSE feed in real time.

## Scopes

ChatGPT clients can request any combination of `read`, `write`, `admin`. The
scopes granted at consent time are enforced on every tool call. Operations
flagged `localOnly: true` in `src/core/operations.ts` (`sync_brain`
and the `file_*` ops among them) are rejected over HTTP regardless of scope.
The HTTP server fails closed for any attempt to reach local filesystem
surface area.

For ordinary memory, request `read write` and keep the appropriate source and
operation restrictions. The owner dashboard uses its separate bootstrap/session
credential; adding MCP `admin` scope will not log ChatGPT into it.

The initial MCP authentication challenge requests only `read`. Clients that
follow that hint bootstrap with read access, even when their registration
allows `read write`; registration is a ceiling, not automatic authorization
for every listed scope. Saving requires the client to explicitly request
`write` and the operator to approve it. Existing authorized writer sessions
keep their permissions.

OAuth discovery omits the operator-only `agent` scope so clients that register
using advertised scopes do not request unsupported delegation. Explicit DCR
requests for `agent` still fail; delegation requires a separately approved
host grant. The server's SDK/HTTP tests cover these flows, not a live ChatGPT
or Claude connector session.

## Deep research

ChatGPT's **deep research** mode has a stricter MCP contract than normal
chat: the server must expose a `search`/`fetch` tool PAIR, where every
`search` result carries an `id` and `fetch(id)` returns
`{ id, title, text, url, metadata }`. GBrain ships both:

- `search` results carry an opaque, versioned `id` identifying the hit's
  source and slug alongside the native fields. `query` uses the same IDs.
- Pass the `id` unchanged to `fetch`; do not replace it with the slug or
  construct it from the current source. `fetch` returns the OpenAI shape — `text` is the
  page's full canonical markdown, `url` is a stable `gbrain://page/...`
  URI for the citation slot, and `metadata` carries type/source/tags.

`fetch` is a thin read-only adapter over the same page read as `get_page`
(same source scoping, same privacy fences for remote readers). Normal chat
keeps using the richer gbrain-native tools; deep research uses the pair.
An ID does not grant access: fetch rechecks current source grants and page
visibility. Legacy bare-slug IDs still work when unambiguous within the current
read scope; collisions are refused instead of selecting the first source.
See the [deep-research ID protocol](../protocol/DEEP_RESEARCH_IDS_v1.md) for
encoding, rename behavior, and escaped citation URLs. This protocol is tested
through GBrain's CLI and MCP transports, not a live ChatGPT connector session.

**DCR zero-scope gotcha.** If the connector registers itself via dynamic
client registration (`--enable-dcr`) and the registration request omits
`scope`, the client is registered with an EMPTY scope — and every token it
mints is zero-scope. The connector then connects fine but every tool call
(including deep research's `search`/`fetch`) fails with
`insufficient_scope`. Fix: rescope the client to `read` (or `read write`)
from the `/admin` dashboard or the CLI, then reconnect. Manual
registration per step 2 above never hits this — you pick the scopes
explicitly.

**DCR scope ceiling.** The reverse also holds: a self-registering connector
may request at most `read write`, and while `--enable-dcr` is on, OAuth
discovery (`scopes_supported` in both the authorization-server and the
protected-resource metadata) advertises exactly that set — so a connector
that copies the advertised scopes into its registration succeeds. If it
explicitly asks for `admin` anyway, registration fails with HTTP 400
`invalid_client_metadata` rather than being quietly narrowed, and the
connector shows a connection error. Either register the client manually
(step 2) with the scopes you want, or let it self-register with `read
write` and widen it afterwards with
the [owner permission-edit path](ADMIN.md#inspect-clients-and-edit-access). Every self-registered
connection also stops at the admin dashboard for your approval before a
token is issued.

## Troubleshooting

**"Invalid redirect_uri" during the ChatGPT connector OAuth handshake**
The registered `redirect-uri` must match ChatGPT's exactly. If ChatGPT
rejects your server, check the admin dashboard's **Agents** table for the
client, confirm the redirect URI matches what the error page shows, and
re-register with the correct URI.

**ChatGPT shows an MCP connection error after approval**
Open `/admin`, watch the SSE feed, and try again. If no request arrives, the
connector isn't reaching your public URL — with Tailscale, confirm
`gbrain mcp expose --status` reports mode `funnel` and tailnet health `ok`
(tailnet-only Serve is not reachable from OpenAI's cloud); with ngrok, check
the tunnel. If a request arrives but fails, the Request Log tab shows the
exact error.

**"Unsupported grant_type" on the token endpoint**
ChatGPT uses `authorization_code`, which the MCP SDK supports natively.
If you see this error, inspect `gbrain mcp admin client CLIENT_ID` through the
authorized administrator. The registration must include `authorization_code`
and the native client's actual authentication method. Machine-only registration
is the wrong setup path.

## See also

- [DEPLOY.md](DEPLOY.md) — full OAuth 2.1 setup reference
- [ADMIN.md](ADMIN.md) — owner login, native registration, access changes, and recovery
- [ALTERNATIVES.md](ALTERNATIVES.md) — tunnel options (ngrok, Tailscale, Fly)
