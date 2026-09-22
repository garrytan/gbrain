# Remote MCP Deployment Options

GBrain's MCP server runs via `gbrain serve` (stdio transport). To make it
accessible from other devices and AI clients, run `gbrain serve --http`
(built-in HTTP transport with OAuth 2.1 + bearer auth, works on both PGLite
and Postgres brains — see [DEPLOY.md](DEPLOY.md)) behind an HTTPS front.
Tailscale is the recommended front; here is how the options compare.

## Tailscale (recommended) — `gbrain mcp expose`

[Tailscale](https://tailscale.com) gives your computer a permanent MagicDNS
name with automatic TLS, free for personal use. `gbrain mcp expose` sets the
whole thing up on the brain host — installs Tailscale after a consent prompt,
signs in, publishes the server, provisions the admin token file, installs a
user service, and prints the MCP URL. Two reach modes, one flag apart:

| | `tailscale serve` (default) | `tailscale funnel` (`--funnel`) |
|--|---|---|
| Reachable from | Your tailnet only | The public internet |
| Best for | Your own devices — Claude Desktop, coding agents on another laptop, phone apps on the tailnet; nothing exposed | Cloud agents that must reach you — Grok Bot, Muse, ChatGPT, Claude.ai / Cowork, Perplexity Computer |
| Protection | Tailscale ACLs + gbrain auth | gbrain OAuth/bearer + least-privilege grants |
| Docs | [Tailscale Serve](https://tailscale.com/kb/1312/serve) | [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) |

```bash
gbrain mcp expose            # tailnet-only
gbrain mcp expose --funnel   # public HTTPS for cloud agents
gbrain mcp expose --status   # re-check service, publish config, health
# Your brain is at https://your-machine.your-tailnet.ts.net/mcp
```

**Say to your agent:** *"put my brain on tailscale"* — *"use my brain over
mcp"*.

The manual equivalent (what `expose` runs for you) keeps the default
`127.0.0.1` bind because Tailscale terminates TLS and forwards to loopback:

```bash
gbrain serve --http --port 3131 --public-url https://your-machine.your-tailnet.ts.net
tailscale serve --bg 3131      # tailnet-only
tailscale funnel --bg 3131     # public
```

Steps, flags, `--remove`, the client hand-off and the troubleshooting table
live in the [remote MCP guide](../guides/remote-mcp.md). For a plain-HTTP,
bearer-only LAN endpoint with no TLS at all, see
[DEPLOY.md — Tailnet / LAN-only](DEPLOY.md#tailnet--lan-only-no-public-tunnel).

## ngrok (alternative)

[ngrok](https://ngrok.com) provides instant public tunnels. The Hobby tier
($8/mo) gives you a fixed domain that never changes. Every ngrok tunnel is
public, so treat it like Funnel: least-privilege grants per client.

```bash
# 1. Install ngrok
brew install ngrok

# 2. Start the built-in HTTP transport with the ngrok issuer
gbrain serve --http --port 8787 --public-url https://your-brain.ngrok.app
# See docs/mcp/DEPLOY.md for token setup

# 3. Expose via ngrok
ngrok http 8787 --url your-brain.ngrok.app
```

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for full setup
including auth token configuration and fixed domain setup.

## Fly.io / Railway (always-on)

For production deployments that need to run 24/7 without your machine:

- **Fly.io:** $5-10/mo, global edge, `fly deploy`
- **Railway:** $5/mo, git push deploy

Both run Bun natively. No bundling, no Deno, no cold start, no timeout limits.
Pair them with a Postgres engine and set `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` through
the platform's secret store ([DEPLOY.md](DEPLOY.md#oauth-21-setup)).

## Comparison

| | Tailscale | ngrok | Fly.io/Railway |
|--|---|---|---|
| Cost | Free | $8/mo (Hobby) | $5-10/mo |
| Fixed URL | Yes | Yes (Hobby) | Yes |
| Private by default | Yes (tailnet-only; Funnel is opt-in) | No (always public) | No (always public) |
| Works when laptop is off | No | No | Yes |
| Keeps the server running | Yes (`gbrain mcp expose` installs a user service) | You manage it | Platform supervisor |
| Cold start | None | None | None |
| Timeout limits | None | None | None |
| Full remote operation surface (100+ ops, minus `localOnly`) | Yes | Yes | Yes |
| Setup time | 5 min (one command) | 5 min | 15 min |

**Note:** `gbrain serve --http` is the built-in HTTP transport. OAuth 2.1 plus
bearer auth against the `access_tokens` table, default-deny CORS, two-bucket rate
limit, body cap, per-request audit log. Works on both PGLite and Postgres brains.
See [DEPLOY.md](DEPLOY.md) and [SECURITY.md](../../SECURITY.md) for env vars and
tunables.
