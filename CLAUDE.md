# CLAUDE.md

Cortex is a hosted, multi-tenant company-brain SaaS for teams and their agents.
It gives each organization scoped brains, source-level access control, hosted MCP,
OAuth client registration, onboarding links, invites, skill policy enforcement,
and runtime manifests for agent clients.

This file is the quick orientation for agents working in this repo. Treat the
SaaS control plane as the product boundary. Local embedded modes exist only for
development, tests, and compatibility while the hosted Cortex runtime remains
the customer-facing path.

## Product Model

- **Organization**: the tenant boundary. Members, invites, plans, billing state,
  OAuth clients, and limits are scoped to an organization.
- **Brain**: a knowledge database owned by an organization. A company can have
  more than one brain when teams need different retention, access, or policy.
- **Source**: a scoped corpus inside a brain, such as engineering, sales, support,
  meetings, or company wiki. Sources are the default authorization unit for
  agents and humans.
- **Agent client**: an OAuth/MCP client with scopes, source bindings, TTL, and
  revocation state. Agents and humans go through equivalent control-plane paths.
- **Skill policy**: a tenant policy that controls which skills are enabled, which
  clients may invoke them, and which sources the skill can read or write.
- **Runtime manifest**: the secret-free setup contract exposed at
  `/runtime-manifest.json`, `/admin/api/runtime-manifest`, and the MCP
  `saas_runtime_manifest` operation.

## Agent Parity Rule

Anything the console lets a human do must have an equivalent agent path.

Examples:

- Create an organization and owner onboarding link.
- Invite teammates and queue invite delivery.
- Register, rotate, or revoke agent clients.
- Create brains and sources.
- Configure skill policy.
- Connect Composio or another ingestion provider.
- Fetch runtime setup instructions.
- Inspect request, job, billing, and tenant health state.

When adding a console feature, add or verify the matching MCP/API operation in
the same change. Do not ship a human-only control path.

## Architecture

Cortex is contract-first. `src/core/operations.ts` defines the shared operation
surface used by the CLI, MCP server, HTTP transport, tests, and generated agent
tooling. The hosted SaaS layer builds on that contract with:

- `src/core/saas-control-plane.ts`: organizations, brains, members, invites,
  clients, plans, skill policies, provider jobs, and outbox records.
- `src/core/saas-runtime-manifest.ts`: runtime setup payloads and package
  metadata.
- `src/core/saas-email-delivery.ts`: invite delivery worker/provider contract.
- `src/core/saas-skills.ts`: skill catalog and Cortex-branded policy surfaces.
- `src/commands/connect.ts` and `src/commands/runtime.ts`: CLI onboarding and
  runtime config writers.
- `src/commands/serve-http.ts`: hosted HTTP, marketing, admin API, OAuth, MCP,
  webhooks, and job endpoints.

The admin UI is a Next.js App Router static export under `admin/`, using the v0
dashboard as the visual base and shadcn components for production console flows.
`bun run build:admin` exports it and regenerates `src/admin-embedded.ts`.

## Security Boundaries

- Hosted requests are untrusted unless explicitly proven otherwise.
- OAuth scopes and source bindings are enforced before operation dispatch.
- Admin bootstrap tokens are setup-only and must not be exposed in logs.
- Invite URLs must not contain client secrets.
- Runtime manifests are public and secret-free.
- Agent client secrets are shown once, then stored only in hashed or protected
  form according to the control-plane path.
- Shell jobs must stay disabled for hosted tenants unless the runtime is isolated.
- New public endpoints need rate limits, input validation, and tenant scoping.

## Commands

Use Cortex-branded commands in new docs, tests, UI copy, and examples.

```bash
bun install
bun run build:admin
bun run tsc --noEmit --pretty false
bun run verify
bun run test
bun run smoke:saas-live
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor --manifest-url https://tenant.example.com/runtime-manifest.json
```

Use compatibility names only inside intentionally backward-compatible code paths
or historical migration fixtures. Public copy should say Cortex.

## Development Loop

For SaaS-facing changes, prefer these checks:

```bash
bun run build:admin
bun run check:cortex-public-copy
bun run check:newlines
bun run tsc --noEmit --pretty false
bun test test/saas-control-plane.test.ts test/saas-live-smoke.test.ts
```

For rendered UI changes, run a browser or Playwright pass through:

1. marketing page
2. signup
3. onboarding link
4. admin login
5. team invite
6. agent client registration
7. integrations
8. runtime manifest
9. quality gates

## Public Copy Rules

Customer and agent-facing surfaces must describe Cortex as a hosted company-brain
SaaS. Avoid legacy project names, local runtime positioning, and solo-user
memory framing in these surfaces:

- `README.md`
- `AGENTS.md`
- `INSTALL_FOR_AGENTS.md`
- root design and contributor docs
- `docs/CORTEX_*.md`
- `docs/deploy/*.md`
- `docs/mcp/*.md`
- `docs/tutorials/company-brain.md`
- `skills/setup/SKILL.md`
- `skills/schema-author/SKILL.md`
- `llms.txt`
- `llms-full.txt`
- `admin/app`, `admin/components/cortex`, and `admin/lib`

Run `bun run check:cortex-public-copy` after editing any of those files.

## Production Readiness Bar

A change moves Cortex toward the actual product only when it strengthens one of
these requirements:

- A company can create an org and default company brain.
- An agent can create the same org through the control plane.
- An owner gets an onboarding URL and connect command.
- Teammates can be invited without leaking secrets in URLs.
- Sources, brains, skills, and clients are tenant-scoped.
- Runtime setup works through the manifest and CLI.
- Ingestion providers can queue jobs with tenant/source attribution.
- MCP/OAuth clients can connect with scoped permissions.
- Public docs and UI are Cortex-branded.
- The hosted app can be smoke-tested end to end.

Do not call the goal complete until the current deployment and source tree prove
those requirements with tests, live smoke checks, and rendered UI evidence.
