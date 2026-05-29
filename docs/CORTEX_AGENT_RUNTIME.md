# Cortex Agent Runtime

Cortex is a hosted, multi-tenant company-brain SaaS for humans and agents. This
guide describes how agents should use the product surface: signup, onboarding,
sources, invites, scoped OAuth clients, runtime manifests, skills, and MCP.

The central rule is simple: anything a human can do in the console, an
authorized agent must be able to do through MCP.

## Core Loop

1. Create or receive an organization invite.
2. Connect to the tenant with `cortex connect`.
3. Use the hosted MCP endpoint for reads, writes, source management, skills, and
   admin operations.
4. Keep source boundaries and OAuth scopes as the authority model.
5. Use the runtime manifest to configure Cursor, Claude Desktop, Claude Code,
   ChatGPT, Perplexity, and future clients.

Agents should not create a separate backend per user. Local runtime setup is a
thin adapter to the hosted tenant.

## Tenant Operations

| Job | Human Path | Agent Path |
| --- | --- | --- |
| Create tenant | `/admin/signup` | `saas_signup_create` |
| List organizations | Console overview | `saas_orgs_list` |
| Create brain | Brains page | `saas_brains_create` |
| List brains | Brains page | `saas_brains_list` |
| Create source | Sources page | `saas_sources_create` |
| List org sources | Sources page | `saas_sources_list` |
| Inspect source diagnostics | Sources page | `sources_status` |
| Inspect integrations | Integrations page | `saas_integrations_status` |
| Invite teammate | Team or Invites page | `users_create_invite` |
| Create agent client | Agents page | `users_register_agent_client` |
| Update/revoke client | Agents page | `users_update_agent_client_ttl`, `users_revoke_agent_client` |
| Manage skills | Skills page | `saas_skills_list`, `saas_skills_upsert` |
| Fetch runtime setup | Runtime page | `saas_runtime_manifest` |
| Inspect billing limits | Settings page | `saas_plan_get`, `saas_plan_update` |
| Inspect health/activity | Overview, Activity, Quality | `saas_console_snapshot`, `run_onboard` |

## Runtime Setup

Every tenant exposes:

```text
POST https://<tenant-host>/admin/api/signup
GET https://<tenant-host>/runtime-manifest.json
GET https://<tenant-host>/admin/api/runtime-manifest
MCP saas_runtime_manifest
```

`POST /api/signup` remains available for older clients, but new agents should
use the `/admin/api/signup` path shown in the console docs.

Every invite URL points to:

```text
https://<tenant-host>/admin/onboarding?invite=<base64url-json>
```

The onboarding payload carries server URL, token URL, client id, scopes, role,
write source, federated-read sources, org id, and brain id. The one-time secret
is delivered out of band.

Connect:

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor
cortex runtime install claude-desktop
cortex runtime install claude-code --json
```

Runtime config files must contain only the hosted MCP URL and non-secret
metadata. They must not store the one-time OAuth secret.

## Source Model

Use sources for team, integration, department, repository, or project
boundaries inside a brain. Each OAuth client has:

- One write source.
- A federated-read list.
- Scopes such as `read`, `write`, `users_admin`, `sources_admin`, or `admin`.
- Optional token TTL and budget settings.

Use another brain only for hard boundaries: separate database, region,
retention, public URL, backup policy, or dedicated enterprise deployment.

## Skill Model

Skills are Cortex capabilities controlled by source/client policy. A skill
policy includes:

- Skill id and display name.
- Status: installed, draft, or needs-enforcement.
- Source access.
- Allowed OAuth clients.
- Triggers and description.
- Enforcement state.

Runtime adapters should annotate skill-backed MCP calls with `_skill_id`,
`skill_id`, or `_meta.skill_id`. Dispatch blocks draft or disallowed skills
before the underlying operation runs.

## Integration Model

Connectors ingest into sources. Composio is the preferred integration layer for
MVP ingestion because it gives Cortex one consistent event surface across common
third-party tools. Connector events should include tenant, source, provider,
external object id, content, and provenance metadata.

The source remains the authorization boundary. Connector-specific permissions
should not replace Cortex OAuth scope checks.

## Administration

Production deployments should configure:

- `CORTEX_DATABASE_URL`
- `CORTEX_PUBLIC_URL`
- `CORTEX_ADMIN_BOOTSTRAP_TOKEN`
- `CORTEX_COMPOSIO_WEBHOOK_SECRET`
- `CORTEX_BILLING_WEBHOOK_SECRET`
- `CORTEX_EMAIL_DELIVERY_SECRET`
- Verified transactional email provider settings
- Provider keys for embeddings, reranking, chat, and ingestion workers

Run the hosted smoke before demos:

```bash
bun run smoke:saas-live -- --json
```

The smoke verifies public pages, signup, org/brain creation, owner onboarding,
console session, plan update, billing webhook, teammate invite, invite delivery
outbox, org-scoped source creation, skill policy, agent OAuth client, Composio
ingestion, OAuth token exchange, and MCP `tools/list` including the SaaS source
operations.

## Related Docs

- `docs/CORTEX_RECOMMENDED_SCHEMA.md`
- `docs/CORTEX_PRODUCT_SPEC.md`
- `docs/deploy/multi-tenant-saas.md`
- `docs/deploy/saas-runtime-packaging.md`
- `docs/tutorials/company-brain.md`
- `docs/CORTEX_VERIFY.md`
