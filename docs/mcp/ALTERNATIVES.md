# Remote MCP Deployment Options

GBrain's MCP server runs via `gbrain serve` (stdio transport). To make it
accessible from other devices and AI clients, you need an HTTP wrapper and
a public tunnel. Here are your options.

## ngrok (recommended)

[ngrok](https://ngrok.com) provides instant public tunnels. The Hobby tier
($8/mo) gives you a fixed domain that never changes.

```bash
# 1. Install ngrok
brew install ngrok

# 2. Start your MCP server (behind an HTTP wrapper)
# See docs/mcp/DEPLOY.md for the server setup

# 3. Expose via ngrok
ngrok http 8787 --url your-brain.ngrok.app
```

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for full setup
including auth token configuration and fixed domain setup.

## Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel) gives you
a permanent public HTTPS URL with automatic TLS. Free tier available. Best for
private networks where you control both endpoints.

```bash
# 1. Install Tailscale
brew install tailscale

# 2. Expose your MCP server
tailscale funnel 8787
# Your brain is now at https://your-machine.ts.net
```

## Fly.io / Railway (always-on)

For production deployments that need to run 24/7 without your machine:

- **Fly.io:** $5-10/mo, global edge, `fly deploy`
- **Railway:** $5/mo, git push deploy

Both run Bun natively. No bundling, no Deno, no cold start, no timeout limits.

## Comparison

| | ngrok | Tailscale | Fly.io/Railway |
|--|---|---|---|
| Cost | $8/mo (Hobby) | Free | $5-10/mo |
| Fixed URL | Yes (Hobby) | Yes | Yes |
| Works when laptop is off | No | No | Yes |
| Cold start | None | None | None |
| Timeout limits | None | None | None |
| All 30 operations | Yes | Yes | Yes |
| Setup time | 5 min | 10 min | 15 min |

**Note:** `gbrain serve --http` (built-in HTTP transport) is planned but not yet
implemented. Currently, remote MCP requires a custom HTTP wrapper around `gbrain serve`.
See [DEPLOY.md](DEPLOY.md) for details.
