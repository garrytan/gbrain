# Headless Cortex Deployment

Headless setup is for operators deploying the hosted Cortex SaaS runtime in
Docker, Railway, CI, or another server environment. It is not the user onboarding
path. Users and agents connect through onboarding URLs and runtime manifests.

## Required Environment

```text
CORTEX_DATABASE_URL=postgresql://...
CORTEX_PUBLIC_URL=https://<tenant-host>
CORTEX_ADMIN_BOOTSTRAP_TOKEN=<strong-token>
CORTEX_COMPOSIO_WEBHOOK_SECRET=<shared-secret>
CORTEX_BILLING_WEBHOOK_SECRET=<shared-secret>
CORTEX_EMAIL_DELIVERY_SECRET=<shared-secret>
CORTEX_EMAIL_PROVIDER=resend
CORTEX_EMAIL_FROM='Cortex <onboarding@your-domain.com>'
RESEND_API_KEY=<provider-key>
```

Add model and ingestion provider keys according to the tenant plan.

## Docker Shape

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:admin

EXPOSE 3131
CMD ["bun", "run", "src/cli.ts", "serve", "--http", "--bind", "0.0.0.0", "--port", "3131"]
```

Run migrations in a release phase when the host supports it. If not, set the
startup migration flag only for environments where release phases are not
available.

## Runtime Start

```bash
cortex serve --http \
  --bind 0.0.0.0 \
  --port 3131 \
  --public-url "$CORTEX_PUBLIC_URL"
```

The public URL must match the URL customers and agents use. OAuth discovery,
token URLs, onboarding payloads, and runtime manifests all derive from it.

## CI Preflight

Run before deployment:

```bash
bun run tsc --noEmit --pretty false
bun run build:admin
bun run build:llms
bash scripts/check-cortex-public-copy.sh
bun run saas:preflight
```

The preflight should fail on placeholder database URLs, unsafe shell-job env,
non-HTTPS public URLs, missing secrets, or invalid pooler configuration.

## Post-Deploy Smoke

```bash
curl https://<tenant-host>/health
curl https://<tenant-host>/runtime-manifest.json
bun run smoke:saas-live -- --json
```

The smoke must verify signup, owner onboarding URL, invite delivery outbox,
source creation, skill policy, agent OAuth, Composio webhook ingestion, token
exchange, and MCP `tools/list`.

## Customer Onboarding

After deployment, give customers and agents:

- `/admin/signup`
- owner onboarding URL
- one-time client secret
- `/runtime-manifest.json`
- `cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'`

Do not give customers database credentials unless they are operating their own
dedicated deployment.
