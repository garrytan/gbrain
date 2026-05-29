# Deploy Cortex as a Multi-Tenant SaaS

This deployment kit deploys Cortex as a hosted company-brain SaaS:

- `web`: `cortex serve --http` with OAuth 2.1, `/mcp`, `/admin/`, `/health`, scoped clients, and the activity feed. Startup applies cheap schema readiness; set `CORTEX_RUN_FULL_MIGRATIONS_ON_START=1` only on platforms without a release/migrate phase.
- `worker`: `cortex jobs supervisor` for scheduled and background work.
- `release`: schema and orchestrator migrations.
- `scripts/provision-company-brain.ts`: repeatable source and OAuth-client setup from a manifest.
- `/admin/`: the SaaS console for org onboarding, brains, sources, team invites, agents, skills, integrations, runtime packaging, jobs, activity, and quality checks.

Mount a persistent volume at `CORTEX_HOME` (`/data/cortex` in the Docker image). Cortex keeps source clones, audit files, and file-backed migration ledgers there; without the volume, a restart can lose operator state even though Postgres data is intact.

## Tenant Model

Model the product as `company tenant -> brains -> sources -> folders`.

A Cortex **brain** is a database boundary. It has its own Supabase database/project, deployment, public URL, OAuth surface, bootstrap token, backups, and lifecycle. A Cortex **source** is the team/repo/domain boundary inside one brain. Sources are the closest thing to "sub-brains" in the current Cortex model: they have their own slug namespace, sync state, federation policy, and OAuth read/write scoping, but they share one database and one server.

Every company tenant should get at least one deployed brain, usually named `company` or `default`. Companies can create multiple brains, but the default production shape is one Supabase-backed brain per company with multiple sources inside it.

Inside one customer brain, use the company-brain model from `docs/tutorials/company-brain.md`:

- Sources split domains like `shared`, `customers`, and `internal`.
- OAuth clients are issued per teammate or per teammate agent.
- `--source` controls the write source.
- `--federated-read` controls which sources that client can read.

Use a separate brain, not just a source, when the data owner or operational lifecycle changes: finance/legal/board material, a customer-facing brain, region-specific data residency, M&A workspaces, teams with separate admins/backups, or a scale boundary that should not share connection pools and migrations. Cross-brain search is an agent/product orchestration concern, not SQL federation.

Use a source inside the company brain when the same company owns the data and you mainly need team/topic/repo scoping: `sales`, `customers`, `engineering`, `internal`, `legal`, `shared`, or per-team knowledge repos. Use folders inside a source for teammate-level organization like `customers/alice-example/`.

For a lean internal deployment, one company brain is enough. For a commercial SaaS, provision one Supabase-backed database and deployment per company brain; only collapse companies into a shared database after you have a tenant registry, billing, support tooling, and isolation tests around every operator path.

The example multi-brain tenant plan lives at `deploy/saas/tenant-brains.example.yml`. Render its rollout commands with:

```bash
bun run plan:saas-tenant -- deploy/saas/tenant-brains.example.yml
```

## Admin Console

The hosted console at `/admin/` is now the primary operator surface:

- `Overview`: tenant readiness, live activity, hosted MCP contract.
- `Onboarding`: organization setup, first brain/source, scoped agent client, onboarding URL.
- `Brains`: current database/deployment boundary plus guidance for when to create another brain.
- `Sources`: add/list source boundaries inside a brain.
- `Team`: invite teammates, generate per-teammate agent clients, and inspect invite delivery outbox status.
- `Agents`: scoped OAuth clients with write-source and federated-read bindings; legacy bearer credentials are visible only for migration and revocation.
- `Skills`: skill catalog, triggers, allowed clients, source access, and annotated-call enforcement status.
- `Integrations`: Composio connector setup and ingestion webhook status.
- `Runtime`: CLI/plugin packaging manifest for each agent runtime.
- `Quality`: production and demo-readiness checks across Supabase/Postgres deployment, HTTPS OAuth origin, invite email, billing webhooks, bootstrap-token hygiene, onboarding, ingestion, OAuth, skills, jobs, and agent parity.
- `Settings`: tenant identity, security posture, plan tier, billing provider state, and hard-limit usage.

The console has a public signup route at `/admin/signup` backed by the SaaS control-plane tables. The operator dashboard remains protected by the admin bootstrap session. Signup and invite flows queue delivery outbox records; the Invites screen and MCP both support provider-backed Resend drains, manual batch claiming, and provider result acknowledgement. Production launch still needs identity, verified sending domains, checkout UI, and an automated provisioning worker as described in `docs/deploy/saas-runtime-packaging.md`.

Billing providers should post subscription lifecycle events to `POST /webhooks/billing` with `CORTEX_BILLING_WEBHOOK_SECRET` as `Authorization: Bearer`, `x-cortex-billing-secret`, or `x-cortex-webhook-secret`. The endpoint accepts Cortex-shaped JSON or Stripe-style `data.object` payloads with org and plan metadata, deduplicates by provider/event id, and reconciles plan key, status, customer id, subscription id, plan reference, current-period end, and billing sync timestamps into the same plan table used by humans and agents.

For v0-based UI iteration, use the product prompt in `docs/deploy/v0-ui-mvp-prompt.md`. It is scoped to the Next.js App Router admin app and the live SaaS API contract above.

Agent parity for this surface is handled by MCP operations with `users_admin`:
`saas_signup_create`, `saas_orgs_list`, `saas_orgs_create`,
`saas_brains_list`, `saas_brains_create`, `saas_team_list`,
`saas_sources_list`, `saas_sources_create`, `saas_integrations_status`,
`saas_invites_list`, `saas_invite_deliveries_list`,
`saas_invite_delivery_queue`, `saas_invite_deliveries_claim`,
`saas_invite_delivery_mark`, `saas_invite_deliveries_drain`,
`saas_skills_list`, `saas_skills_upsert`,
`saas_runtime_manifest`, `saas_plan_get`, `saas_plan_update`,
`saas_console_snapshot`, `saas_quality_snapshot`, `users_create_invite`, `users_register_agent_client`,
`users_update_agent_client_ttl`, and `users_revoke_agent_client`.

## Supabase Tenant Setup

For each customer/company tenant:

1. Create a Supabase project in the same region as the app host when possible.
2. Enable `vector` from the Supabase dashboard, or run `create extension if not exists vector;` in the SQL editor. Cortex migrations also create it, but doing this once during tenant setup catches permissions issues before deploy time.
3. Copy one Postgres connection string for the tenant:
   - Use the direct connection when the host supports IPv6.
   - Use Supavisor session mode for long-running Docker/VM processes that need IPv4, and copy the exact pooler host from Supabase's Connect dialog.
   - Use Supavisor transaction mode only for short-lived/serverless-style clients; append `?prepare=false` or set `CORTEX_PREPARE=false`.
   - When using a pooler URL on a host that cannot reach Supabase's direct `db.<project-ref>.supabase.co:5432` endpoint, set `CORTEX_DISABLE_DIRECT_POOL=1` so schema/DDL work stays on the pooler.
4. Keep `CORTEX_POOL_SIZE` small at first (`2` is a good default for one web process and one worker) and raise it only after watching Supabase connection usage.
5. Store the tenant's `CORTEX_DATABASE_URL`, public URL, bootstrap token, provider keys, and OAuth client credentials in the host secret manager.

The hosted Docker entrypoint fails before web startup if `CORTEX_DATABASE_URL`,
`CORTEX_PUBLIC_URL`, or a 32+ character `CORTEX_ADMIN_BOOTSTRAP_TOKEN` is
missing. On Railway, the entrypoint derives `CORTEX_PUBLIC_URL` from
`RAILWAY_PUBLIC_DOMAIN` when the service has public networking enabled; set
`CORTEX_PUBLIC_URL` explicitly for custom domains so OAuth issuer metadata and
onboarding URLs remain stable.

Supabase reference docs:

- [Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Disabling prepared statements](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)
- [Vector columns](https://supabase.com/docs/guides/ai/vector-columns)
- [Connection management](https://supabase.com/docs/guides/database/connection-management)

## Supabase-Backed Production Secrets

Set these in the platform secret manager, not in Git:

```bash
CORTEX_DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host-from-supabase>:5432/postgres'
CORTEX_PUBLIC_URL='https://brain.example.com'
CORTEX_HTTP_CORS_ORIGIN='https://brain.example.com'
CORTEX_HTTP_TRUST_PROXY=1
CORTEX_HOME=/data/cortex
CORTEX_POOL_SIZE=2
CORTEX_DISABLE_DIRECT_POOL=1
CORTEX_ADMIN_BOOTSTRAP_TOKEN='<random-hex>'
CORTEX_SUPPRESS_BOOTSTRAP_TOKEN=1
CORTEX_BILLING_WEBHOOK_SECRET='<random-hex>'
CORTEX_COMPOSIO_WEBHOOK_SECRET='<random-hex>'
CORTEX_EMAIL_PROVIDER=resend
RESEND_API_KEY='re_...'
CORTEX_EMAIL_FROM='Cortex <onboarding@your-domain.com>'
CORTEX_EMAIL_DELIVERY_SECRET='<random-hex>'
ZEROENTROPY_API_KEY='ze-...'
ANTHROPIC_API_KEY='sk-ant-...'
```

For Supabase transaction-pooler URLs on port `6543`, disable prepared statements with either the URL flag or an environment variable:

```bash
CORTEX_DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host-from-supabase>:6543/postgres?prepare=false'
# or
CORTEX_PREPARE=false
```

On Railway, keep `CORTEX_DISABLE_DIRECT_POOL=1` with Supabase pooler URLs unless you have separately verified that the service can connect to Supabase's direct IPv6 database endpoint.

Other Postgres providers still work if `pgvector` is enabled, but the SaaS deployment path assumes Supabase unless you intentionally swap providers.

Leave `CORTEX_ALLOW_SHELL_JOBS` unset in hosted SaaS unless you explicitly need shell-job execution and have isolated the tenant environment for it. Workers assume the `migrate` process or the web process has already applied schema readiness; set `CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS=1` only for a standalone worker deployment.

## Local Docker Stack

Use the production-shaped Compose stack for a local smoke test:

```bash
docker compose -f docker-compose.saas.yml --profile tools run --rm migrate
docker compose -f docker-compose.saas.yml up web worker
curl http://localhost:3131/health
open http://localhost:3131/admin/
```

This uses the same image and entrypoint as hosted deployments, plus a local `pgvector/pgvector:pg16` database. Tear it down with:

```bash
docker compose -f docker-compose.saas.yml down -v
```

## Live SaaS Smoke

After any Railway, Fly, or Supabase-backed deployment, run the live SaaS smoke before handing the URL to agents or customers:

```bash
CORTEX_PUBLIC_URL='https://<tenant-host>' \
CORTEX_ADMIN_BOOTSTRAP_TOKEN='<admin-bootstrap-token>' \
CORTEX_COMPOSIO_WEBHOOK_SECRET='<composio-webhook-secret>' \
CORTEX_BILLING_WEBHOOK_SECRET='<billing-webhook-secret>' \
bun run smoke:saas-live
```

The smoke creates a real test organization, owner onboarding URL, owner and teammate invite delivery outbox records, claims the delivery batch, marks the teammate delivery sent, verifies the provider drain route reports readiness, reconciles a billing event, creates a teammate invite, federated source, skill policy, source-scoped OAuth client, Composio ingestion event, OAuth access token, MCP `tools/list` request, owner-scoped MCP `saas_integrations_status` call, and owner-scoped MCP `saas_quality_snapshot` call. It also fails if public pages, signup responses, invite responses, billing responses, MCP tool metadata, MCP integration payloads, or MCP quality payloads leak legacy product branding.

Use `--json` for CI artifacts, `--base-url` / `--admin-token` / `--composio-secret` / `--billing-secret` to avoid env files. Use `--skip-composio` or `--skip-billing` only for temporary environments where that integration is intentionally disabled.

The quality snapshot intentionally distinguishes a demo tunnel from a durable SaaS deployment. A PGLite-backed Cloudflare demo can pass signup, OAuth, MCP, skills, and source-ingestion flows while still failing the production deployment gates until the tenant runs on Supabase/Postgres with a stable HTTPS `CORTEX_PUBLIC_URL`, Resend invite delivery, billing webhook secret, and suppressed bootstrap-token logging.

## Fly.io

```bash
cp fly.toml.example fly.toml
fly launch --no-deploy
fly volumes create cortex_data --region iad --size 1
fly secrets set CORTEX_DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host-from-supabase>:5432/postgres'
fly secrets set CORTEX_PUBLIC_URL='https://<app>.fly.dev'
fly secrets set CORTEX_HTTP_CORS_ORIGIN='https://<app>.fly.dev'
fly secrets set CORTEX_ADMIN_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)" CORTEX_SUPPRESS_BOOTSTRAP_TOKEN=1
fly secrets set ZEROENTROPY_API_KEY='ze-...' ANTHROPIC_API_KEY='sk-ant-...'
fly deploy
fly scale count web=1 worker=1
```

Verify:

```bash
curl https://<app>.fly.dev/health
open https://<app>.fly.dev/admin/
```

## Railway, Render, Heroku, Or Any Docker Host

Use the root `Dockerfile`.

The container entrypoint is production-guarded for hosted web services:

- `CORTEX_DATABASE_URL`/`DATABASE_URL` is required so the app cannot silently
  fall back to a disposable local store.
- `CORTEX_PUBLIC_URL` is required, or derived from Railway's
  `RAILWAY_PUBLIC_DOMAIN` for Railway public-networked services.
- `CORTEX_ADMIN_BOOTSTRAP_TOKEN` must be set and at least 32 characters.
- Bootstrap token logging is suppressed by default.
- `CORTEX_ALLOW_SHELL_JOBS` must remain unset/false in the hosted entrypoint.

Run the web process:

```bash
/usr/local/bin/cortex-entrypoint web
```

Run one worker process:

```bash
/usr/local/bin/cortex-entrypoint worker
```

Run release migrations:

```bash
/usr/local/bin/cortex-entrypoint migrate
```

The included `Procfile` declares `web`, `worker`, and `release` for platforms that understand process types. If your platform only supports one start command per service, create two services from the same image: one using `web`, one using `worker`.

On platforms without a release process, run `/usr/local/bin/cortex-entrypoint migrate` manually before first traffic, or set `CORTEX_RUN_FULL_MIGRATIONS_ON_START=1` for the first deploy and turn it back off after the boot succeeds.

## Provision A Company Brain

Create tenant repos, then edit `deploy/saas/company-brain.example.yml`:

```yaml
sources:
  - id: shared
    url: https://github.com/your-org/shared-wiki.git
  - id: customers
    url: https://github.com/your-org/customers.git
  - id: internal
    url: https://github.com/your-org/internal-docs.git
```

Before applying changes to a tenant database, run the preflight checker against the tenant secrets and manifest:

```bash
bun run preflight:saas -- \
  --env-file .env.saas \
  --manifest deploy/saas/company-brain.yml
```

The preflight catches common SaaS mistakes before they reach Supabase: placeholder connection strings, transaction-pooler URLs without `prepare=false`, missing pooler-only DDL mode on IPv4-only hosts, non-HTTPS public URLs, missing bootstrap tokens, enabled shell jobs, oversized pools, and invalid source/client boundaries.

For Railway, apply the tenant env file through the guarded helper before
deploying. The helper runs the SaaS preflight first, redacts values in dry runs,
and applies service-specific `CORTEX_PROCESS` values so the worker service does
not accidentally become the public web process.

```bash
railway service link acme-company-brain-web
railway volume add --mount-path /data
railway service link acme-company-brain-worker
railway volume add --mount-path /data

bun run railway:apply-env -- \
  --env-file .env.saas \
  --manifest deploy/saas/company-brain.yml \
  --web-service acme-company-brain-web \
  --worker-service acme-company-brain-worker \
  --environment production \
  --strict-preflight
```

From a machine with access to the deployed database:

```bash
CORTEX_DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host-from-supabase>:5432/postgres' \
  bun run scripts/provision-company-brain.ts deploy/saas/company-brain.example.yml \
  --local \
  --sync \
  --credentials-out acme-oauth-clients.json
```

If the Cortex CLI is already installed on the machine running provisioning, use it instead of the local checkout:

```bash
bun run scripts/provision-company-brain.ts deploy/saas/company-brain.yml \
  --cortex-bin cortex \
  --sync \
  --credentials-out acme-oauth-clients.json
```

If you rerun provisioning later, use `--skip-clients` unless you intentionally want to mint fresh OAuth client secrets.

## Connect Teammates

For each teammate, share the generated onboarding URL and one-time `client_secret`:

```bash
cortex connect '<onboarding-url>' --client-secret '<client_secret>'
cortex runtime install cursor --manifest-url https://brain.example.com/runtime-manifest.json
cortex runtime install cursor
cortex runtime install claude-desktop
```

The URL carries the MCP URL, token URL, client id, scopes, write source, and federated-read sources. It never carries the secret. `cortex init --mcp-only` remains the lower-level fallback when you need to pass each field manually.

Then configure their AI client to use the hosted MCP URL directly. `cortex runtime install` writes Cursor and Claude Desktop config without copying the OAuth client secret into those runtime files.

## Operations

Health:

```bash
curl https://brain.example.com/health
cortex doctor --json
cortex sources status
```

Upgrade:

```bash
cortex upgrade
cortex apply-migrations --yes
cortex doctor --json
```

Source isolation smoke:

```bash
CORTEX_HOME=/tmp/cortex-alice \
cortex connect '<alice-onboarding-url>' --client-secret '<alice_secret>'

CORTEX_HOME=/tmp/cortex-alice cortex search 'performance review' --json
```

Every returned row should have a `source_id` inside that client's `federated_read` set.
