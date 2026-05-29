# Cortex SaaS Topologies

Cortex has one default product shape: a hosted, multi-tenant company-brain SaaS.
The console, API, MCP tools, runtime manifest, invite flow, and CLI all assume
that users and agents connect to a hosted tenant rather than creating a separate
standalone knowledge app on each machine.

Use this page to choose the right tenant boundary before onboarding a customer.
The short version: create sources for teams and workflows; create additional
brains only when the customer needs a hard isolation boundary.

## Product Boundaries

| Boundary | What It Means | Create Another One When |
| --- | --- | --- |
| Organization | Billing, domain, members, roles, invites, and plan limits. | A different company signs up. |
| Brain | Deployment and database boundary with its own public URL, OAuth surface, backups, and lifecycle. | Legal isolation, data residency, separate retention policy, large-scale performance, or acquisition separation requires it. |
| Source | Team, repository, department, integration, or project boundary inside one brain. | A team needs its own write namespace, ingestion status, or read/write scope. |
| Agent client | OAuth identity for a teammate, bot, integration, or customer-owned agent. | A runtime needs distinct scopes, token TTL, write source, or federated-read list. |
| Skill policy | Runtime-enforced capability rule tied to sources and clients. | A skill should be draft-only, limited to a team, or blocked for some agents. |

Sources are the SaaS answer to "sub-brains" for most customers. They let one
company brain hold engineering, support, sales, design, legal, and leadership
knowledge while still enforcing source-aware OAuth access.

## Decision Tree

```text
New customer signs up
  |
  v
Create one organization
  |
  v
Create the first company brain
  |
  v
Does a team need scoped content, ingestion, or permissions?
  |-- yes -> create a source
  |-- no  -> keep the default source
  |
  v
Does the customer need legal/data/region/performance isolation?
  |-- yes -> create another brain under the same organization
  |-- no  -> keep using sources
  |
  v
Does a human, bot, or integration need access?
  |-- yes -> create an invite or agent client with OAuth scopes
```

## Topology 1: One Organization, One Brain, Many Sources

This is the default onboarding path and the right starting point for most
companies.

```text
Organization: Acme
  Brain: Acme Company Brain
    Source: default
    Source: engineering
    Source: support
    Source: sales
    Source: leadership
```

What the customer gets:

- One hosted MCP endpoint for agents.
- One admin console for onboarding, invites, sources, skills, integrations,
  runtime setup, quality checks, billing state, and activity.
- Team-specific source boundaries with per-client write source and
  federated-read lists.
- One schema policy surface so the company can evolve its knowledge graph
  without duplicating work across deployments.

Use this when:

- The company is one commercial tenant.
- Most teams should discover shared knowledge.
- Security requirements can be expressed as source-level read/write scopes.
- The customer wants fast onboarding and low operational overhead.

## Topology 2: One Organization, Multiple Brains

Create multiple brains when source scoping is not strong enough because the
customer needs hard lifecycle or infrastructure separation.

```text
Organization: Acme
  Brain: Acme HQ
    Source: leadership
    Source: all-hands
  Brain: Acme EU
    Source: eu-support
    Source: eu-legal
  Brain: Acme M&A
    Source: diligence
    Source: board
```

Each brain has its own database, OAuth metadata, runtime manifest, backups,
public URL, plan usage accounting, and operational health. Team members can
receive separate invites per brain, and agents must connect to the correct MCP
endpoint for the work they are doing.

Use this when:

- Data residency or customer contracts require separate databases.
- A sensitive unit needs independent retention or backup policy.
- Workloads are large enough that one database would become noisy.
- An acquired company needs a staged migration path into the parent org.

Do not create a new brain just because a department wants a cleaner sidebar.
Create a source first; upgrade to another brain only when the isolation boundary
needs independent infrastructure or compliance treatment.

## Topology 3: Dedicated Enterprise Brain

Some customers will need a dedicated deployment per brain with separate
infrastructure credentials, provider keys, and region selection.

```text
Cortex control plane
  Organization: Enterprise Customer
    Brain: Customer Dedicated Brain
      Supabase project: customer-owned or Cortex-managed
      Runtime host: customer region
      Public URL: customer subdomain
      OAuth clients: customer-scoped
```

This is still the same SaaS product. The difference is where the brain's
database and runtime live. The console should continue to show the same tabs and
the same agent parity operations, while deployment automation provisions the
brain-specific resources.

Use this when:

- The contract requires a dedicated database or network boundary.
- The customer brings an existing Supabase/Postgres project.
- The customer needs region pinning.
- The customer wants separate provider keys or observability exports.

## Topology 4: Runtime-Only Agent Clients

Humans and agents should never need to clone a full backend to use Cortex. They
connect through a thin runtime profile built from the onboarding payload:

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor
cortex runtime install claude-desktop
cortex runtime install claude-code --json
```

The onboarding URL carries the hosted MCP URL, token URL, client id, scopes,
write source, and federated-read list. The one-time secret is delivered out of
band. Runtime config writers store only the hosted MCP URL in Cursor, Claude
Desktop, Claude Code, ChatGPT connector instructions, or Perplexity connector
instructions.

Use this for every teammate and every customer-owned agent runtime. The hosted
brain remains the source of truth; the local runtime is only an adapter.

## Operational Rules

- Create sources for team-level boundaries.
- Create brains for infrastructure-level boundaries.
- Create OAuth clients for every human, bot, integration, or agent runtime.
- Keep client secrets out of onboarding URLs and runtime config files.
- Use the runtime manifest as the single packaging contract for CLI and plugin
  setup.
- Keep every console action mirrored by an MCP operation so agents can onboard,
  invite, connect, and administer tenants with the same authority model as
  humans.

## See Also

- `docs/architecture/brains-and-sources.md` - deeper source and brain boundary
  guidance.
- `docs/deploy/multi-tenant-saas.md` - production deployment and preflight.
- `docs/deploy/saas-runtime-packaging.md` - CLI and runtime plugin packaging.
- `docs/tutorials/company-brain.md` - complete company-brain onboarding flow.
