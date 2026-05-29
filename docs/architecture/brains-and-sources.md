# Brains and Sources

Cortex has two separate axes for organizing tenant knowledge. Users and
agents both need the distinction, because access and routing are different at
each layer.

## TL;DR

- An **organization** is the customer tenant.
- A **brain** is the database and deployment boundary for that tenant.
- A **source** is a named team, repo, or domain boundary inside one brain.
- Use another brain when ownership, lifecycle, residency, backup, or admin
  control changes.
- Use another source when the same organization owns the data and you need
  scoped writes or federated reads inside one company brain.

## Brain Axis

A brain is one database-backed runtime: Supabase Postgres in production, plus
the HTTP MCP server, OAuth clients, background jobs, file storage, backups,
and deployment URL that go with it.

Each brain has:

- Its own `pages`, `content_chunks`, embeddings, links, facts, jobs, and OAuth
  tables.
- Its own public MCP endpoint and OAuth token endpoint when hosted.
- Its own migration lifecycle, backups, deployment health, and incident
  boundary.
- Its own admin/operator lifecycle in the SaaS control plane.

In the SaaS, companies can create multiple brains. The default path is one
company brain per organization, then sources inside that brain for teams and
topics.

Create a separate brain for:

- Finance, legal, board, or executive material with a different admin surface.
- A customer-facing brain that should not share lifecycle with internal data.
- Region-specific data residency.
- M&A, diligence, or temporary workspaces with different retention.
- A scale boundary that should not share migrations or connection pools.

## Source Axis

A source is a named content boundary inside one brain. Every page row carries
a `source_id`, and slugs are unique per source rather than globally.

Use sources for:

- `shared`
- `engineering`
- `customers`
- `sales`
- `support`
- `internal`
- `legal`
- `docs`
- Per-repo or per-team knowledge bases

Sources power agent scoping:

- `source_id` is where a client writes.
- `federated_read` is the list of sources a client can read.
- OAuth clients and teammate invites should always show both values.

Example: one company brain can have `source=engineering` and
`source=customers`, and both can contain a slug like `meetings/weekly-sync`
without colliding.

## Decision Table

| You want to | Use |
| --- | --- |
| Add a new team or repo inside the same company knowledge base | A source |
| Give an agent write access only to engineering notes | `source_id=engineering` |
| Let an agent read engineering and shared context | `federated_read=["engineering", "shared"]` |
| Separate finance/legal lifecycle from general company context | A separate brain |
| Give a customer their own external-facing knowledge runtime | A separate brain |
| Enforce regional residency or separate backups | A separate brain |
| Organize a teammate's customer notes inside a team source | Folders inside the source |

Rule of thumb: if the data owner or operational lifecycle changes, use a
brain. If the owner stays the same and you need topic, team, repo, or access
scoping, use a source.

## Default SaaS Topology

```text
organization: Acme
  brain: company
    source: shared       federated=true
    source: engineering  federated=true
    source: customers    federated=true
    source: internal     federated=false
```

Most tenants should start here. The operator creates the organization, creates
the first brain, creates sources, then invites teammates and their agents with
source-scoped OAuth clients.

## Multi-Brain Tenant

```text
organization: Acme
  brain: company
    source: shared
    source: engineering
    source: customers

  brain: finance-legal
    source: board
    source: contracts
    source: investor-updates

  brain: customer-portal
    source: public-docs
    source: account-faqs
```

This shape is right when a customer needs different admins, lifecycle,
backups, retention, or external access for a subset of knowledge.

Cross-brain search is not SQL federation. It is an agent and product
orchestration layer: the agent decides which brain to query, synthesizes the
answers, and cites each result with its brain and source.

## Agent Routing Rules

- Start with the current tenant brain unless the user or task names another
  brain.
- Stay inside the OAuth client's `federated_read` list.
- Write only to the OAuth client's `source_id`.
- Ask for an invite or scoped client change instead of silently broadening
  access.
- Cite results with enough context for an operator to see the boundary:
  `brain:source:slug`.

## CLI Compatibility

The underlying runtime still supports local mounts and dotfile routing for
developer workflows:

- `--brain <id>` selects a brain/database.
- `--source <id>` selects a source inside that brain.
- `CORTEX_BRAIN_ID` and `CORTEX_SOURCE` provide environment defaults.
- `.cortex-mount` and `.cortex-source` can pin local checkouts.

Those mechanics are compatibility features. The hosted SaaS model should be
explained to customers as organization -> brain -> source -> member/agent.
