# SaaS Runtime Packaging

Cortex should feel like one hosted SaaS even though agents connect through different runtimes. The product ships one tenant control plane and several thin runtime packages that all consume the same onboarding payload.

## Onboarding URL Contract

Every invite URL points back to the hosted admin app:

```text
https://<tenant-host>/admin/onboarding?invite=<base64url-json>
```

The decoded payload should contain:

```json
{
  "org": "Acme AI",
  "domain": "acme.ai",
  "brain": "Company Brain",
  "server_url": "https://acme.example.com/mcp",
  "token_url": "https://acme.example.com/token",
  "client_id": "cortex_cl_...",
  "write_source": "engineering",
  "federated_read": ["engineering", "default"],
  "scopes": "read write",
  "role": "member"
}
```

The secret is never embedded in the URL. The console or creating agent displays it once next to the connect command, and future email/identity-provider flows can exchange the invite for the secret after authentication. Agents and humans use the same payload with `cortex connect`.

## Runtime Packages

The packages should be thin. They should not fork the brain runtime; they only read the onboarding payload, store the tenant endpoint, and write the native client config.

Every hosted deployment exposes the same packaging contract in JSON:

```text
GET https://<tenant-host>/runtime-manifest.json
GET https://<tenant-host>/runtime-package.json
GET https://<tenant-host>/admin/api/runtime-manifest
MCP saas_runtime_manifest
MCP saas_runtime_package_index
```

The public endpoint contains no secret. Signup and invite responses also include a `runtime_manifest` with the one-time connect command for the newly created client. The secret still stays out of the onboarding URL.

The manifest has two complementary sections and links to the hosted package
index through `endpoints.runtime_package`:

- `runtimes`: exact setup payloads for Cursor, Claude Desktop, Claude Code, ChatGPT, Perplexity, and the Cortex CLI.
- `packages`: the package and adapter channels Cortex ships: CLI package, built-in config writers, command helpers, and connector templates. Package entries include the artifact, supported runtimes, and verification commands agents should run after install.

`runtime-package.json` is a public, secret-free index with schema
`cortex.runtime-package-index.v1`. Agents use it to discover the CLI, plugin,
runtime adapters, connector templates, and verification commands without
requiring an admin session.

The CLI packages the same contract for local runtime setup:

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install cursor
cortex runtime install claude-desktop
cortex runtime install claude-code --json
```

`cortex runtime install` reads the hosted MCP URL from the thin-client profile written by `cortex connect`, accepts `--manifest-url` to fetch the public hosted runtime manifest, or accepts `--mcp-url` for agent-driven setup. It writes runtime config without copying the OAuth client secret into Cursor or Claude Desktop config files.

Release packaging assembles the CLI binaries, plugin metadata, curated Cortex-clean runtime skills, setup docs, public runtime manifest, package index, and SHA-256 checksums into one handoff directory:

```bash
bun run package:runtime
# writes dist/cortex-runtime/

bun run package:runtime:metadata
# writes the same package metadata without requiring compiled binaries
```

The bundle index is `dist/cortex-runtime/runtime-package.json` with schema `cortex.runtime-package.v1`. Agents and deployment pipelines should treat it as the inventory of files to upload or attach to a tenant onboarding artifact. `runtime-manifest.json` in the same directory remains public and secret-free; signup and invite responses are still the only place a one-time client secret is shown. The packager fails if the generated text artifact contains legacy product copy, so newly added runtime skills must be Cortex-branded before they ship.

| Runtime | Package shape | Output |
| --- | --- | --- |
| Cortex CLI | `cortex connect <onboarding-url> --client-secret <secret>` | Local profile with MCP URL, token URL, client id, source bindings |
| Claude Code | CLI wrapper or shell snippet | `claude mcp add --transport http cortex <hosted-mcp-url>` |
| Cursor | small config writer | `.cursor/mcp.json` pointing to the hosted MCP URL |
| ChatGPT | web instructions | OAuth discovery URL and client credentials |
| Claude Desktop | config writer | desktop MCP server entry pointing to the hosted MCP URL |
| Perplexity | connector instructions | server URL plus OAuth client metadata |

## Agent Parity Rule

Anything a human can do in the console needs an equivalent agent path:

- Create/list tenant sources: MCP `saas_sources_create` and `saas_sources_list` with `users_admin`; these mirror the Sources console, link the source to the organization, and enforce tenant plan limits.
- Inspect/remove low-level source rows: MCP `sources_status`, `sources_list`, and `sources_remove` with source/admin scope for operator diagnostics and migration work.
- Inspect integration readiness: MCP `saas_integrations_status` with `users_admin`; this mirrors the Integrations console with Composio connector presets, webhook URL, required environment, and source-link state.
- Create signup requests: MCP `saas_signup_create` with `users_admin`; it creates the organization, initial brain, owner member, OAuth client, invite, onboarding URL, and one-time secret.
- Create/list organizations and brains: MCP `saas_orgs_create`, `saas_orgs_list`, `saas_brains_create`, and `saas_brains_list` with `users_admin`.
- Inspect team, invites, and delivery outbox: MCP `saas_team_list`, `saas_invites_list`, and `saas_invite_deliveries_list` with `users_admin`.
- Inspect/update skill policies: MCP `saas_skills_list` and `saas_skills_upsert` with `users_admin`; these mirror the console's skill catalog, source access, allowed clients, and enforcement status controls. Runtime adapters should pass `_skill_id` or `skill_id` on skill-backed MCP calls so dispatch can enforce `allowed_clients`, draft status, and source access before the underlying operation runs.
- Fetch runtime setup: MCP `saas_runtime_manifest` with `users_admin`; this returns the same CLI/plugin packaging contract shown in the Runtime console and public manifest endpoint.
- Fetch hosted package setup: MCP `saas_runtime_package_index` with `users_admin`; this mirrors `GET /runtime-package.json` and gives agents the CLI/plugin/runtime package inventory.
- Inspect/update tenant plans: MCP `saas_plan_get` and `saas_plan_update` with `users_admin`; these mirror the Settings plan controls and expose plan key, billing customer/provider/subscription metadata, external plan reference, billing sync timestamps, per-metric limits, usage, remaining capacity, and hard-limit violations.
- Register/manage scoped clients: MCP `users_register_agent_client`, `users_update_agent_client_ttl`, and `users_revoke_agent_client` with `users_admin`, plus the admin console invite form and agent-client drawer.
- Invite teammates: MCP `users_create_invite` with `users_admin`; it creates the OAuth client, member row, invite row, onboarding URL, and invite delivery outbox record in the same control-plane tables as the console.
- Queue/re-queue invite delivery: MCP `saas_invite_delivery_queue` with `users_admin`; this mirrors the console outbox and keeps provider delivery separate from the secret-free onboarding URL.
- Claim and acknowledge invite delivery: MCP `saas_invite_deliveries_claim` and `saas_invite_delivery_mark` with `users_admin`; these are the worker contract for a transactional email provider or agent-run delivery job. Claiming moves records to `sending`, increments attempts, and marking persists `sent`/`failed` provider results.
- Drain invite delivery through Resend: MCP `saas_invite_deliveries_drain` with `users_admin`, the console endpoint `POST /admin/api/invite-deliveries/drain`, or the worker endpoint `POST /jobs/invite-deliveries/drain` with `CORTEX_EMAIL_DELIVERY_SECRET`.
- Run onboarding checks: MCP `run_onboard` with `admin`, plus `run_protected_onboard` for protected jobs.
- View requests/jobs/operator health: MCP `saas_console_snapshot` with `users_admin`; it returns the dashboard stats, token health, control-plane counts, agents, recent requests, and job state that the console shows to human operators.
- Verify investor/demo readiness: MCP `saas_quality_snapshot` with `users_admin`; it returns the same onboarding, OAuth, source, Composio, skill promotion, queue health, and agent-parity gates rendered in the Quality console.

## Production Hardening Before General Availability

The current hosted brain is live and now has an app-plane control database for signup requests, organizations, tenant brains, members, invites, invite delivery outbox records, and owner OAuth clients. Public launch still needs production identity, email provider wiring, and provisioning automation:

- Supabase Auth or Clerk/WorkOS for end-user authentication and verified domains.
- Verified transactional email sending domains. The Resend drain is wired: set `CORTEX_EMAIL_PROVIDER=resend`, `RESEND_API_KEY` or `CORTEX_RESEND_API_KEY`, `CORTEX_EMAIL_FROM`, and `CORTEX_EMAIL_DELIVERY_SECRET` to let a worker claim `saas_email_deliveries`, send via Resend, and record provider message ids, failures, and sent timestamps.
- A provisioning worker for dedicated per-brain Supabase/Railway resources when tenants outgrow the shared hosted brain model.
- Continued control-plane API coverage for any future tenant health/read-only dashboard views that are added to the admin API.
- Runtime adapter coverage for every packaged client. MCP dispatch now enforces persisted skill policies on annotated calls, but each CLI/plugin/runtime adapter must pass `_skill_id` or `skill_id` consistently.
- Checkout/subscription UX. Billing-provider webhooks already reconcile external subscription state into the Cortex plan table through `POST /webhooks/billing` when `CORTEX_BILLING_WEBHOOK_SECRET` is set. The control plane enforces tenant-scoped limits for brains, sources, members, invites, agent clients, skill policies, daily requests, and waiting jobs.

Until those land, the SaaS is an operator-provisioned tenant with a production hosted MCP brain and a SaaS-shaped admin console.
