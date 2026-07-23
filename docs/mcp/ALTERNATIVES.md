# Remote MCP Deployment Options

GBrain's MCP server runs via `gbrain serve` (stdio transport). To make it
accessible from other devices and AI clients, run `gbrain serve --http`
(built-in HTTP transport with OAuth 2.1, scoped operations, and legacy bearer
compatibility; see
[DEPLOY.md](DEPLOY.md)) behind a public tunnel. Here are your tunnel options.

## ngrok (recommended)

[ngrok](https://ngrok.com) provides instant public tunnels. The Hobby tier
($8/mo) gives you a fixed domain that never changes.

Install ngrok, then run the server and tunnel in separate terminals:

```bash
brew install ngrok
```

Terminal 1:

```bash
# Keep the same-host upstream on loopback.
gbrain serve --http --port 8787 \
  --public-url https://your-brain.ngrok.app
```

Terminal 2:

```bash
ngrok http 8787 --url your-brain.ngrok.app
```

See [`DEPLOY.md`](DEPLOY.md) for client registration and authentication.

If ngrok gives you an ephemeral URL, restart `gbrain serve` with that exact
`--public-url` before registering OAuth clients or connecting cloud MCP clients.

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
| Remote MCP tools | Current non-`localOnly` tools | Current non-`localOnly` tools | Current non-`localOnly` tools |
| Setup time | 5 min | 10 min | 15 min |

**Note:** `gbrain serve --http` is the built-in HTTP transport. It supports
OAuth 2.1, legacy bearer tokens, default-deny CORS, two-bucket rate limiting,
body caps, and per-request audit logs through the active engine. PGLite can run
the HTTP server for local/default or small self-hosted cases; use Postgres or
Supabase for shared, large, multi-machine, or always-on production deployments.
See [DEPLOY.md](DEPLOY.md) and [SECURITY.md](../../SECURITY.md) for env vars and
tunables.
