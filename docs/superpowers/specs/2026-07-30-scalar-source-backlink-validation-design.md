# Scalar-source backlink validation design

## Problem

A page identity in a multi-source brain is `(source_id, slug)`, but the back-link validator currently reasons only about `slug`.

For an outbound edge:

```text
(source-a, concepts/origin) -> (source-a, people/target)
```

the validator accepts any reverse row whose bare slugs are:

```text
people/target -> concepts/origin
```

That can incorrectly accept a row ending at `(default, concepts/origin)` instead of `(source-a, concepts/origin)`.

The bug is not that scalar `getLinks(slug, { sourceId })` permits cross-source destinations. That behavior is intentional: scalar scope qualifies the near/from endpoint while trusted local callers retain visibility into explicit cross-source edges. The gap is that a returned `Link` does not carry the source identity of either endpoint, so callers cannot distinguish same-slug pages.

## Reproduction and evidence

A deterministic PGLite reproduction creates duplicate `concepts/a` and `people/b` pages in `default` and `team-x`, then adds:

```text
(team-x, concepts/a) -> (team-x, people/b)
(team-x, people/b) -> (default, concepts/a)
```

The second edge is not a valid reverse of the first. Nevertheless:

```ts
await engine.getLinks('people/b', { sourceId: 'team-x' })
```

returns the second row, and the current validator accepts it because `to_slug === 'concepts/a'`.

Both engines implement the same scalar rule: filter `f.slug` and `f.source_id`, join the actual destination by `to_page_id`, and do not filter `t.source_id`. Federated `sourceIds` is a separate branch that constrains all visible endpoints and takes precedence over scalar scope.

## Goals

1. Validate back-links by exact source-qualified endpoint identity.
2. Preserve explicit cross-source links for trusted scalar reads.
3. Preserve federated all-endpoint containment and `sourceIds` precedence.
4. Keep PostgreSQL and PGLite behavior identical.
5. Add strict red-before-green regressions using duplicate slugs across sources.
6. Avoid schema migrations and production operational changes.

## Non-goals

- Changing scalar link reads to same-source-only reads.
- Weakening or widening federated reads.
- Changing link write identity or database schema.
- Refactoring the atomic conditional-write branch.
- Coupling deployment, restart, or migration mechanics to the backlink code change. Release operations are handled separately after verification.

## Chosen approach

Extend the engine `Link` result with endpoint source identities and use those fields in the validator.

```ts
interface Link {
  from_slug: string;
  from_source_id: string;
  to_slug: string;
  to_source_id: string;
  // existing fields
  origin_slug?: string | null;
  origin_source_id?: string | null;
}
```

All `getLinks` and `getBacklinks` query branches in PostgreSQL and PGLite will project the source IDs from the pages already joined as `f`, `t`, and `o`. No filtering behavior changes.

This approach is preferred over a dedicated `hasExactLink` method because it keeps source identity attached to the link data everywhere, avoids duplicate engine SQL and per-edge existence queries, and matches existing source-qualified link-write and batch-row contracts.

Validator-only raw SQL is rejected because validators should consume the `BrainEngine` contract rather than bypass it with engine-specific schema knowledge.

## Engine semantics

The existing three read modes remain unchanged.

### Unscoped

`getLinks(slug)` returns rows from all same-slug from-pages across sources. Each row identifies the actual source of both endpoints.

### Scalar source

`getLinks(slug, { sourceId })` matches exactly `(sourceId, slug)` on the from side. A destination may belong to another source, and `to_source_id` reveals that exact identity.

The corresponding scalar `getBacklinks` rule continues to match the exact destination/to-page identity while allowing a cross-source referrer.

### Federated sources

`getLinks(slug, { sourceIds })` continues to constrain from and to endpoints to the grant. The origin join continues to redact an out-of-grant origin. `sourceIds` continues to take precedence over scalar `sourceId`.

Adding source IDs to returned in-grant endpoints does not disclose anything new: the existing result already discloses those pages' slugs and edges. An out-of-grant endpoint remains absent.

## Validator algorithm

The validator receives the source scope associated with the page being validated.

For every outbound edge:

```text
(from_source_id, from_slug) -> (to_source_id, to_slug)
```

it requires a reverse row:

```text
(to_source_id, to_slug) -> (from_source_id, from_slug)
```

Duplicate edge rows are deduplicated by the full endpoint pair `(from_source_id, from_slug, to_source_id, to_slug)`, not by bare target slug. This preserves separate reverse requirements when multiple same-slug origin pages point to one exact target.

For each target:

1. Read target outbound links using the target's exact scalar source when validation is scalar-scoped.
2. Under federated validation, retain the caller's `sourceIds` grant rather than converting it to scalar scope.
3. Accept only a returned row whose `from_source_id`, `from_slug`, `to_source_id`, and `to_slug` exactly match the expected reverse identity.
4. Emit the existing warning when no exact reverse exists.

This preserves legitimate cross-source pairs. For example:

```text
(source-a, concepts/origin) -> (source-b, people/target)
(source-b, people/target) -> (source-a, concepts/origin)
```

is valid.

## Validation context propagation

`PageValidationContext` must carry the relevant scalar or federated source scope. The writer and post-write lint paths must load the page with that scope and pass the same scope to nested validator reads.

This change is scoped to source routing needed by validation. It does not modify conditional-write revision or conflict semantics and must not be applied to the atomic conditional-write branch.

## Testing strategy

### PGLite strict-TDD regression

Add duplicate pages across `default` and a second source, then prove before the production fix that:

1. A forward edge in the second source plus a wrong-source reverse produces a warning.
2. Adding the exact reverse removes the warning.
3. A legitimate cross-source forward/reverse pair passes.
4. Two same-slug destination pages are not collapsed into one target identity.

The first assertion must fail against the pre-fix implementation.

### Engine contract tests

For PGLite and PostgreSQL:

1. Assert link rows expose exact from/to source IDs.
2. Assert scalar reads still return explicit cross-source destinations.
3. Assert federated reads still exclude out-of-grant endpoints.
4. Assert `sourceIds` still takes precedence over scalar `sourceId`.
5. Assert origin source identity is null when the origin is redacted by the federated branch.

### Parity and focused verification

Run:

- the focused backlink validator test;
- source-isolation and federated link tests;
- the Postgres/PGLite parity fixture with a test database;
- related writer/post-write tests;
- `bun run typecheck`.

Capture complete command output to files before inspecting summaries. Do not use production databases or restart the live service.

## Compatibility

The `Link` change is additive at runtime. Existing consumers that read only slug or provenance fields continue to work. TypeScript object literals typed as complete `Link` values may need source fields; if compatibility pressure is high, the source fields can initially be optional in the public type while engine implementations and validator tests require their presence. The preferred contract is required endpoint source IDs because every persisted link always has both pages and therefore both source IDs.

No schema migration is required because source IDs already live on the joined `pages` rows.

## Operational constraints

The implementation phase does not deploy, restart GBrain, run production migrations, or alter the atomic conditional-write branch. Release, migration, and restart operations are a separate verified workflow and do not change this design's engine or validator semantics.
