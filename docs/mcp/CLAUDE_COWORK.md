# Connect GBrain to Claude Cowork

Two ways to get GBrain into Cowork sessions:

## Option 1: Remote (via self-hosted server + tunnel)

For Team/Enterprise plans, an org Owner adds the connector:

1. Go to **Organization Settings > Connectors**
2. Add a new connector with the MCP server URL:
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
3. Add Bearer token authentication in Advanced Settings
   (create one with `gbrain auth create "cowork"`)
4. Save

Note: Cowork connects from Anthropic's cloud, not your device. Your server
must be publicly reachable (ngrok, Tailscale Funnel, or cloud-hosted).

## Option 2: Local Bridge (via Claude Desktop)

If you already have GBrain configured in Claude Desktop (via `gbrain serve`
stdio or a remote integration), Cowork gets access automatically. Claude
Desktop bridges local MCP servers into Cowork via its SDK layer.

This means: if `gbrain serve` is running and configured in Claude Desktop,
you don't need a separate server for Cowork.

## Which to use?

- **Remote server:** works even when your laptop is closed, available to all org members
- **Local Bridge:** zero extra setup if Claude Desktop already has GBrain, but requires your machine to be running
