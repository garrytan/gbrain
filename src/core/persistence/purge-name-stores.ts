import type { BrainEngine } from '../engine.ts';

/**
 * #9068: the two stores that keep a page's name next to its slug. context_volunteer_events logs each time the page
 * was volunteered, with a rationale that quotes the matched name; mention_gazetteer_entries keeps the page's
 * normalized title and aliases for the mention pass. Neither has a foreign key to pages, so a purge's cascade never
 * reaches them: every hard delete of a page calls this inside its transaction. A soft delete keeps both, because
 * restore_page can bring the page back. Returns rows removed per store, keyed as the purge receipt names them.
 */
export async function scrubPurgedNameStores(
  engine: Pick<BrainEngine, 'deletePurgedNameStoreRows'>,
  sourceId: string,
  slugs: readonly string[],
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  return { ...await engine.deletePurgedNameStoreRows(sourceId, slugs) };
}
