# Connect GBrain to Claude Desktop

This page covers connecting Claude Desktop to a **remote** brain. For a brain
on the same machine as Claude Desktop, a local stdio entry in
`claude_desktop_config.json` with `"command": "gbrain", "args": ["serve"]`
works too — but only against a full local install, never a thin-client one.

**Important:** Claude Desktop does NOT connect to remote MCP servers via
`claude_desktop_config.json`. That file only works for local stdio servers.
Remote HTTP servers must be added through the GUI.

**Say to your agent:** *"connect claude desktop to my brain"* — on the brain
host, the `remote-mcp` skill runs `gbrain mcp expose` and hands you the URL and
a token; you finish in the Claude Desktop GUI below.

## 1. Publish the brain (host side)

Claude Desktop runs on your own device, so the tailnet-only default is enough
— nothing is exposed to the public internet:

```bash
gbrain auth create "claude-desktop"    # bearer token for step 2 (or a scoped OAuth client, see DEPLOY.md)
gbrain mcp expose                      # prints https://your-machine.your-tailnet.ts.net/mcp
```

**Say to your agent:** *"put my brain on tailscale"* — *"connect claude desktop
to my brain"*.

> **PGLite brains:** `gbrain auth create` opens the database, which fails with
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
   (your MagicDNS name as printed by `gbrain mcp expose`; ngrok alternative:
   `https://YOUR-DOMAIN.ngrok.app/mcp`)
5. Set authentication to **Bearer Token** and paste your token
   (create one with `gbrain auth create "claude-desktop"`)
6. Save

## Verify

Start a new conversation and try:

```
Search my brain for [any topic]
```

Claude Desktop will use your GBrain tools automatically.

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
