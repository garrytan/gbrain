/**
 * Link-type ranking participation: the one policy every reader that turns
 * links into a ranking signal honors.
 *
 * A non-ranking link type records metadata about a page (for example that a
 * record amends another record) without saying the target matters more. Its
 * edges stay ordinary references: get_links, get_backlinks, graph traversal,
 * entity-card edges and backlink_count, and the referrer path still return
 * them. They never feed a ranking signal: the backlink boost, the in-set and
 * cross-source adjacency boosts, relational fanout hops, relational chain
 * hops and the typed (hub) degree, the enrich inbound-link order, the
 * connection count that picks a canonical entity, generated-page demotion and
 * entity anchoring.
 *
 * The policy lives in code, not in a schema pack field, so a pack that
 * declares one of these types loads on any gbrain. Contract:
 * docs/guides/temporal-edges.md ("Amendments: the amends link").
 */

/** Link types that take no part in ranking. */
export const NON_RANKING_LINK_TYPES: readonly string[] = Object.freeze(['amends']);

/** True when edges of this type may feed a ranking signal. */
export function linkTypeRanks(linkType: string): boolean {
  return !NON_RANKING_LINK_TYPES.includes(linkType);
}

/**
 * SQL predicate over a `links` row alias: TRUE when the row may feed a
 * ranking signal. The type names are code constants inlined as literals, so
 * the fragment composes into statements with any parameter numbering.
 */
export function rankingLinkSql(alias: string): string {
  return `${alias}.link_type <> ALL(ARRAY[${NON_RANKING_LINK_TYPES.map(t => `'${t}'`).join(', ')}]::text[])`;
}
