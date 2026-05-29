# Contributing To Cortex

Cortex is a hosted company-brain SaaS. Contributions should move the product
toward tenant-scoped org creation, onboarding, invites, runtime setup, ingestion,
MCP/OAuth access, skill policy, billing readiness, and reliable operations.

## Setup

```bash
bun install
bun run build:admin
bun run tsc --noEmit --pretty false
bun run test
```

Requires Bun 1.3.10 or newer.

## Project Structure

```text
src/
  cli.ts                         Cortex CLI entry point
  commands/                      CLI commands and hosted server entrypoints
  core/
    operations.ts                Contract-first operation definitions
    saas-control-plane.ts        Tenant, brain, member, invite, client, plan state
    saas-runtime-manifest.ts     Runtime setup and package manifest payloads
    saas-email-delivery.ts       Invite delivery worker/provider contract
    saas-skills.ts               Cortex skill catalog and policy surfaces
    engine.ts                    BrainEngine interface
    postgres-engine.ts           Postgres implementation
    pglite-engine.ts             Embedded test/dev implementation
  mcp/                           MCP server and HTTP transport
admin/                           Next.js App Router console
docs/                            SaaS, deployment, runtime, and architecture docs
skills/                          Agent skills and shared conventions
test/                            Unit, control-plane, runtime, and E2E tests
scripts/                         Preflight, packaging, smoke, and verification tools
```

## Running Checks

Use focused checks while editing, then broaden before handoff.

```bash
bun run build:admin
bun run check:cortex-public-copy
bun run check:newlines
bun run tsc --noEmit --pretty false
bun test test/saas-control-plane.test.ts test/runtime-install.test.ts
```

Use the live SaaS smoke when a hosted server is running:

```bash
CORTEX_PUBLIC_URL=https://tenant.example.com \
CORTEX_ADMIN_BOOTSTRAP_TOKEN=<token> \
CORTEX_COMPOSIO_WEBHOOK_SECRET=<secret> \
CORTEX_BILLING_WEBHOOK_SECRET=<secret> \
CORTEX_EMAIL_DELIVERY_SECRET=<secret> \
bun run smoke:saas-live -- --json
```

For the full local gate:

```bash
bun run verify
bun run test
bun run test:slow
```

Run real Postgres E2E tests only when `DATABASE_URL` points at a disposable
Postgres database with pgvector enabled.

## Admin UI Changes

The admin app is a Next.js static export embedded into the hosted server.

```bash
cd admin
bun run build
cd ..
bun run build:admin-embedded
```

Prefer shadcn components and the existing Cortex console patterns. Console pages
should be dense, scannable, and operational. Avoid marketing layouts inside the
admin shell.

After meaningful UI changes, verify the rendered flow:

1. marketing page
2. signup
3. onboarding URL
4. admin login
5. team invite
6. agent client registration
7. integrations
8. runtime manifest
9. quality gates

## Adding A Control-Plane Feature

Every tenant feature needs both human and agent access.

1. Add or update the data model in `src/core/saas-control-plane.ts`.
2. Add HTTP/admin API handling in `src/commands/serve-http.ts` when the console
   needs it.
3. Add or verify the MCP/operation path in `src/core/operations.ts` or the
   hosted dispatch layer.
4. Add tests for tenant scoping, permissions, and failure cases.
5. Update docs and runtime manifests if agents need setup instructions.
6. Run `bun run check:cortex-public-copy`.

## Runtime Packaging

Runtime packaging must stay thin and hosted-first. The package should read an
onboarding URL, store the tenant endpoint, and write native client config without
copying secrets into public manifests.

Relevant commands:

```bash
bun run package:runtime
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor
cortex runtime install claude-desktop
cortex runtime install claude-code --json
```

The public manifest endpoints must stay secret-free:

```text
/runtime-manifest.json
/admin/api/runtime-manifest
MCP saas_runtime_manifest
```

## Public Copy

Public docs, UI, generated agent text, package metadata, and skills should say
Cortex. Use legacy names only where compatibility tests or historical migration
fixtures require them.

Before handoff:

```bash
bun run check:cortex-public-copy
```

## Test Isolation

Keep tests deterministic and tenant-safe.

- Use `withEnv()` for temporary environment changes.
- Disconnect embedded engines in `afterAll`.
- Use unique org, brain, source, email, and client ids in SaaS tests.
- Prefer narrow fixtures over shared global state.
- Keep secrets out of snapshots and screenshots.

## Security Checklist

- Validate tenant id, brain id, source id, scopes, and role on every mutation.
- Do not put client secrets into onboarding URLs or runtime manifests.
- Rate-limit public signup, OAuth, webhook, and MCP endpoints.
- Require worker secrets for job drain endpoints.
- Keep hosted shell execution disabled unless an isolated runtime is in place.
- Add regression tests for authz boundaries.

## Handoff Standard

A change is ready to hand off when the relevant checks pass, the public copy guard
is clean, the agent path matches the human path, and any remaining production
dependency is named plainly.
