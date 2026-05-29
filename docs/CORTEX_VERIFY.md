# Cortex SaaS Verification Runbook

This runbook verifies a hosted Cortex tenant. Use it after deploys, UI changes,
runtime packaging changes, and onboarding changes.

## 1. Hosted SaaS Smoke

```bash
CORTEX_PUBLIC_URL=https://<tenant-host> \
CORTEX_ADMIN_BOOTSTRAP_TOKEN=<token> \
CORTEX_COMPOSIO_WEBHOOK_SECRET=<secret> \
CORTEX_BILLING_WEBHOOK_SECRET=<secret> \
bun run smoke:saas-live -- --json
```

Expected checks:

- Marketing page is public and Cortex-branded.
- Signup page is public and Cortex-branded.
- Public signup creates organization, brain, owner member, owner OAuth client,
  onboarding URL, and owner invite delivery outbox record.
- Bootstrap login creates an authenticated admin session.
- Tenant plan endpoint reports usage and accepts plan updates.
- Billing webhook reconciles tenant plan state and is idempotent.
- Admin invite returns teammate onboarding URL, source-scoped client, and queued
  invite delivery outbox record.
- Invite delivery outbox lists owner and teammate invite records, claims a batch,
  and marks the teammate delivery sent.
- Invite delivery provider drain endpoint reports whether transactional email is
  configured and returns delivery result arrays.
- Source and skill policy APIs accept control-plane updates.
- Agent OAuth client registration supports federated reads.
- Composio webhook queues ingestion into a Cortex source.
- Token endpoint mints an agent access token.
- Owner-scoped MCP `saas_integrations_status` returns Composio readiness,
  connector state, and the hosted webhook URL.
- Owner-scoped MCP `saas_quality_snapshot` returns the shared investor/demo
  readiness contract used by the Quality console, including production gates
  for Supabase/Postgres, HTTPS origin, invite email, billing webhook secret,
  and bootstrap-token hygiene.
- MCP `tools/list` is reachable, non-empty, and Cortex-branded.

## 2. Runtime Manifest

```bash
curl -s https://<tenant-host>/runtime-manifest.json
```

Expected:

- `schema` is `cortex.runtime-manifest.v1`.
- `endpoints.mcp_url` points at `https://<tenant-host>/mcp`.
- No client secret appears in the response.

## 3. Onboarding URL

Create a signup or invite, then open:

```text
https://<tenant-host>/admin/onboarding?invite=<base64url-json>
```

Expected:

- The decoded payload shows org, brain, role, scopes, client id, write source,
  federated-read sources, MCP URL, and token URL.
- The URL does not contain `client_secret`.
- The page shows a `cortex connect` command only when a connectable client id and
  one-time secret are available.

## 4. Admin Console Walkthrough

Open these routes as an authenticated operator:

- `/admin/overview`
- `/admin/onboarding`
- `/admin/brains`
- `/admin/sources`
- `/admin/team`
- `/admin/invites`
- `/admin/agents`
- `/admin/skills`
- `/admin/integrations`
- `/admin/runtime`
- `/admin/quality`
- `/admin/settings`

Expected:

- No fresh browser console errors.
- Every route uses Cortex copy.
- Team/invite/agent forms create scoped OAuth clients.
- Invites shows delivery status for each invite, a delivery outbox table, batch
  claiming, provider send batching, and sent/failed result controls for claimed
  records.
- Skills policy changes persist and are visible to agent-callable APIs.
- Settings shows plan tier, usage limits, remaining capacity, and hard-limit
  violations for the selected tenant.
- Settings shows billing customer, provider, subscription, external plan, current
  period end, last event id, and last sync age when a billing webhook has landed.
- Runtime manifests, installer commands, and quality gates match the hosted
  tenant origin.

## 5. Agent Parity

Confirm these MCP operations are present for a `users_admin` client:

- `saas_signup_create`
- `saas_orgs_list`
- `saas_orgs_create`
- `saas_brains_list`
- `saas_brains_create`
- `saas_sources_list`
- `saas_sources_create`
- `saas_integrations_status`
- `saas_team_list`
- `saas_invites_list`
- `saas_invite_deliveries_list`
- `saas_invite_delivery_queue`
- `saas_invite_deliveries_claim`
- `saas_invite_delivery_mark`
- `saas_invite_deliveries_drain`
- `saas_skills_list`
- `saas_skills_upsert`
- `saas_runtime_manifest`
- `saas_plan_get`
- `saas_plan_update`
- `saas_console_snapshot`
- `saas_quality_snapshot`
- `users_create_invite`
- `users_register_agent_client`
- `users_update_agent_client_ttl`
- `users_revoke_agent_client`

## 6. Operator Diagnostics

```bash
cortex doctor --json
cortex models doctor
```

For Supabase pooler deployments, verify:

- `CORTEX_DISABLE_DIRECT_POOL=1`
- `CORTEX_PREPARE=false` or `?prepare=false` in `DATABASE_URL`
- `CORTEX_PUBLIC_URL` exactly matches the public origin clients use

## 7. Investor Demo Gate

Before a demo, prove:

- A fresh organization can sign up.
- An agent can create or receive an onboarding URL.
- A teammate can be invited with scoped source access.
- Owner and teammate invite delivery records are queued without embedding
  secrets in the onboarding URL.
- A worker or agent can claim delivery records and mark provider sent/failed
  results.
- Resend delivery draining is configured with a verified sender, or the console
  clearly reports the missing provider settings before claiming records.
- Composio webhook ingestion can create a queued job.
- Runtime install can configure Cursor or Claude Desktop without writing
  secrets into runtime config.
- MCP OAuth token exchange works.
- MCP tools are reachable, callable for integration status, and branded as
  Cortex.
- MCP quality snapshot reports the same readiness gates as `/admin/quality`.
- Quality reports demo tunnels honestly: PGLite or missing provider secrets can
  still exercise the demo flow, but must remain `needs_attention` until the
  durable production gates pass.
- Plan limits block over-quota brains, invites, sources, clients, and skill
  policies before partial provisioning happens.
- A billing webhook can upgrade/downgrade the tenant plan without duplicating on
  provider retries.
