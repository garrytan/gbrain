# Connect GBrain to Nanobot

[Nanobot](https://github.com/HKUDS/nanobot) is an open-source, self-hosted AI agent with built-in MCP client support (stdio, SSE, and streamable HTTP transports). No adapter code needed — just add GBrain to your MCP server config.

## Local (recommended, zero server needed)

Add this to your `config.json`:

```json
{
  "mcp_servers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

Nanobot spawns `gbrain serve` as a stdio subprocess. No server, no tunnel, no token needed. Works with both PGLite and Supabase engines.

## Remote (access from any machine)

If you have GBrain running on a server with a public tunnel (see
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)):

```json
{
  "mcp_servers": {
    "gbrain": {
      "type": "streamableHttp",
      "url": "https://YOUR-DOMAIN.ngrok.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

Replace `YOUR-DOMAIN` with your ngrok domain and `YOUR_TOKEN` with a token
from `bun run src/commands/auth.ts create "nanobot"`.

## Verify

Restart nanobot, then ask:

```
search for [any topic in your brain]
```

You should see results from your GBrain knowledge base. Nanobot registers GBrain tools with the `mcp_gbrain_` prefix (e.g. `mcp_gbrain_search`, `mcp_gbrain_query`, `mcp_gbrain_get_page`).

## Skillpack (recommended)

Copy the relevant sections from [GBRAIN_SKILLPACK.md](../GBRAIN_SKILLPACK.md) into your nanobot skill or AGENTS.md so the agent knows WHEN and HOW to use each tool — read before responding, write after learning, detect entities on every message.
