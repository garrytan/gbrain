# Cortex MCP Hosting Options

Cortex's normal SaaS shape is a hosted HTTP MCP endpoint with OAuth discovery,
runtime manifests, source-scoped clients, and an admin console. Local tunnels
are useful for demos and development; production tenants should run on a stable
host and public URL.

## Preferred Production Shape

```bash
cortex serve --http \
  --public-url https://<tenant-host> \
  --bind 0.0.0.0 \
  --port 3131
```

Required production environment:

- `CORTEX_DATABASE_URL`
- `CORTEX_PUBLIC_URL`
- `CORTEX_ADMIN_BOOTSTRAP_TOKEN`
- `CORTEX_COMPOSIO_WEBHOOK_SECRET`
- `CORTEX_BILLING_WEBHOOK_SECRET`
- `CORTEX_EMAIL_DELIVERY_SECRET`
- email provider credentials
- model/provider credentials

## Hosting Options

| Host | Best For | Notes |
| --- | --- | --- |
| Railway | Quick app hosting and investor demos | Needs Railway auth and production secrets. |
| Docker | Customer-managed or internal deployments | Use the SaaS compose file and host secret manager. |
| Fly.io | Region-pinned lightweight deployments | Good for dedicated enterprise brains. |
| Vercel plus worker host | Marketing/admin front-end plus separate MCP runtime | MCP server still needs a long-running runtime. |
| Cloudflare tunnel | Temporary public development URL | Good for smoke tests, not permanent production. |

## Development Tunnel

For a temporary demo URL:

```bash
cortex serve --http --port 3131 --public-url https://<temporary-host>
cloudflared tunnel --url http://127.0.0.1:3131
```

The public URL must match `CORTEX_PUBLIC_URL` so OAuth discovery, onboarding
URLs, and the runtime manifest all point to the same host.

## Verify

```bash
curl https://<tenant-host>/health
curl https://<tenant-host>/runtime-manifest.json
bun run smoke:saas-live -- --json
```

The smoke must pass before using the deployment for a customer or investor demo.
