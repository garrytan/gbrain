// Reference / canon entities.
//
// A page with frontmatter `reference: true` is a reference-only entity — a
// figure or organization imported from a book / article / external source that
// the user reads ABOUT but does not actively interact with (e.g. Andy Grove,
// Kleiner Perkins). It keeps its real `type` (`person` / `company`), so it stays
// fully searchable, enrichable, linkable, and edge-resolvable — NOTHING about
// retrieval changes.
//
// The ONLY behavior it opts out of is the entity *coverage* metrics
// (`timeline_coverage`, `entity_link_coverage` + their onboard-nudge mirrors).
// Those metrics nudge "this entity should accumulate dated history / inbound
// links"; that assumption is right for people you actually deal with and wrong
// for canon imports, which have no dated events in the user's life. Excluding
// them keeps the metric honest and actionable instead of permanently red.
//
// Opt-in: absent / false / anything-but-true = normal entity (the default).
// Set via `gbrain reference <slug>` (or hand-edit frontmatter).

export const REFERENCE_FRONTMATTER_KEY = 'reference';

/**
 * SQL predicate (true for NON-reference pages) to AND into entity-coverage
 * denominators AND numerators so the ratio stays consistent. JSONB `->>` yields
 * text; `IS DISTINCT FROM 'true'` treats absent (NULL) and every non-true value
 * as a normal counted entity. Backed by the GIN index on `pages.frontmatter`.
 *
 * @param alias optional table alias (e.g. 'p' for `pages p`); omit for bare `pages`.
 *
 * NOTE: postgres-engine.ts uses a postgres.js tagged template where `${}` is a
 * bound parameter, not raw SQL, so it inlines this predicate literally — keep
 * the two in sync.
 */
export function referenceExclusionSql(alias = ''): string {
  const col = alias ? `${alias}.frontmatter` : 'frontmatter';
  return `(${col}->>'${REFERENCE_FRONTMATTER_KEY}') IS DISTINCT FROM 'true'`;
}
