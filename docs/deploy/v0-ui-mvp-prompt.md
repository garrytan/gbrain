# v0 Prompt: Cortex SaaS Console MVP

Use this prompt in v0 to generate or iterate the full UI MVP for the Cortex multi-tenant company-brain SaaS console.

```text
Build the production MVP UI for Cortex, a multi-tenant SaaS that gives every company a hosted AI company brain. This is not a marketing site. The first screen after login should be the real operator console.

Target the existing Next.js App Router admin app. Generate components that can live under admin/app, admin/components, and admin/lib. Use React, TypeScript, shadcn/ui components, Tailwind v4-compatible classes, and lucide-react icons. Keep the static export mounted at /admin. Do not create a landing page. Do not put page sections inside decorative cards; use a dense SaaS console layout with a left sidebar, top status strip, tables, forms, and compact panels.

Product model:
- Organization: the company tenant.
- Brain: a deployed database/server boundary. A company can have multiple brains, but the default onboarding path creates one company brain first.
- Source: a team/topic/repo boundary inside one brain, used for write-source and federated-read scoping. Sources are the "team brain" layer for most customers.
- Member: a human teammate with role owner, admin, member, or viewer.
- Agent client: an OAuth client used by a teammate's agent runtime.
- Invite: a persisted onboarding handoff that creates a member, OAuth client, scoped access, and a URL.
- Skill: an installable or draft capability with triggers, source access, allowed clients, and enforcement status.

Use this navigation:
- Overview
- Onboarding
- Brains
- Sources
- Team
- Agents
- Skills
- Activity
- Jobs
- Runtime
- Quality

Required screens and behavior:

1. Public signup screen at /signup
- Show a compact signup form for organization name, work email, and optional domain.
- Submit to POST /admin/api/signup with { orgName, email, domain }.
- On success, show the returned onboarding_url, org, brain, member, invite, and a "Continue onboarding" action.
- Make clear through status labels that provisioning may be pending, without writing explanatory marketing copy.

2. Login screen
- Brand as Cortex / Company Brain.
- Admin bootstrap-token input for operators.
- Secondary action "Create a tenant" that navigates to /signup.
- No localStorage token handling; the app relies on HttpOnly cookies.

3. Overview
- Show tenant readiness: health, MCP URL, token URL, source count, active clients, pending invites, recent requests, jobs.
- Include a "next action" checklist: organization, brain, source, invite, agent client, runtime connected.
- Include a live activity table with request status, client, scope, source, and timestamp.

4. Onboarding
- Wizard-like operator flow with four dense panels:
  - Create organization.
  - Create first brain.
  - Create first source.
  - Create first agent client or teammate invite.
- Must produce/copy an onboarding URL shaped like /admin/onboarding?invite=<base64url-json>.
- Decode invite payload from the URL when present and show endpoint, token URL, client id, scopes, role, source_id, and federated_read.
- Never place client_secret in the URL. If returned by API, show it once in a warning-styled reveal/copy panel.
- Include a copyable CLI command: cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'. Public signup now returns the owner client id and one-time secret; older payloads that still have status=provisioning and lack client_id/server_url should be shown as legacy signup receipts rather than connectable runtime invites.

5. Brains
- Table of tenant brains with name, org, status, public URL, region, created date, and actions.
- Create brain form with org selector, name, public URL, region, and status.
- Include a compact decision panel:
  - Use sources for normal team/topic/repo separation.
  - Use another brain for data owner, lifecycle, backup, residency, or admin boundary changes.
- Show "provisioning", "ready", and "needs attention" states.

6. Sources
- Table of sources with id, name, remote URL, federated flag, page count, last sync.
- Add source form: source id, display name, optional git/repo URL, federated-read checkbox.
- Source id validation should explain invalid ids inline.
- Include per-source actions for status and sync readiness.

7. Team
- Member table with email, role, status, write source, readable sources, OAuth client id, last active.
- Invite form with email, role, write source select, multi-select federated-read sources, and optional welcome note.
- Submit to POST /admin/api/invites with { orgId, email, role, sourceId, federatedRead, welcome }.
- On success, show onboardingUrl, clientId, clientSecret once, and the created member/invite.
- Roles should map to scopes:
  - owner/admin: admin sources_admin users_admin read write
  - member: read write
  - viewer: read

8. Agents
- OAuth client table with client name, client id, scopes, source_id, federated_read, token TTL, created date, and revoke/update actions.
- Create client form for agent name, scopes, write source, federated-read sources, token TTL.
- Make source scoping visible in every row.

9. Skills
- Skill catalog table/cards with skill name, owner/team, status, triggers, source access, allowed clients, last run, and description.
- Include statuses: installed, draft, needs-enforcement.
- Provide edit controls for allowed clients and source access in the UI shell, even if the backend is not complete yet.
- Add an enforcement note that persisted policies are enforced on MCP calls that include `_skill_id` or `skill_id`; show a warning when a runtime adapter has not been configured to pass that annotation.

10. Runtime
- Show connect instructions for Cortex CLI, Claude Code, Cursor, ChatGPT, Claude Desktop, and Perplexity.
- All runtimes consume the same onboarding payload.
- Include copyable command blocks that use server_url, token_url, client_id, and source bindings from the selected invite/client.
- Cortex CLI command must be: cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'. Also show the env-var variant CORTEX_REMOTE_CLIENT_SECRET='<one-time-secret>' cortex connect '<onboarding-url>'.
- Native config helpers must point runtimes at the hosted MCP URL, not a local standalone bridge: cortex runtime install cursor, cortex runtime install claude-desktop, and cortex runtime install claude-code --json.

11. Activity, Jobs, Quality
- Keep existing request log, job watch, and calibration/quality surfaces.
- Quality should read GET /admin/api/quality and render the same checks returned by MCP saas_quality_snapshot: onboarding, agent access, source ingestion, Composio, skill promotion, queue health, and agent parity.
- Update styling to match the SaaS console.

API contract to use:
- POST /admin/api/signup
- GET /admin/api/orgs
- POST /admin/api/orgs
- GET /admin/api/brains?orgId=
- POST /admin/api/brains
- GET /admin/api/sources
- POST /admin/api/sources
- GET /admin/api/team?orgId=
- GET /admin/api/invites?orgId=
- POST /admin/api/invites
- GET /admin/api/invite-deliveries?orgId=
- POST /admin/api/invite-deliveries/claim
- POST /admin/api/invite-deliveries/drain
- POST /admin/api/invite-deliveries/:id/result
- GET /admin/api/skills
- POST /admin/api/skills
- GET /admin/api/plan?orgId=
- POST /admin/api/plan
- GET /admin/api/agents
- POST /admin/api/register-client
- POST /admin/api/update-client-ttl
- POST /admin/api/revoke-client
- GET /admin/api/requests
- GET /admin/api/jobs/watch
- GET /admin/api/health-indicators
- GET /admin/api/stats
- GET /admin/api/quality

Agent/MCP parity contract:
- saas_signup_create: create org, first brain, owner member, invite, and onboarding URL.
- saas_orgs_list / saas_orgs_create: list and create organizations.
- saas_brains_list / saas_brains_create: list and create tenant brains.
- saas_sources_list / saas_sources_create: list and create org-scoped sources with tenant plan enforcement.
- saas_integrations_status: inspect Composio connector readiness, webhook URL, required env, and source-link state.
- saas_team_list / saas_invites_list: inspect team members and invites.
- saas_invite_deliveries_list / saas_invite_delivery_queue / saas_invite_deliveries_claim / saas_invite_delivery_mark / saas_invite_deliveries_drain: inspect, queue, claim, acknowledge, and provider-send invite delivery records.
- saas_skills_list / saas_skills_upsert: inspect and update skill policies, source access, allowed clients, and enforcement state.
- saas_plan_get / saas_plan_update: inspect and update tenant plan tier, billing customer/provider/subscription metadata, external plan reference, billing sync timestamps, limits, usage, remaining capacity, and hard-limit violations.
- saas_console_snapshot / saas_quality_snapshot: inspect operator console state and investor/demo readiness gates with the same data shown in Overview and Quality.
- users_create_invite: create teammate invite, OAuth client, member row, invite row, and onboarding URL.
- users_register_agent_client: create a scoped OAuth client when no teammate invite is needed.
- users_update_agent_client_ttl: update or clear a scoped OAuth client token lifetime.
- users_revoke_agent_client: revoke a scoped OAuth client and delete active OAuth tokens.

Surface this parity in the UI where useful: every important console action should have a copyable agent instruction or operation name beside it.

Design direction:
- Quiet, high-density B2B SaaS console for operators and technical admins.
- Avoid oversized hero sections, decorative gradients, and generic illustrations.
- Use a restrained neutral base with one clear accent, plus semantic green/yellow/red state colors.
- Tables should be scan-friendly. Forms should be compact and inline where possible.
- Buttons should use icons when the action is familiar: copy, refresh, revoke, plus, external link, download.
- Text must fit at mobile and desktop sizes. Use responsive grids and avoid viewport-scaled font sizes.
- Every major action needs loading, success, empty, and error states.

Deliverables:
- React components and typed API helpers.
- A shared SaaS model file for Organization, Brain, Source, Member, Invite, AgentClient, Skill, and Plan.
- Utility functions to encode/decode onboarding payloads with base64url JSON.
- Mock data only as a fallback when an API endpoint is unavailable; real API calls should be the default.
- No secrets in URLs, logs, localStorage, or mock fixtures.
```
