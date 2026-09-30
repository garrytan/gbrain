# Connect GBrain to Claude Desktop

This page covers connecting Claude Desktop to a **remote** brain. For a brain
on the same machine as Claude Desktop, a local stdio entry in
`claude_desktop_config.json` with `"command": "gbrain", "args": ["serve"]`
works too — but only against a full local install, never a thin-client one.

For remote setup, first select [native OAuth/PKCE or a private machine
handoff](../guides/hosted-harness-access.md) according to the connection settings
available in your installed Claude product. To open the owner dashboard or
manage its clients, use [MCP administration](ADMIN.md); the harness's OAuth
scope does not grant that authority.

**Important:** Claude Desktop does NOT connect to remote MCP servers via
`claude_desktop_config.json`. That file only works for local stdio servers.
Remote HTTP servers must be added through the GUI.

**Say to your agent:** *"connect claude desktop to my brain"* — on the brain
host, the `remote-mcp` skill publishes with `gbrain mcp expose` when needed,
then [MCP administration](ADMIN.md) supplies the URL and setup for your chosen
authentication method. You finish in the Claude Desktop GUI below.

## 1. Publish the brain (host side)

Claude Desktop runs on your own device, so the tailnet-only default is enough
— nothing is exposed to the public internet:

```bash
gbrain mcp expose   # prints https://your-machine.your-tailnet.ts.net/mcp
```

If the brain already has an HTTPS endpoint, use it instead. Register a native
OAuth client or provision a private machine handoff through the running
server's [owner API](ADMIN.md#register-and-connect-a-client), according to the
installed client's settings. The expose-managed owner credential is at
`~/.gbrain/serve/admin-token`; it is never a client credential.

**Say to your agent:** *"put my brain on tailscale"* — *"connect claude desktop
to my brain"*.

> **Legacy bearer settings on PGLite:** `gbrain auth create "claude-desktop"
> --scopes read,write` opens the database, which fails with
> `live_serve` while the expose-managed service holds it. Mint the token
> **before** the service runs (ahead of `gbrain mcp expose`, or while the service
> is stopped briefly), or provision through the running server instead —
> `gbrain mcp grant … --admin-token-file ~/.gbrain/serve/admin-token` or the
> `/admin` dashboard. Postgres brains mint fine while the server runs.

The device running Claude Desktop must be on the same tailnet (Tailscale
installed and signed in). Full walkthrough and troubleshooting:
[remote MCP guide](../guides/remote-mcp.md). Using ngrok instead? Its URL is
`https://YOUR-DOMAIN.ngrok.app/mcp` ([ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)).

## 2. Add the integration

1. Open Claude Desktop
2. Go to **Settings > Integrations**
3. Click **Add Integration** (or **Add Connector**)
4. Enter the MCP server URL:
   ```
   https://your-machine.your-tailnet.ts.net/mcp
   ```
   Use your MagicDNS name as printed by `gbrain mcp expose`, or the existing
   HTTPS endpoint (ngrok alternative: `https://YOUR-DOMAIN.ngrok.app/mcp`).
5. Choose the authentication method that the settings support. For native OAuth,
   use the owner-issued client metadata and the [native connection
   procedure](../guides/hosted-harness-access.md#native-oauth-path). For an
   existing bearer connection, enter its private scoped token. Never enter the
   server's owner bootstrap credential as the MCP credential.
6. Save

## Verify

Start a new conversation and try:

```
Search my brain for [any topic]
```

Observe the actual GBrain tool call and result. A saved configuration alone does
not establish that this Claude Desktop session loaded or connected the server.

## Common Mistakes

**Using claude_desktop_config.json for remote servers** — this silently fails
with no error message. The JSON config only works for local stdio MCP servers.
Remote HTTP servers must be added via Settings > Integrations in the GUI.

**Using the wrong URL** — make sure the URL ends with `/mcp` (not `/health`
or just the base domain).

**Name does not resolve on this device** — the device is not on the tailnet,
or MagicDNS is off for it. Sign in to Tailscale on the device and enable "Use
Tailscale DNS settings"; `gbrain mcp expose --status` on the host confirms
the server side. See the [troubleshooting table](../guides/remote-mcp.md#troubleshooting).
