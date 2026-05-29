# Cortex Company Brain

Cortex is a hosted, multi-tenant company brain for teams and AI agents. It gives each organization a scoped knowledge control plane: brains, sources, members, invites, skills, runtime manifests, OAuth clients, and MCP access all live behind one Cortex-branded SaaS console.

The product model is:

```text
Organization -> one or more brains -> sources -> members, agents, skills, jobs, integrations
```

Companies can create multiple brains for teams, departments, customers, or environments. Agents receive scoped onboarding URLs and OAuth credentials so they can connect to the right brain without seeing internal operator setup.

## What Works

- Public signup and hosted onboarding at `/admin/signup` and `/admin/onboarding`.
- Team invites with role, source, federated-read scope, and delivery outbox status.
- Agent registration with one-time client secrets and MCP-ready OAuth clients.
- Runtime manifests for Cursor, Claude Desktop, Claude Code, ChatGPT, Perplexity, and generic MCP clients.
- Composio ingestion status and webhook surface for third-party connectors.
- Skills policy controls, promotion workflows, and audit events in the admin UI.
- Cortex-only product copy for the console, CLI commands, manifests, and hosted API responses.

## Hosted Quick Start

1. Deploy Cortex with a Supabase Postgres `CORTEX_DATABASE_URL`.
2. Set `CORTEX_PUBLIC_URL` to the public origin.
3. Set `CORTEX_ADMIN_BOOTSTRAP_TOKEN` to a stable 32+ character secret.
4. Open `https://your-cortex-host/admin/signup`.
5. Create an organization. The signup response includes an onboarding URL, an OAuth client id, a one-time client secret, and a `cortex connect` command.
6. Invite teammates and agents from the Team or Agents screens.
7. Connect ingestion providers from Integrations. Composio webhooks should point at `/webhooks/composio`.

Agents can perform the same flow over HTTP:

```bash
curl -s https://your-cortex-host/admin/api/signup \
  -H 'content-type: application/json' \
  -d '{"orgName":"Company name","email":"owner@company.com","domain":"company.com"}'
```

The response includes:

- `onboarding_url`
- `client_id`
- `client_secret`
- `connectCommand`
- `runtime_manifest`
- `invite_delivery`

## CLI

Hosted tenants should use Cortex commands:

```bash
cortex connect 'https://your-cortex-host/admin/onboarding?invite=...' --client-secret '...'
cortex runtime install cursor --manifest-url https://your-cortex-host/runtime-manifest.json
cortex runtime install cursor --mcp-url https://your-cortex-host/mcp
cortex runtime install claude-desktop --mcp-url https://your-cortex-host/mcp
cortex runtime install chatgpt --mcp-url https://your-cortex-host/mcp
```

Operator-only service setup still uses:

```bash
cortex init --supabase
cortex serve --http --public-url https://your-cortex-host
```

## SaaS Environment

Use `.env.saas.example` as the deployment template. New deployments should use `CORTEX_*` names:

```bash
CORTEX_DATABASE_URL=postgresql://...
CORTEX_PUBLIC_URL=https://your-cortex-host
CORTEX_HTTP_CORS_ORIGIN=https://your-cortex-host
CORTEX_HTTP_TRUST_PROXY=1
CORTEX_ADMIN_BOOTSTRAP_TOKEN=...
CORTEX_SUPPRESS_BOOTSTRAP_TOKEN=1
CORTEX_COMPOSIO_WEBHOOK_SECRET=...
COMPOSIO_API_KEY=...
CORTEX_EMAIL_PROVIDER=resend
RESEND_API_KEY=...
CORTEX_EMAIL_FROM="Cortex <onboarding@your-domain.com>"
CORTEX_EMAIL_DELIVERY_SECRET=...
```

For Railway, run one public web service and, when needed, a worker service. Use
`bun run railway:apply-env -- --env-file .env.saas --manifest deploy/saas/company-brain.yml --web-service <web> --worker-service <worker> --strict-preflight`
so SaaS preflight runs before variables are applied and each service receives
the correct `CORTEX_PROCESS` role.

## Agent Parity

Every major UI action has an agent-callable equivalent:

| UI action | API or command |
| --- | --- |
| Create organization | `POST /admin/api/signup` (`POST /api/signup` remains compatible) |
| Create brain | `POST /admin/api/brains` |
| Invite teammate | `POST /admin/api/invites` |
| Inspect invite delivery | `GET /admin/api/invite-deliveries` |
| Claim invite delivery batch | `POST /admin/api/invite-deliveries/claim` |
| Mark invite delivery result | `POST /admin/api/invite-deliveries/:id/result` |
| Send invite delivery batch | `POST /admin/api/invite-deliveries/drain` or `POST /jobs/invite-deliveries/drain` |
| Register agent | `POST /admin/api/register-client` |
| Get runtime manifest | `GET /admin/api/runtime-manifest` |
| Install runtime | `cortex runtime install <target>` |
| Connect runtime | `cortex connect <onboarding-url>` |
| List integrations | `GET /admin/api/integrations` |
| Receive Composio ingest event | `POST /webhooks/composio` |
| Use MCP | `POST /mcp` with OAuth bearer token |

## UI

The admin console is a Next.js App Router static export mounted at `/admin`. It uses shadcn components and the V0-designed Cortex dashboard shell:

- Overview
- Onboarding
- Brains
- Sources
- Team
- Invites
- Agents
- Skills
- Jobs
- Activity
- Integrations
- Runtime
- Quality
- Settings

Build and embed it with:

```bash
bun run build:admin
```

## Verification

Core checks used for SaaS readiness:

```bash
bun run build:admin
bun run tsc --noEmit --pretty false
bun test test/runtime-install.test.ts test/connect-onboarding.test.ts test/saas-agent-control-plane.test.ts test/saas-control-plane.test.ts test/users-register-agent-client.test.ts test/saas-skill-policy-dispatch.test.ts test/cli.test.ts
```

For live smoke testing, open:

```text
https://your-cortex-host/
https://your-cortex-host/admin/signup
https://your-cortex-host/admin/overview
https://your-cortex-host/admin/integrations
https://your-cortex-host/admin/runtime
https://your-cortex-host/admin/quality
```

Or run the full hosted contract smoke:

```bash
CORTEX_PUBLIC_URL=https://your-cortex-host \
CORTEX_ADMIN_BOOTSTRAP_TOKEN=... \
CORTEX_COMPOSIO_WEBHOOK_SECRET=... \
CORTEX_BILLING_WEBHOOK_SECRET=... \
bun run smoke:saas-live
```

The smoke covers signup, onboarding, invite delivery outbox records, delivery
claim/result updates, provider drain readiness, billing webhook reconciliation,
Composio ingestion, OAuth token exchange, and hosted MCP tool discovery.
