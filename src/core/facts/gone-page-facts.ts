/**
 * The facts a page takes with it when a retention purge removes its row for good. Facts have no foreign key to pages,
 * so left active they would come back for every reader once the tombstone that hid them is gone, and a new page at the
 * slug would pick them up. They are expired (kept, never deleted):
 *
 * - the facts filed on the page (`source_markdown_slug` is the page). Ontology observations (`dimension` set) are not
 *   filed there: their `source_markdown_slug` is provenance, so an observation about a live entity sourced from the
 *   purged page stays;
 * - the facts extracted from the page and filed on none (#8859: the backstop's database-only rows, which name the page
 *   only as their context head; extractedFromPageSql);
 * - the facts about the page (`entity_slug` is the page) that no page row holds. A fact held by another page, live or
 *   soft-deleted, stays that page's: a restore brings it back, and that page's own purge expires it.
 *
 * Each case is its own update, so each uses its slug index.
 */

/** facts.source values written by page-extraction paths, whose context head is the source page slug. */
export const PAGE_EXTRACTION_SOURCE_LIST = ['mcp:put_page', 'sync:import', 'file_upload', 'code_import'] as const;

/**
 * #8859: true when the fact `alias` was extracted from the page whose slug is the SQL expression `slug` and is filed on
 * no page: recordedPageSlug (subject-infer.ts) in SQL. Before #5831 atom pages produced such rows by the thousand.
 */
export function extractedFromPageSql(alias: string, slug: string): string {
  return `(${alias}.source_markdown_slug IS NULL AND ${alias}.source IN (${PAGE_EXTRACTION_SOURCE_LIST.map(s => `'${s}'`).join(', ')})
    AND (${alias}.context = ${slug} OR starts_with(${alias}.context, ${slug} || ' — ')))`;
}

/** `$1` source ids and `$2` slugs, paired by position. */
const GONE = 'unnest($1::text[], $2::text[]) AS g(source_id, slug)';
const EXPIRE_FILED_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.source_markdown_slug = g.slug AND f.expired_at IS NULL AND f.dimension IS NULL`;
const EXPIRE_EXTRACTED_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.expired_at IS NULL AND ${extractedFromPageSql('f', 'g.slug')}`;
const EXPIRE_ABOUT_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.entity_slug = g.slug AND f.expired_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM pages hp WHERE hp.source_id = f.source_id AND hp.slug = f.source_markdown_slug AND hp.slug <> g.slug)`;

/** Expires the purged pages' facts; run it in the transaction that deletes the page rows, after the delete. */
export async function expireGonePageFacts(
  exec: { executeRaw(sql: string, params?: unknown[]): Promise<unknown[]> },
  pages: ReadonlyArray<{ source_id: string; slug: string }>,
): Promise<void> {
  if (!pages.length) return;
  const params = [pages.map(p => p.source_id), pages.map(p => p.slug)];
  await exec.executeRaw(EXPIRE_FILED_SQL, params);
  await exec.executeRaw(EXPIRE_EXTRACTED_SQL, params);
  await exec.executeRaw(EXPIRE_ABOUT_SQL, params);
}
