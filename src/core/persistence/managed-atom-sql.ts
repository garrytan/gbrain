/**
 * The `managed-atoms` checkpoint predicates over the op_checkpoints alias `ac` (constant SQL text for caller-given
 * constant column expressions; no values). Kept free of imports so the engine SQL modules (engine-sql/stale-atom-reads.ts)
 * read them without loading the persistence layer; persistence/atom-maintenance.ts re-exports them.
 */

/**
 * A `managed-atoms` checkpoint `ac` for one page at its current content hash, completed or failed. Keyed on the page id, not
 * the slug it was recorded under (#7462): a rename keeps the row and its content, so it is not a new extraction input.
 */
function managedAtomIdentitySql(page: { sourceId: string; pageId: string; contentHash: string }): string {
  return `ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=${page.sourceId}
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=${page.sourceId})
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=${page.pageId}::text AND ac.completed_keys->0->>'contentHash'=${page.contentHash}`;
}

/** The completed, failure-free `managed-atoms` checkpoint `ac` for one page at its current content hash. */
export function managedAtomCompletedSql(page: { sourceId: string; pageId: string; contentHash: string }): string {
  return `${managedAtomIdentitySql(page)}
    AND ac.completed_keys->0->>'failure' IS NULL`;
}

/**
 * #6325: discovery and the backlog skip a page whose current content completed or is held after repeated failures.
 * #7391: given the current input cap, a partial checkpoint recorded below it (one `releasePartialDispositions` clears) is not skipped.
 */
export function managedAtomDiscoverySql(maxInputChars?: string): string {
  return `AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ${managedAtomIdentitySql({ sourceId: 'p.source_id', pageId: 'p.id', contentHash: 'p.content_hash' })}
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')${maxInputChars ? `
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= ${maxInputChars})` : ''})`;
}

export const MANAGED_ATOM_DISCOVERY_SQL = managedAtomDiscoverySql();
