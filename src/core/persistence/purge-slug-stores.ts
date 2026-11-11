import type { BrainEngine } from '../engine.ts';

/**
 * #9146: the stores keyed to a page by source and slug with no foreign key to pages: proposed takes, open loops, the
 * core-edit notice base text, the page's free-text aliases (#6619), the redirects that resolve to it and the rename
 * rows that end at it. A redirect or rename from this slug to another page stays. The pages cascade never reaches
 * them, so every hard delete of a page calls this inside its transaction; delete_page purge:true was the only path
 * that did, and a tombstone that aged out kept all six. A soft delete keeps them, because restore_page can bring the
 * page back. `ifPresent` is for the restore replay, where the archive can predate a table. Returns rows removed per
 * store, keyed as the purge receipt names them.
 */
export async function scrubPurgedSlugStores(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slugs: readonly string[],
  opts: { ifPresent?: boolean } = {},
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const removed: Record<string, number> = {};
  const scrub = async (table: string, sql: string) => {
    if (opts.ifPresent) {
      const [found] = await engine.executeRaw<{ present: boolean }>('SELECT to_regclass($1::text) IS NOT NULL AS present', [table]);
      if (!found?.present) return;
    }
    removed[table] = (await engine.executeRaw(sql, [sourceId, [...slugs]])).length;
  };
  await scrub('take_proposals', 'DELETE FROM take_proposals WHERE source_id = $1 AND page_slug = ANY($2::text[]) RETURNING 1');
  await scrub('open_loops', 'DELETE FROM open_loops WHERE source_id = $1 AND page_slug = ANY($2::text[]) RETURNING 1');
  await scrub('core_edit_notices', 'DELETE FROM core_edit_notices WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1');
  await scrub('page_aliases', 'DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1');
  await scrub('slug_aliases', 'DELETE FROM slug_aliases WHERE source_id = $1 AND canonical_slug = ANY($2::text[]) RETURNING 1');
  await scrub('slug_rename_history', 'DELETE FROM slug_rename_history WHERE source_id = $1 AND new_slug = ANY($2::text[]) RETURNING 1');
  return removed;
}
