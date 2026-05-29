# Cortex v0 UI MVP Prompt

Use this prompt in v0 when regenerating or extending the CortexBrain-ui shell.

```text
Build the full MVP UI for Cortex Brain, a hosted multi-tenant SaaS that turns a
company's knowledge, integrations, sources, skills, and agent outputs into a
source-scoped OAuth MCP brain. The UI must be a production-grade Next.js App
Router application using TypeScript, Tailwind, shadcn/ui, lucide icons, Geist
Sans/Mono, and a dark-first enterprise console style.

Branding:
- Use only "Cortex", "Cortex Brain", "company brain", "source", "skill",
  "agent client", "runtime", and "integration" copy.
- Never mention legacy upstream brand names, legacy product positioning, or
  non-hosted setup framing.
- Commands shown to users must use `cortex`, `cortex connect`, `cortex runtime`,
  and `CORTEX_*` environment variables.

Information architecture:
- Public marketing page at `/` with a real first-viewport product signal, not a
  generic landing page. Primary CTA: "Create tenant". Secondary CTA: "View
  runtime package".
- Public signup at `/admin/signup`: organization name, work email, domain,
  submit, and success handoff showing onboarding URL, `cortex connect` command,
  client id, and one-time secret warning.
- Login at `/admin/login`: bootstrap token form plus link to create a tenant.
- Protected admin dashboard routes:
  - Overview: readiness, plan usage, request counts, recent activity, next
    actions.
  - Onboarding: decoded invite payload, onboarding URL, connect command, runtime
    setup, source/client scope.
  - Brains: one company brain by default, plus multiple brains only for hard
    isolation boundaries. Explain via UI labels that sources are the normal
    team/project "sub-brain" model.
  - Sources: create source id/display name, federated toggle, remote URL,
    source list, ingestion status, scope badges.
  - Team: members, roles, invite teammate flow, onboarding URL handoff.
  - Invites: invite outbox, provider status, claim/drain/mark sent actions.
  - Agents: OAuth clients, scopes, token TTL, source binding, federated-read,
    revoke/update actions, one-time client secret display.
  - Skills: skill catalog, draft creation, triggers, source access checkboxes,
    allowed client ids, promote policy, enforcement status.
  - Integrations: Composio provider status, connector rows, create Cortex source
    action, webhook URL and signing status.
  - Runtime: runtime manifest, package channels, checksums, CLI install,
    ChatGPT/Claude/Cursor/Perplexity connector setup.
  - Jobs: queue health, failed jobs, retries, ingestion jobs.
  - Activity: request log with token/client, operation, source, latency, status.
  - Quality: production deployment gates and investor demo gates. Must show
    durable database, hosted OAuth origin, invite email delivery, billing
    webhook, secret hygiene, signup/onboarding, agent access, source ingestion,
    Composio ingestion, skill promotion, queue health, and agent parity.
  - Settings: plan limits, billing sync, environment, operational toggles.

Interaction requirements:
- Every form must be functional with local state and ready to wire to REST APIs.
- Use shadcn Card only for repeated items, modals, or framed tools. Do not nest
  cards inside cards.
- Use shadcn Table for dense lists, Badge for status, Tabs for mode switching,
  Dialog/Sheet for confirmations, Tooltip for icon-only actions, and sonner for
  feedback.
- Use lucide icons in buttons and navigation.
- Make route content responsive. Desktop uses a sidebar plus top bar; mobile
  collapses navigation without overlapping text or controls.
- Include loading, empty, error, and success states for signup, invites, agent
  client creation, skill promotion, integration source creation, and quality
  refresh.
- Do not build inert marketing chrome instead of the product. The first screen
  after login must be the actual admin console.

API contract to wire:
- `GET /health`
- `POST /admin/api/signup` (`POST /api/signup` remains compatible)
- `GET /runtime-package.json`
- Admin REST:
  - `/admin/api/login`
  - `/admin/api/stats`
  - `/admin/api/health-indicators`
  - `/admin/api/orgs`
  - `/admin/api/brains`
  - `/admin/api/sources`
  - `/admin/api/team`
  - `/admin/api/invites`
  - `/admin/api/invite-deliveries`
  - `/admin/api/register-client`
  - `/admin/api/agents`
  - `/admin/api/skills`
  - `/admin/api/integrations`
  - `/admin/api/runtime`
  - `/admin/api/jobs`
  - `/admin/api/requests`
  - `/admin/api/quality`
  - `/admin/api/plan`
  - `/admin/api/billing/sync`
- MCP/agent parity that the UI must reflect:
  - `saas_signup_create`, `saas_orgs_list`, `saas_orgs_create`,
    `saas_brains_list`, `saas_brains_create`, `saas_sources_list`,
    `saas_sources_create`, `saas_integrations_status`, `saas_team_list`,
    `users_create_invite`, `users_register_agent_client`,
    `users_update_agent_client_ttl`, `users_revoke_agent_client`,
    `saas_invites_list`, `saas_invite_deliveries_list`,
    `saas_invite_delivery_queue`, `saas_invite_deliveries_claim`,
    `saas_invite_delivery_mark`, `saas_invite_deliveries_drain`,
    `saas_skills_list`, `saas_skills_upsert`, `saas_runtime_manifest`,
    `saas_plan_get`, `saas_plan_update`, `saas_console_snapshot`,
    `saas_quality_snapshot`, and `run_onboard`.

Visual direction:
- Quiet, high-trust SaaS operations console.
- Dark background, restrained borders, crisp type, dense tables, clear status
  color, no decorative orbs/blobs, no purple-blue gradient dependence, no
  nested-card dashboard clutter.
- Cards should use 8px radius or the shadcn default only where the design
  system already requires it.
- Text must fit on mobile and desktop. No viewport-scaled font sizes and no
  negative letter spacing.

Deliverables:
- A complete Next.js App Router static-export-compatible app under `admin/`.
- Reusable components for app shell, nav, metric cards, status badges, forms,
  tables, empty states, copy blocks, and code blocks.
- Typed API client and shared SaaS model types.
- Seed/mock data only as fallback while real endpoints load.
- README notes explaining how to build and export the admin bundle.
```
