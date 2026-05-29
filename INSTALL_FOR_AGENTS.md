# Cortex Onboarding Guide For AI Agents

Use this guide when an agent is asked to connect a company, teammate, or agent
runtime to Cortex.

## What You Are Installing

Cortex is a hosted multi-tenant company-brain SaaS. You are not installing a
personal local knowledge base by default. Your job is to help the organization
create or join a hosted tenant, receive scoped OAuth credentials, and configure
the runtime to use the tenant's MCP endpoint.

## Inputs You Need

- Cortex tenant host, for example `https://brain.acme.ai`.
- Organization name and owner email if creating a tenant.
- Optional company domain.
- The target runtime: Cursor, Claude Desktop, Claude Code, ChatGPT, Perplexity,
  or a generic MCP client.
- A one-time client secret if the tenant/invite was already created.

## Step 1: Create Or Join The Organization

If the organization does not exist, create it through the public signup API:

```bash
curl -s https://<tenant-host>/api/signup \
  -H 'content-type: application/json' \
  -d '{"orgName":"Acme AI","email":"founder@acme.test","domain":"acme.test"}'
```

The response should include:

- `onboarding_url`
- `client_id`
- `client_secret`
- `connectCommand`
- `runtime_manifest`
- `invite_delivery`

If the organization already exists, ask an owner/admin to create an invite from
`/admin/team`, `/admin/invites`, or `/admin/agents`. Agents with `users_admin`
scope can also call `users_create_invite` or `users_register_agent_client`.

## Step 2: Inspect The Onboarding URL

The URL shape is:

```text
https://<tenant-host>/admin/onboarding?invite=<base64url-json>
```

Decode the invite payload when needed. It should contain tenant metadata such as
organization, brain, MCP URL, token URL, client id, write source, federated-read
sources, scopes, and role.

The URL must not contain `client_secret`. If a secret appears in the URL, stop and
rotate that client before continuing.

## Step 3: Connect The Cortex CLI Profile

Run the one-time connect command:

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
```

This stores the tenant endpoint and OAuth client metadata locally. It does not
write the secret into runtime config files.

## Step 4: Install Runtime Config

Use the hosted runtime manifest whenever possible:

```bash
cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-desktop --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-code --manifest-url https://<tenant-host>/runtime-manifest.json
```

For a runtime that cannot consume the manifest directly, use the MCP and OAuth
metadata from the onboarding payload:

```text
MCP URL:   https://<tenant-host>/mcp
Token URL: https://<tenant-host>/token
Client ID: cortex_cl_...
Scopes:    read write
```

## Step 5: Verify Access

Ask the runtime to list tools or call the hosted MCP endpoint with OAuth. The
hosted smoke test covers the full SaaS path:

```bash
CORTEX_PUBLIC_URL=https://<tenant-host> \
CORTEX_ADMIN_BOOTSTRAP_TOKEN=<token> \
CORTEX_COMPOSIO_WEBHOOK_SECRET=<secret> \
CORTEX_BILLING_WEBHOOK_SECRET=<secret> \
bun run smoke:saas-live -- --json
```

Expected coverage:

- Public signup creates org, brain, member, owner client, invite, and onboarding
  URL.
- Admin session works from the bootstrap token.
- Owner onboarding and teammate invite delivery records are queued in the
  delivery outbox.
- Delivery records can be claimed and marked sent or failed by a provider worker
  or `users_admin` agent.
- Provider delivery can be drained through Resend when `CORTEX_EMAIL_PROVIDER`,
  `RESEND_API_KEY`, `CORTEX_EMAIL_FROM`, and `CORTEX_EMAIL_DELIVERY_SECRET` are
  configured.
- Team invite returns an onboarding URL and one-time secret.
- Sources can be created and listed.
- Skills can be listed and policy-updated.
- Agent clients can be registered and token-exchanged.
- Billing webhooks reconcile plan state idempotently.
- Composio webhook ingestion is accepted.
- MCP `tools/list` returns Cortex tools through the hosted endpoint.

## Step 6: Invite Teammates And Agents

Use sources for normal team/topic/repo boundaries. Use another brain only when
ownership, lifecycle, backup, residency, or admin boundaries differ.

Every invite should specify:

- Role: `owner`, `admin`, `member`, or `viewer`.
- Write source.
- Federated-read sources.
- OAuth scopes.
- Optional welcome note.

## Troubleshooting

- **No `client_id` in payload:** this is a legacy provisioning receipt, not a
  connectable runtime invite. Create a fresh invite or agent client.
- **Runtime asks for a bearer token:** prefer OAuth metadata from the invite or
  manifest. Legacy bearer tokens are migration-only.
- **MCP issuer mismatch:** confirm `CORTEX_PUBLIC_URL` matches the public origin
  clients use.
- **Prepared statement errors on Supabase pooler:** use
  `?prepare=false` or `CORTEX_PREPARE=false`.
- **Direct Supabase IPv6 fails on Railway:** keep `CORTEX_DISABLE_DIRECT_POOL=1`
  and use the Supavisor pooler host.

## Agent Parity

Anything visible in the console should have an agent path. Key MCP operations:

- `saas_signup_create`
- `saas_orgs_list`
- `saas_orgs_create`
- `saas_brains_list`
- `saas_brains_create`
- `saas_team_list`
- `saas_invites_list`
- `saas_invite_deliveries_list`
- `saas_invite_delivery_queue`
- `saas_invite_deliveries_claim`
- `saas_invite_delivery_mark`
- `saas_skills_list`
- `saas_skills_upsert`
- `saas_runtime_manifest`
- `saas_plan_get`
- `saas_plan_update`
- `saas_console_snapshot`
- `users_create_invite`
- `users_register_agent_client`
- `users_update_agent_client_ttl`
- `users_revoke_agent_client`

Keep all user-facing copy Cortex-branded. Legacy names are acceptable only as
implementation compatibility aliases.
