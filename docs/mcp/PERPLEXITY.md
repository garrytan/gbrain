# Connect GBrain to Perplexity Computer

Perplexity Computer connects as a **remote** MCP client, so GBrain must be served
over HTTP and reachable at a public HTTPS URL. Perplexity does not run
`gbrain serve` (stdio) the way Claude Code does — it needs a reachable endpoint:

```
Perplexity Computer
  → https://your-machine.your-tailnet.ts.net/mcp   (Tailscale Funnel; ngrok alternative)
  → gbrain serve --http   (built-in OAuth 2.1 transport)
  → Postgres / PGLite
```

## 1. Publish GBrain over HTTPS (host side)

Perplexity's runtime is in the vendor's cloud, so it needs the public shape:

```bash
gbrain mcp expose --funnel
```

**Say to your agent:** *"expose my brain over mcp"* — *"put my brain on tailscale"*.

This starts `gbrain serve --http` as a user service on the default loopback
bind, publishes it with Tailscale Funnel at
`https://your-machine.your-tailnet.ts.net`, and sets `--public-url` to match —
the OAuth issuer in the discovery metadata lines up with the URL Perplexity
actually hits (RFC 8414 §3.3). Consent prompt, flags and troubleshooting:
[remote MCP guide](../guides/remote-mcp.md).

## 2. Alternative: ngrok

Run the server yourself with the ngrok issuer and start the tunnel on the same
machine (ngrok connects to loopback, so the default bind is right). Start the
tunnel in one terminal:

```bash
ngrok http 3131 --url YOUR-DOMAIN.ngrok.app
```

Keep it running, then start the brain server once in another terminal:

```bash
gbrain serve --http --port 3131 --public-url https://YOUR-DOMAIN.ngrok.app
```

Only when the tunnel agent or reverse proxy runs on a different host does the
server need `--bind 0.0.0.0` (otherwise the front reaches the machine but the
connection is refused, `ECONNREFUSED`). Full detail in
[DEPLOY.md — Expose the server](DEPLOY.md#3-expose-the-server) and the
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md). The examples below use
the Tailscale name and expose-managed owner credential file; substitute your
configured endpoint and protected owner credential for another deployment.

## 3. Create credentials

Choose the authentication flow actually offered by the intended Perplexity
connection. For native OAuth/PKCE, follow
[native hosted setup](../guides/hosted-harness-access.md#native-oauth-path), using
its exact callback and authentication method. Do not assume every Perplexity
product uses the same settings.

For a connection that accepts **machine client credentials**, the authorized
administrator provisions a scoped handoff through the existing server:

```bash
gbrain mcp grant perplexity-example --harness perplexity \
  --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /absolute/private/perplexity-example.json --json
```

Use `--dry-run` first to review the grant. Generate instructions for that actual
registration:

```bash
gbrain mcp admin setup CLIENT_ID --harness perplexity --flow client-credentials \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --json
```

Keep the client secret in the private handoff and enter it only in the intended
authentication settings. Ordinary setup output is redacted; explicit recovery
uses `--credentials-out PRIVATE_FILE`. Never pass the owner credential to
Perplexity. For legacy bearer connections, see [legacy setup](DEPLOY.md#legacy-bearer-token-setup).
The generic/manual adapter produces instructions; it does not claim to install
or activate Perplexity's native settings.

For legacy bearer settings on PGLite, mint a scoped token before the server
runs (`gbrain auth create perplexity-example --scopes read,write`), or provision
through the running server's owner API. `gbrain auth create` opens the database
and fails with `live_serve` while the service holds its single-writer lock.
Postgres allows concurrent local maintenance commands.

## 4. Add the connector in Perplexity

1. Open Perplexity (requires Pro subscription).
2. Go to **Settings → Connectors** (or **MCP Servers**).
3. Add a new remote connector:
   - **URL:** `https://your-machine.your-tailnet.ts.net/mcp`
   - **Authentication:** the supported method selected in step 3.
   - For native OAuth, enter the owner-issued client metadata, initiate PKCE in
     Perplexity, and obtain owner consent. For machine client credentials or a
     bearer connection, enter the corresponding private handoff fields.
4. Save.

## Verify

In a Perplexity conversation, ask it to use your brain:

```
Use my GBrain to search for [topic]
```

Have it call `get_brain_identity` (whose brain this is), then `list_skills`
(everything it can do).

Observe an authenticated call in the actual Perplexity session. A generated
setup file or a successful server probe does not establish native activation.

## Notes

- Perplexity Computer is available to Pro subscribers; both the Mac app and web
  version support remote MCP connectors.
- The Mac app can also use a local MCP server (`gbrain serve` stdio) if you'd
  rather not expose an HTTP endpoint.
- A `gbrain auth create` token is a long-lived, full-access secret. Keep it
  private and prefer a scoped token where possible.
