/**
 * The facts a page takes with it when its row goes away for good, or a new page replaces its tombstone: the active
 * facts filed on the page, and the active facts about it that no other live page holds. They are expired (kept, never
 * deleted), because facts have no foreign key to pages: left active, they would come back for every reader once the
 * tombstone that hid them is gone, and a new page at the slug would inherit them. Facts another live page holds about
 * the slug stay that page's. One predicate for every caller (the retention purges here, and a put over a tombstone).
 */

/** `$1` source ids and `$2` slugs, paired by position. */
const EXPIRE_GONE_PAGE_FACTS_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL
  FROM unnest($1::text[], $2::text[]) AS g(source_id, slug)
  WHERE f.source_id = g.source_id AND f.expired_at IS NULL
    AND (f.source_markdown_slug = g.slug OR (f.entity_slug = g.slug AND NOT EXISTS (SELECT 1 FROM pages lp
      WHERE lp.source_id = f.source_id AND lp.slug = f.source_markdown_slug AND lp.slug <> g.slug AND lp.deleted_at IS NULL)))`;

/** Expires the gone pages' facts; run it in the transaction that removes or replaces the pages. */
export async function expireGonePageFacts(
  exec: { executeRaw(sql: string, params?: unknown[]): Promise<unknown[]> },
  pages: ReadonlyArray<{ source_id: string; slug: string }>,
): Promise<void> {
  if (!pages.length) return;
  await exec.executeRaw(EXPIRE_GONE_PAGE_FACTS_SQL, [pages.map(p => p.source_id), pages.map(p => p.slug)]);
}
