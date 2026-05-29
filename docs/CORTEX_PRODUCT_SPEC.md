# Cortex Product Spec

Cortex is a hosted, multi-tenant company-brain SaaS. It lets organizations turn
their team knowledge, integrations, documents, meetings, and agent outputs into
a source-scoped, OAuth-protected MCP brain that humans and agents can both
operate.

## Product Promise

A company or its agent can sign up, receive an onboarding URL, invite teammates,
connect sources, configure runtime clients, and start using a hosted MCP brain
without cloning or operating a separate backend.

## First-Class Objects

| Object | Description |
| --- | --- |
| Organization | Tenant, billing owner, domain, plan, members, invites. |
| Brain | Hosted database/runtime boundary with public URL, OAuth metadata, backups, and lifecycle. |
| Source | Team, integration, repository, department, or project boundary inside a brain. |
| Member | Human teammate with role, status, write source, readable sources, and client binding. |
| Agent client | OAuth client for a human's runtime, bot, integration, or admin agent. |
| Invite | Secret-free onboarding URL plus one-time secret delivered out of band. |
| Skill policy | Source/client-scoped capability policy enforced at dispatch. |
| Runtime manifest | Package and connector contract for CLI and agent runtime setup. |
| Plan | Billing state and hard limits for brains, sources, members, invites, clients, skills, requests, and jobs. |

## Required User Journeys

### Human Signup

1. Visit `/admin/signup`.
2. Enter organization name, work email, and optional domain.
3. Receive org, brain, owner member, owner OAuth client, onboarding URL, and
   one-time secret.
4. Continue to `/admin/onboarding`.
5. Invite teammates and connect runtime clients.

### Agent Signup

1. Call `saas_signup_create`.
2. Receive the same org, brain, client, onboarding URL, secret, and runtime
   manifest payload.
3. Return the onboarding URL to the human or continue setup autonomously with
   admin scope.

### Teammate Invite

1. Human uses Team/Invites UI or agent calls `users_create_invite`.
2. Cortex creates member, invite, scoped OAuth client, onboarding URL, and invite
   delivery outbox record.
3. Delivery worker or agent drains the outbox through the configured email
   provider.
4. Teammate runs `cortex connect`.

### Runtime Install

1. Fetch runtime manifest.
2. Run `cortex connect`.
3. Install config for Cursor, Claude Desktop, Claude Code, ChatGPT connector, or
   Perplexity connector.
4. Runtime config points to hosted MCP and does not contain the client secret.

### Source And Integration

1. Create a source for a team or connector.
2. Connect ingestion through Composio or source APIs.
3. Verify source status and page counts.
4. Grant OAuth clients federated-read access only where appropriate.

### Skill Policy

1. Install or draft a skill.
2. Scope it to sources and allowed clients.
3. Runtime adapter passes a skill id on skill-backed calls.
4. Dispatch refuses draft or disallowed policy before the underlying tool runs.

## Console Tabs

- Signup: public tenant creation.
- Onboarding: decoded invite payload, connect command, source/client setup.
- Overview: readiness, health, activity, plan usage.
- Brains: brain boundaries and hard isolation decisions.
- Sources: source registry, ingestion, status.
- Team: members and roles.
- Invites: onboarding URLs and delivery outbox.
- Agents: OAuth clients, TTL, revocation, scopes.
- Skills: catalog, triggers, allowed clients, source access.
- Integrations: Composio and provider status.
- Runtime: runtime manifest, package channels, connector setup.
- Jobs: background work and queue status.
- Activity: request log.
- Quality: production and demo-readiness checks across deployment,
  onboarding, ingestion, OAuth clients, skills, jobs, and agent parity.
- Settings: plan, billing sync, environment, and operations.

## Agent Parity

Every console action must have an MCP equivalent. Required operations include:

- `saas_signup_create`
- `saas_orgs_list`
- `saas_orgs_create`
- `saas_brains_list`
- `saas_brains_create`
- `saas_sources_list`
- `saas_sources_create`
- `saas_integrations_status`
- `saas_team_list`
- `users_create_invite`
- `users_register_agent_client`
- `users_update_agent_client_ttl`
- `users_revoke_agent_client`
- `saas_invites_list`
- `saas_invite_deliveries_list`
- `saas_invite_delivery_queue`
- `saas_invite_deliveries_claim`
- `saas_invite_delivery_mark`
- `saas_invite_deliveries_drain`
- `sources_status`
- `saas_skills_list`
- `saas_skills_upsert`
- `saas_runtime_manifest`
- `saas_plan_get`
- `saas_plan_update`
- `saas_console_snapshot`
- `saas_quality_snapshot`
- `run_onboard`

## Deployment Requirements

- Managed Postgres with pgvector.
- Hosted Cortex HTTP server with `/mcp`, OAuth discovery, `/token`, `/admin`,
  `/admin/api/signup`, compatibility `/api/signup`, webhooks, and runtime
  manifest.
- Secret manager values for database, public URL, bootstrap token, email,
  billing, Composio, and AI provider credentials.
- Transactional email domain for production invite delivery.
- Billing webhook integration.
- Hosted smoke test as a release gate.

## Demo Gate

The product is demo-ready when a public URL can prove:

1. Marketing page loads and is Cortex-branded.
2. Signup creates org, brain, owner client, and onboarding URL.
3. Owner can enter onboarding.
4. Admin console can invite a teammate.
5. Invite delivery outbox can be claimed, sent, and marked.
6. Runtime manifest exposes package and connector setup.
7. Agent OAuth client can be created and token exchange succeeds.
8. Composio webhook queues ingestion into a source.
9. MCP `tools/list` is reachable and Cortex-branded.
10. MCP `saas_quality_snapshot` returns the same readiness gates as the Quality
    console.
11. No public surface leaks old product, personal-use, or local-only setup copy.

## Production Gate

The product is production-ready when the demo gate passes and the Quality
snapshot also proves:

1. The runtime is backed by managed Postgres/Supabase with pgvector, not PGLite.
2. `CORTEX_PUBLIC_URL` is a stable HTTPS origin used by OAuth discovery,
   onboarding links, runtime manifests, and MCP clients.
3. Invite delivery is wired to a verified transactional email provider.
4. Billing lifecycle webhooks are signed and reconcile tenant plan state.
5. Bootstrap secrets are strong and suppressed from hosted logs.
