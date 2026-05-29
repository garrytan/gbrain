# Install And Connect Cortex

Cortex is a hosted multi-tenant SaaS. The normal path is not a personal local
install; it is a tenant signup or invite that gives a human or agent a scoped
OAuth client and runtime manifest.

## 1. Create A Tenant

Use the public signup endpoint or `/admin/signup`:

```bash
curl -s https://<tenant-host>/admin/api/signup \
  -H 'content-type: application/json' \
  -d '{"orgName":"Company name","email":"owner@company.com","domain":"company.com"}'
```

The response includes:

- organization
- first brain
- owner member
- OAuth client id
- one-time client secret
- onboarding URL
- runtime manifest
- `cortex connect` command
- invite delivery outbox record

## 2. Connect An Agent Runtime

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-desktop --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-code --manifest-url https://<tenant-host>/runtime-manifest.json
```

The onboarding URL never contains the secret. Runtime config files should point
at the hosted MCP URL and rely on OAuth token exchange.

## 3. Invite Teammates

Use the admin console or agent-callable APIs:

- `/admin/team`
- `/admin/invites`
- `/admin/agents`
- MCP `users_create_invite`
- MCP `users_register_agent_client`

Every invite should specify role, write source, federated-read sources, and
scopes. Cortex queues owner onboarding and teammate invite delivery records in
the outbox; production deployments can drain that table through Resend with
`CORTEX_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `CORTEX_EMAIL_FROM`, and a
worker guarded by `CORTEX_EMAIL_DELIVERY_SECRET`. Most teams should create more
sources inside the company brain rather than more brains. Create another brain
only when ownership, lifecycle, backup, residency, or admin boundaries differ.

## 4. Operator Deployment

Production operators deploy Cortex with Supabase Postgres and a web service:

```bash
CORTEX_DATABASE_URL='postgresql://...'
CORTEX_PUBLIC_URL='https://<tenant-host>'
CORTEX_HTTP_CORS_ORIGIN='https://<tenant-host>'
CORTEX_HTTP_TRUST_PROXY=1
CORTEX_ADMIN_BOOTSTRAP_TOKEN='<random-hex>'
CORTEX_SUPPRESS_BOOTSTRAP_TOKEN=1
CORTEX_EMAIL_PROVIDER=resend
RESEND_API_KEY='re_...'
CORTEX_EMAIL_FROM='Cortex <onboarding@your-domain.com>'
CORTEX_EMAIL_DELIVERY_SECRET='<random-hex>'
CORTEX_HOME=/data/cortex
cortex serve --http --public-url https://<tenant-host>
```

For Supabase pooler URLs, set:

```bash
CORTEX_DISABLE_DIRECT_POOL=1
CORTEX_PREPARE=false
```

See [Deploy Cortex as a Multi-Tenant SaaS](deploy/multi-tenant-saas.md).

## 5. Verify

```bash
CORTEX_PUBLIC_URL=https://<tenant-host> \
CORTEX_ADMIN_BOOTSTRAP_TOKEN=<token> \
CORTEX_COMPOSIO_WEBHOOK_SECRET=<secret> \
CORTEX_BILLING_WEBHOOK_SECRET=<secret> \
bun run smoke:saas-live -- --json
```

The smoke verifies public marketing, signup, owner onboarding, admin session,
tenant plan controls, billing webhook reconciliation, teammate invite, invite
delivery outbox records, delivery claim/result updates, provider drain
readiness, source creation, skill policy update, agent OAuth client, Composio
webhook ingestion, token exchange, and MCP `tools/list`.

For local operator diagnostics:

```bash
cortex doctor --json
cortex models doctor
```

## Runtime Contract

The same setup metadata is available through:

- `GET /runtime-manifest.json`
- `GET /admin/api/runtime-manifest`
- MCP `saas_runtime_manifest`
- MCP `saas_plan_get` / `saas_plan_update`

See [SaaS Runtime Packaging](deploy/saas-runtime-packaging.md).
