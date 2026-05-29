# Tenant Data Ownership

Cortex is a hosted, multi-tenant SaaS. The durable system of record is the
tenant's managed database plus its configured source connectors, not a local
repo on an operator's machine.

This document replaces the old repo-backed single-user recovery model for
customer-facing deployments. Historical import and migration code may still
support file-backed sources, but production Cortex tenants are operated as
hosted company brains with explicit backups, invite records, OAuth clients,
source scopes, runtime manifests, and audit logs.

## Canonical State

Each tenant has state in three classes:

| Class | Examples | Recovery posture |
| --- | --- | --- |
| Tenant control plane | organizations, brains, members, invites, plans, skill policies | Back up and restore from the managed database. |
| Runtime security | OAuth clients, hashed client secrets, access tokens, admin sessions | Back up metadata where appropriate; never export plaintext secrets. |
| Indexed knowledge | pages, chunks, links, facts, takes, source sync state | Rebuildable from connectors and source snapshots when the source is still authoritative; otherwise backed up as tenant data. |

The hosted database is not disposable cache in production. It contains billing
state, invite outbox state, agent client metadata, skill policy decisions, and
audit history that are not reconstructible from source files.

## Source Connectors

Sources are the team, repo, topic, or customer boundary inside a brain. They can
ingest from Composio, Slack, repo sync, meeting webhooks, manual uploads, or a
legacy folder import. A source has:

- A stable `source_id`.
- A human-readable name.
- Optional remote URL or connector metadata.
- A federated-read flag.
- Sync and ingestion status.

Agents and humans write through a scoped OAuth client. The client's write source
and federated-read list decide which rows it can create or query.

## Backups

Production Cortex deployment must back up:

- Postgres/Supabase database snapshots.
- Storage buckets or file sidecars used for originals.
- Connector metadata needed to replay ingestion.
- Deployment secrets in the host secret manager.

Do not rely on an operator's local clone as the only recovery path. Local
runtime installs are thin clients of the hosted tenant.

## Rebuilds

Some derived state can be rebuilt:

- Search chunks can be regenerated from `pages`.
- Embeddings can be re-created from chunks.
- Link/fact/take projections can be reconciled from page content.
- Source sync jobs can be requeued.

Rebuilds are maintenance operations on the hosted tenant, usually run through
`cortex doctor --remediate`, `cortex sync`, `cortex reindex`, or background jobs.
They do not replace database backups.

## Privacy Boundary

Tenant privacy is enforced by source scoping, OAuth clients, role scopes, admin
sessions, and skill policies. Private or restricted source data must stay behind
the same authorization checks whether it is returned through the console, CLI,
or MCP.

Every new user-visible operation must answer:

1. Which organization and brain does it operate on?
2. Which source does it write to?
3. Which sources may it read?
4. Which OAuth client, member, or admin session authorized it?
5. Is the same operation available to agents through the MCP/control-plane API?

## Rule For New Code

When adding new tenant data:

1. Decide whether it is control-plane state, runtime security state, indexed
   knowledge, or derived cache.
2. Store tenant-owned state in the managed database with an organization/brain
   boundary.
3. Add backup or replay notes for non-derived data.
4. Ensure agent and human paths share the same authorization and audit model.
5. Add the route or MCP operation to the SaaS smoke coverage when it affects
   onboarding, invites, sources, skills, plans, clients, or runtime manifests.

## Related

- [Multi-Tenant SaaS Deployment](../deploy/multi-tenant-saas.md)
- [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md)
- [Brains And Sources](./brains-and-sources.md)
- [Cortex Verification](../CORTEX_VERIFY.md)
