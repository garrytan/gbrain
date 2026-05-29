# Agents Working On Cortex

This is the operating protocol for agents implementing, verifying, or onboarding
the Cortex multi-tenant company-brain SaaS.

## Product Shape

Cortex is not a personal local brain install. Treat it as a hosted SaaS control
plane:

```text
Organization -> one or more brains -> sources -> members, agents, skills, jobs, integrations
```

- **Organization** is the customer tenant.
- **Brain** is the database/deployment boundary. Companies can create multiple
  brains when ownership, lifecycle, backup, residency, or admin boundaries differ.
- **Source** is the team/topic/repo/customer boundary inside one brain.
- **Agent client** is an OAuth client with a write source, federated-read list,
  scopes, and a runtime manifest.

For the detailed model, read
[`docs/architecture/brains-and-sources.md`](./docs/architecture/brains-and-sources.md)
and [`docs/tutorials/company-brain.md`](./docs/tutorials/company-brain.md).

## Agent Onboarding

Start with the hosted flow unless the user explicitly asks for local operator
development:

1. Open or call `https://<tenant-host>/admin/signup`.
2. Create the organization with org name, owner email, and optional domain.
3. Save the returned onboarding URL, client id, one-time client secret, and
   `cortex connect` command.
4. Invite teammates or agent runtimes from the Team, Invites, or Agents surfaces.
5. Install runtime config from the hosted manifest:

```bash
cortex connect 'https://<tenant-host>/admin/onboarding?invite=...' --client-secret '<one-time-secret>'
cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-desktop --manifest-url https://<tenant-host>/runtime-manifest.json
```

The onboarding URL must never contain `client_secret`. Secrets are shown once by
the console or returned once to the creating agent.

## Read This Order

1. [`README.md`](./README.md) - product overview, hosted quick start, and API map.
2. [`INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) - hosted tenant onboarding
   steps for AI agents.
3. [`docs/deploy/multi-tenant-saas.md`](./docs/deploy/multi-tenant-saas.md) -
   production deployment and tenant model.
4. [`docs/deploy/saas-runtime-packaging.md`](./docs/deploy/saas-runtime-packaging.md) -
   onboarding URL, runtime manifest, and agent parity contracts.
5. [`docs/tutorials/company-brain.md`](./docs/tutorials/company-brain.md) -
   company-brain setup and team/source scoping.
6. [`docs/mcp/DEPLOY.md`](./docs/mcp/DEPLOY.md) - hosted HTTP MCP and OAuth setup.
7. [`llms.txt`](./llms.txt) - generated map of Cortex docs for single-fetch agents.

## Trust Boundary

Cortex distinguishes trusted local operator calls from untrusted remote agent
calls:

- Local CLI callers set `OperationContext.remote = false`.
- HTTP/MCP callers set `remote = true`.
- Security-sensitive operations must enforce source scoping, OAuth scopes, and
  remote filesystem confinement.

Before changing an operation, inspect `src/core/operations.ts` and the MCP
dispatcher path. Anything a human can do in the console should also have an
agent-callable API or MCP operation with equivalent scope checks.

## Common Tasks

- **Create a tenant:** `POST /api/signup` or the `/admin/signup` UI.
- **Invite a teammate:** `POST /admin/api/invites` or MCP `users_create_invite`.
- **Inspect invite delivery:** `GET /admin/api/invite-deliveries` or MCP
  `saas_invite_deliveries_list`.
- **Run invite delivery worker steps:** `POST /admin/api/invite-deliveries/claim`
  plus `POST /admin/api/invite-deliveries/:id/result`, or MCP
  `saas_invite_deliveries_claim` / `saas_invite_delivery_mark`.
- **Send invite delivery through provider:** `POST /admin/api/invite-deliveries/drain`
  from the console, `POST /jobs/invite-deliveries/drain` from a worker with
  `CORTEX_EMAIL_DELIVERY_SECRET`, or MCP `saas_invite_deliveries_drain`.
- **Register an agent client:** `POST /admin/api/register-client` or MCP
  `users_register_agent_client`.
- **Fetch runtime setup:** `GET /runtime-manifest.json`,
  `GET /admin/api/runtime-manifest`, or MCP `saas_runtime_manifest`.
- **Inspect/update plan limits:** `GET/POST /admin/api/plan` or MCP
  `saas_plan_get` / `saas_plan_update`.
- **Verify hosted SaaS:** `bun run smoke:saas-live -- --json`.
- **Build the Next.js admin UI:** `bun run build:admin`.
- **Typecheck:** `bun run tsc --noEmit --pretty false`.

## Brand Rule

User-facing copy, generated docs, hosted responses, commands, and runtime
instructions should say **Cortex**. Legacy environment aliases may exist only as
implementation compatibility shims in code and tests.

## Before Shipping

Run the narrowest meaningful verification for the change, then broaden when the
surface is shared:

```bash
bun test test/saas-live-smoke.test.ts test/saas-agent-control-plane.test.ts
bun run tsc --noEmit --pretty false
bun run build:admin
```

For hosted proof, run:

```bash
CORTEX_PUBLIC_URL=https://<tenant-host> \
CORTEX_ADMIN_BOOTSTRAP_TOKEN=<token> \
CORTEX_COMPOSIO_WEBHOOK_SECRET=<secret> \
CORTEX_BILLING_WEBHOOK_SECRET=<secret> \
CORTEX_EMAIL_DELIVERY_SECRET=<secret> \
bun run smoke:saas-live -- --json
```

Do not regress the public signup, onboarding invite URL, invite delivery outbox,
team invite, agent client, skills policy, billing webhook, Composio webhook,
OAuth token, MCP tools/list, or runtime manifest paths.
