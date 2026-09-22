# Connect GBrain to Claude Cowork

Two ways to get GBrain into Cowork sessions:

## Option 1: Remote (self-hosted server published over HTTPS)

Cowork connects from Anthropic's cloud, not your device, so the server must
be publicly reachable. On the brain host:

```bash
gbrain auth create "cowork"       # bearer token for step 3
gbrain mcp expose --funnel        # public HTTPS on your Tailscale name (Funnel is explicit; the default is tailnet-only)
```

**Say to your agent:** *"expose my brain over mcp"* — *"use my brain over mcp"*.

> **PGLite brains:** `gbrain auth create` opens the database, which fails with
> `live_serve` while the expose-managed service holds it. Mint the token
> **before** the service runs (ahead of `gbrain mcp expose`, or while the service
> is stopped briefly), or provision through the running server instead —
> `gbrain mcp grant … --admin-token-file ~/.gbrain/serve/admin-token` or the
> `/admin` dashboard. Postgres brains mint fine while the server runs.

[Remote MCP guide](../guides/remote-mcp.md) covers the consent prompt, the
user service and troubleshooting; ngrok or a cloud host also work
([ALTERNATIVES.md](ALTERNATIVES.md)).

For Team/Enterprise plans, an org Owner adds the connector:

1. Go to **Organization Settings > Connectors**
2. Add a new connector with the MCP server URL:
   ```
   https://your-machine.your-tailnet.ts.net/mcp
   ```
   (ngrok alternative: `https://YOUR-DOMAIN.ngrok.app/mcp`)
3. Add Bearer token authentication in Advanced Settings
   (create one with `gbrain auth create "cowork"`)
4. Save

## Option 2: Local Bridge (via Claude Desktop)

If you already have GBrain configured in Claude Desktop (via `gbrain serve`
stdio or a remote integration), Cowork gets access automatically. Claude
Desktop bridges local MCP servers into Cowork via its SDK layer.

This means: if `gbrain serve` is running and configured in Claude Desktop,
you don't need a separate server for Cowork.

## Verify

In a Cowork session, try:

```
Call get_brain_identity, then search my brain for [any topic]
```

You should get pages from your brain back. If `list_skills` returns nothing,
skill publishing is off on the host — enable it with
`gbrain config set mcp.publish_skills true` (see
[CLAUDE_CODE.md](CLAUDE_CODE.md) for the full gotcha).

## Which to use?

- **Remote server:** works even when your laptop is closed, available to all org members
- **Local Bridge:** zero extra setup if Claude Desktop already has GBrain, but requires your machine to be running
