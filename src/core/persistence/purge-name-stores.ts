import type { BrainEngine } from '../engine.ts';

/**
 * #9068: the two stores that keep a page's name next to its slug. context_volunteer_events logs each time the page
 * was volunteered, with a rationale that quotes the matched name; mention_gazetteer_entries keeps the page's
 * normalized title and aliases for the mention pass. Neither has a foreign key to pages, so a purge's cascade never
 * reaches them: every hard delete of a page calls this inside its transaction. A soft delete keeps both, because
 * restore_page can bring the page back. Returns rows removed per store, keyed as the purge receipt names them.
 */
export async function scrubPurgedNameStores(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slugs: readonly string[],
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const count = async (sql: string) => (await engine.executeRaw(sql, [sourceId, [...slugs]])).length;
  return {
    context_volunteer_events: await count('DELETE FROM context_volunteer_events WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1'),
    mention_gazetteer_entries: await count('DELETE FROM mention_gazetteer_entries WHERE source_id = $1 AND target_slug = ANY($2::text[]) RETURNING 1'),
    // #9146: slug-keyed stores with no foreign key to pages; every hard delete clears them, not only the direct purge.
    // #6619: a redirect from the purged slug to another page stays; only redirects that resolve to it go.
    take_proposals: await count('DELETE FROM take_proposals WHERE source_id = $1 AND page_slug = ANY($2::text[]) RETURNING 1'),
    open_loops: await count('DELETE FROM open_loops WHERE source_id = $1 AND page_slug = ANY($2::text[]) RETURNING 1'),
    core_edit_notices: await count('DELETE FROM core_edit_notices WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1'),
    page_aliases: await count('DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1'),
    slug_aliases: await count('DELETE FROM slug_aliases WHERE source_id = $1 AND canonical_slug = ANY($2::text[]) RETURNING 1'),
    slug_rename_history: await count('DELETE FROM slug_rename_history WHERE source_id = $1 AND new_slug = ANY($2::text[]) RETURNING 1'),
  };
}
