# Remote MCP Deployment Options

GBrain's MCP server runs via `gbrain serve` (stdio transport). To make it
accessible from other devices and AI clients, run `gbrain serve --http`
(built-in HTTP transport with OAuth 2.1 + bearer auth, works on both PGLite
and Postgres brains — see [DEPLOY.md](DEPLOY.md)) behind a public tunnel.
Here are your tunnel options.

## ngrok (recommended)

[ngrok](https://ngrok.com) provides instant public tunnels. The Hobby tier
($8/mo) gives you a fixed domain that never changes.

```bash
# 1. Install ngrok
brew install ngrok

# 2. Start the built-in HTTP transport
gbrain serve --http --port 8787
# See docs/mcp/DEPLOY.md for token setup

# 3. Expose via ngrok
ngrok http 8787 --url your-brain.ngrok.app
```

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for full setup
including auth token configuration and fixed domain setup.

## Tailscale Serve (tailnet-only) / Funnel (public)

[Tailscale](https://tailscale.com) gives you a permanent MagicDNS name with
automatic TLS. Free tier available. Two modes, one command apart:

| | `tailscale serve` | `tailscale funnel` |
|--|---|---|
| Reachable from | Your tailnet only | The public internet |
| Best for | Your own devices; nothing exposed | Cloud connectors (ChatGPT, Claude.ai) that must reach you |
| Docs | [Tailscale Serve](https://tailscale.com/kb/1312/serve) | [Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel) |

```bash
# 1. Install Tailscale
brew install tailscale

# 2. Start gbrain with the HTTPS issuer Tailscale presents (default 127.0.0.1 bind is right)
gbrain serve --http --port 8787 --public-url https://your-machine.your-tailnet.ts.net

# 3a. Tailnet-only
tailscale serve --bg 8787
# 3b. Public
tailscale funnel 8787
# Your brain is now at https://your-machine.your-tailnet.ts.net/mcp
```

For a plain-HTTP, bearer-only LAN endpoint with no TLS at all, see
[DEPLOY.md — Tailnet / LAN-only](DEPLOY.md#tailnet--lan-only-no-public-tunnel).

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
| Full remote operation surface (100+ ops, minus `localOnly`) | Yes | Yes | Yes |
| Setup time | 5 min | 10 min | 15 min |

**Note:** `gbrain serve --http` is the built-in HTTP transport. OAuth 2.1 plus
bearer auth against the `access_tokens` table, default-deny CORS, two-bucket rate
limit, body cap, per-request audit log. Works on both PGLite and Postgres brains.
See [DEPLOY.md](DEPLOY.md) and [SECURITY.md](../../SECURITY.md) for env vars and
tunables.
