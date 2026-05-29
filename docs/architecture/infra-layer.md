# Cortex Infrastructure Layer

Cortex is the deterministic company-brain layer that hosted agents and humans
share. Skills and runtime adapters can use judgment, but tenant state,
authorization, ingestion, search, and audit need predictable infrastructure.

## Data Pipeline

```text
SOURCE EVENT OR IMPORT
  -> tenant/org/brain/source resolution
  -> parser and metadata normalization
  -> content hash and idempotency check
  -> chunking
  -> embedding
  -> transactional database write
  -> search, graph, and audit availability
```

Sources can come from Composio webhooks, repo sync, Slack, meetings, manual
uploads, or other connectors. Every row is stamped with tenant/source context so
OAuth clients and skill policies can enforce boundaries.

## Search Architecture

Cortex merges vector and keyword retrieval with Reciprocal Rank Fusion, then
deduplicates and scopes the result set before returning it through the CLI,
console, or MCP.

```text
QUERY
  -> optional expansion
  -> vector search
  -> keyword search
  -> RRF merge
  -> source authorization
  -> page/type diversity
  -> top results with citations
```

## Key Components

| File | Purpose |
| --- | --- |
| `src/core/engine.ts` | Pluggable engine interface. |
| `src/core/postgres-engine.ts` | Postgres and pgvector implementation. |
| `src/core/import-file.ts` | File/source import pipeline. |
| `src/core/sync.ts` | Source sync and change detection. |
| `src/core/markdown.ts` | Frontmatter and body parsing. |
| `src/core/embedding.ts` | Embedding batches and retry handling. |
| `src/core/search/hybrid.ts` | Vector and keyword merge. |
| `src/core/search/dedup.ts` | Result deduplication and diversity. |
| `src/core/storage.ts` | Storage backend abstraction. |
| `src/core/saas-control-plane.ts` | Organizations, brains, invites, plans, skills, and agent clients. |
| `src/core/saas-runtime-manifest.ts` | Runtime manifest and onboarding payload contract. |

## SaaS Control Plane

The control plane owns:

- Organizations and tenant brains.
- Sources and source-scoped permissions.
- Members, invites, and invite delivery outbox records.
- OAuth clients and token lifetime.
- Skill policies, allowed clients, and source access.
- Runtime manifests and onboarding links.
- Billing plan state and limit enforcement.

Every console action in these areas should have an agent-callable equivalent.

## Thin Runtime, Strong Platform

Local runtime installs should stay thin. They connect to hosted Cortex through
an onboarding URL and one-time client secret, then route tenant operations
through OAuth and MCP. The hosted platform remains the authority for source
scope, audit, skill policy, billing limits, and runtime manifests.

## Related

- [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md)
- [Tenant Data Ownership](./system-of-record.md)
- [Multi-Tenant SaaS Deployment](../deploy/multi-tenant-saas.md)
