# Connect GBrain to Claude Code

## Option 1: Local (recommended, zero server needed)

```bash
claude mcp add gbrain -- gbrain serve
```

That's it. Claude Code spawns `gbrain serve` as a stdio subprocess. No server, no
tunnel, no token needed. Works with both PGLite and Supabase engines.

## Option 2: Remote (access from any machine)

If you have GBrain running on a server with a public tunnel (see
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)):

```bash
claude mcp add gbrain -t http \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Replace `YOUR-DOMAIN` with your ngrok domain and `YOUR_TOKEN` with a token
from `gbrain auth create "claude-code"`.

## Verify

In Claude Code, try:

```
search for [any topic in your brain]
```

You should see results from your GBrain knowledge base.

## Remove

```bash
claude mcp remove gbrain
```

## Source Pinning (stdio transport)

When using the stdio transport (`command: gbrain serve`), you can pin all
tool calls to a specific source by setting the `GBRAIN_SOURCE` env var in
your MCP config:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"],
      "env": {
        "GBRAIN_SOURCE": "reisponde"
      }
    }
  }
}
```

This sets `defaultSourceId` on every `OperationContext`, equivalent to the
OAuth token-pin mechanism used by the HTTP transport. Precedence:
`params.source_id` (explicit per-call) > `GBRAIN_SOURCE` env (session pin) > unscoped.
