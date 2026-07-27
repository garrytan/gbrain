# Connect GBrain to Perplexity Computer

Perplexity Computer connects as a **remote** MCP client, so GBrain must be served
over HTTP and reachable at a public HTTPS URL. Perplexity does not run
`gbrain serve` (stdio) the way Claude Code does — it needs a reachable endpoint:

```
Perplexity Computer
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app/mcp)
  → gbrain serve --http   (built-in OAuth 2.1 transport)
  → Postgres / PGLite
```

## 1. Serve GBrain over HTTP (host side)

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 \
  --public-url https://YOUR-DOMAIN.ngrok.app
```

- **`--bind 0.0.0.0` is required.** Since v0.34, `--http` defaults to
  `127.0.0.1`, so without it the tunnel reaches the server but the connection is
  refused (`ECONNREFUSED`).
- **`--public-url` must match the tunnel.** The OAuth issuer in the discovery
  metadata has to line up with the URL Perplexity actually hits (RFC 8414 §3.3),
  or OAuth client-credentials auth fails.

## 2. Expose it with a tunnel

```bash
ngrok http 3131 --url YOUR-DOMAIN.ngrok.app
```

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for a persistent
tunnel.

## 3. Create credentials

Two supported auth paths.

**OAuth 2.1 client credentials (recommended, v0.26.0+).** Perplexity is a cloud
service, so it holds whatever credential you give it. OAuth is the correct choice:
least-privilege scopes + short-lived rotating access tokens instead of a
long-lived full-access secret. Mint a client and print the connector fields in
one step (on the brain host):

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --agent perplexity --oauth --register
```

Or register separately and pass the creds (works anywhere, no DB needed):

```bash
gbrain auth register-client perplexity --grant-types client_credentials --scopes "read write"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --agent perplexity --oauth \
  --client-id gbrain_cl_xxx --client-secret gbrain_cs_xxx
```

`connect --oauth` prints the **Issuer URL + Client ID + Client Secret** to paste
in step 4.

**Legacy bearer token (simplest, best for local/personal):**

```bash
gbrain auth create "perplexity"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --agent perplexity
```

(Perplexity is a GUI connector, so there's no `--install` — `connect` prints the
exact values to paste in step 4.)

## 4. Add the connector in Perplexity

1. Open Perplexity (requires Pro subscription).
2. Go to **Settings → Connectors** (or **MCP Servers**).
3. Add a new remote connector:
   - **URL:** `https://YOUR-DOMAIN.ngrok.app/mcp`
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
