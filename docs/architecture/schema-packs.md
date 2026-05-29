# Schema Packs

Schema packs describe the shape of a tenant brain: the page types, source
folders, frontmatter conventions, link verbs, and filing rules that agents use
when ingesting or querying company knowledge.

In Cortex SaaS, schema packs are tenant configuration. Operators choose or
customize them from the console or through agent-callable control-plane
operations. A local config file can still exist for thin clients and development,
but hosted tenants resolve schema from the tenant/brain/source context first.

## Bundled Packs

- `cortex-base-v2`: compatibility pack for the historical core taxonomy.
- `cortex-recommended`: the recommended company-brain shape documented in
  [Cortex Recommended Schema](../CORTEX_RECOMMENDED_SCHEMA.md).

Internal migration identifiers may differ while migrations settle, but customer
docs, runtime manifests, and the admin console present Cortex-branded pack names
and descriptions.

## Tenant Resolution

When a hosted request needs a schema pack, Cortex resolves in this order:

| Tier | Source | Notes |
| --- | --- | --- |
| 1 | Per-source tenant config | Team or connector-specific shape. |
| 2 | Brain-level tenant config | Default for the company brain. |
| 3 | Organization default | Shared across newly created brains. |
| 4 | Runtime manifest hint | Thin clients can display the expected pack. |
| 5 | Bundled default | `cortex-recommended` for new SaaS tenants. |

MCP requests must not accept an arbitrary untrusted schema-pack override. Agents
can request schema updates through the control plane, where the change is
audited and scoped to the tenant.

## How Agents Use Packs

Every read and write path should consult the resolved pack:

- Ingest decides the page type and destination source.
- Search and expert routing use pack-level type metadata.
- Fact/take extraction checks which types are extractable.
- Skill policies can require specific source access before a skill runs.
- Admin UI previews explain why a page was filed a certain way.

## Customization Flow

1. Start with `cortex-recommended`.
2. Import or connect representative sources.
3. Use schema detection to identify unmatched folders or unknown page types.
4. Review candidates in the console.
5. Promote accepted types into the tenant pack.
6. Re-run targeted sync/reindex jobs for affected sources.

Agents should expose the same flow with MCP operations or documented commands,
but humans remain able to review and approve schema changes in the console.

## Authoring Contract

A pack manifest must include:

- Stable `name` and `version`.
- Page types with path prefixes and primitive category.
- Which types are extractable, enrichable, or eligible for expert routing.
- Link verbs and allowed source/target types.
- Filing rules written for agents.

Pack updates are tenant changes. Persist who requested the change, which sources
it affects, and whether a reindex is required.

## Deferred Work

- Full per-source pack federation across cross-source queries.
- UI review of detected schema candidates.
- Publishing curated Cortex pack templates through the runtime package.
- Migration helpers for renaming existing page types inside a tenant.
