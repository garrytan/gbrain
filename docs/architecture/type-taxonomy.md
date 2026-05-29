# Type Taxonomy

Cortex uses a compact type taxonomy so search filters, extraction rules,
schema packs, and expert routing stay predictable across tenants.

## Principles

- Types must be stable enough for agents to route against.
- Tenant schema packs may extend the defaults.
- Source-specific customization should not break cross-source retrieval.
- Migration helpers must preserve the original type in metadata when retyping
  existing pages.

## Default Shape

New SaaS tenants should start from the Cortex recommended schema, then add
tenant-specific types only when repeated source content proves the need.

Common primitives:

- people
- companies
- projects
- meetings
- deals
- concepts
- docs
- incidents
- customers
- sources

## Migration Rule

When unifying noisy historical types:

1. Preserve the legacy type.
2. Retype into the closest canonical type.
3. Add alias rows when old slugs need to resolve.
4. Run retrieval and source-scope regressions.
5. Explain the change in the tenant operations log.

## Related

- [Schema Packs](schema-packs.md)
- [Cortex Recommended Schema](../CORTEX_RECOMMENDED_SCHEMA.md)
