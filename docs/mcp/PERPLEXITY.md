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
machine (ngrok connects to loopback, so the default bind is right):

```bash
gbrain serve --http --port 3131 --public-url https://YOUR-DOMAIN.ngrok.app
ngrok http 3131 --url YOUR-DOMAIN.ngrok.app
```

Only when the tunnel agent or reverse proxy runs on a different host does the
server need `--bind 0.0.0.0` (otherwise the front reaches the machine but the
connection is refused, `ECONNREFUSED`). Full detail in
[DEPLOY.md — Expose the server](DEPLOY.md#3-expose-the-server) and the
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md). The examples below use
the Tailscale name; substitute your ngrok domain.

## 3. Create credentials

Two supported auth paths. (Full client-registration mechanics — the `/admin`
dashboard flow, grant types, scope format — live in
[DEPLOY.md — Register OAuth clients](DEPLOY.md#2-register-oauth-clients);
below is the Perplexity-specific shape.)

**OAuth 2.1 client credentials (recommended).** Perplexity is a cloud
service, so it holds whatever credential you give it. OAuth is the correct choice:
least-privilege scopes + short-lived rotating access tokens instead of a
long-lived full-access secret. Mint a client and print the connector fields in
one step (on the brain host):

```bash
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --agent perplexity --oauth --register
```

Or register separately and pass the creds (works anywhere, no DB needed):

```bash
gbrain auth register-client perplexity --grant-types client_credentials --scopes "read write"
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --agent perplexity --oauth \
  --client-id gbrain_cl_xxx --client-secret gbrain_cs_xxx
```

`connect --oauth` prints the **Issuer URL + Client ID + Client Secret** to paste
in step 4.

**Legacy bearer token (simplest, best for local/personal):**

```bash
gbrain auth create "perplexity"
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --token gbrain_xxx --agent perplexity
```

> **PGLite brains:** `gbrain auth create` opens the database, which fails with
> `live_serve` while the expose-managed service holds it. Mint the token
> **before** the service runs (ahead of `gbrain mcp expose`, or while the service
> is stopped briefly), or provision through the running server instead —
> `gbrain mcp grant … --admin-token-file ~/.gbrain/serve/admin-token` or the
> `/admin` dashboard. Postgres brains mint fine while the server runs.

(Perplexity is a GUI connector, so there's no `--install` — `connect` prints the
exact values to paste in step 4.)

## 4. Add the connector in Perplexity

1. Open Perplexity (requires Pro subscription).
2. Go to **Settings → Connectors** (or **MCP Servers**).
3. Add a new remote connector:
   - **URL:** `https://your-machine.your-tailnet.ts.net/mcp`
   - **Authentication:** API Key / Bearer Token, or OAuth client credentials
   - Paste the token (bearer) or `client_id` + `client_secret` (OAuth).
4. Save.

## Verify

In a Perplexity conversation, ask it to use your brain:

```
Use my GBrain to search for [topic]
```

Have it call `get_brain_identity` (whose brain this is), then `list_skills`
(everything it can do).

## Notes

- Perplexity Computer is available to Pro subscribers; both the Mac app and web
  version support remote MCP connectors.
- The Mac app can also use a local MCP server (`gbrain serve` stdio) if you'd
  rather not expose an HTTP endpoint.
- A `gbrain auth create` token is a long-lived, full-access secret. Keep it
  private and prefer a scoped token where possible.
