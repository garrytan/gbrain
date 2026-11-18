/**
 * Tags: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/tags.json`). `addTag` / `removeTag` already share one
 * page-state guarded implementation (`page-state/tags.ts`) and stay there.
 * `getTags` was unscoped on master (EO4 inventory): `LegacyUnscopedRead`.
 */
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

export async function getTags(
  exec: LegacyUnscopedRead,
  slug: string,
  opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; liveOnly?: boolean },
): Promise<string[]> {
    // #2200: federated grant (sourceIds[]) wins over scalar sourceId. Use
    // `page_id IN (subquery)` — NOT `= (subquery)` — because a federated read of
    // a slug present in >1 allowed source resolves multiple page-ids, which would
    // throw under the scalar-subquery form. DISTINCT unions tags across the
    // matched pages. Scalar/unscoped path keeps the legacy `?? 'default'` default.
    const scope =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? sqlFragment`source_id = ANY(${opts.sourceIds}::text[])`
        : sqlFragment`source_id = ${opts?.sourceId ?? 'default'}`;
    const privacy = opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterForCaller('pages')}`) : sqlFragment``;
    const live = opts?.liveOnly ? sqlFragment`AND deleted_at IS NULL` : sqlFragment``;
    const { rows } = await exec.run<{ tag: string }>(sqlFragment`
      SELECT DISTINCT tag FROM tags
      WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug} AND ${scope} ${privacy} ${live})
      ORDER BY tag
    `);
    return rows.map((r) => r.tag);
  }

/**
 * Delete a page's frontmatter-owned tags that are not in `keep` (a tag that left the frontmatter). Tags an explicit
 * add owns (`tag_source = 'added'`) and legacy NULL rows are never deleted here (#1621).
 */
export async function pruneFrontmatterTags(exec: SqlExecutor, slug: string, keep: readonly string[], opts?: { sourceId?: string }): Promise<void> {
  await exec.executeRaw(`DELETE FROM tags t USING pages p WHERE p.id = t.page_id AND p.source_id = $1 AND p.slug = $2
          AND t.tag_source = 'frontmatter' AND NOT (t.tag = ANY($3::text[]))`, [opts?.sourceId ?? 'default', slug, [...keep]]);
}

/**
 * #5984: add many tags to one page by its id (the caller wrote the page in this transaction and holds its page guard):
 * one statement. An explicit add claims the tag; a `frontmatter` claim only adopts an unclaimed legacy (NULL) row.
 */
export async function addPageTagsById(exec: SqlExecutor, pageId: number, tags: readonly string[], opts?: { tagSource?: 'frontmatter' }): Promise<void> {
  if (!tags.length) return;
  await exec.executeRaw(opts?.tagSource === 'frontmatter'
    ? `INSERT INTO tags(page_id,tag,tag_source) SELECT $1,t,'frontmatter' FROM (SELECT DISTINCT unnest($2::text[]) AS t) u
        ON CONFLICT (page_id,tag) DO UPDATE SET tag_source = 'frontmatter' WHERE tags.tag_source IS NULL`
    : `INSERT INTO tags(page_id,tag,tag_source) SELECT $1,t,'added' FROM (SELECT DISTINCT unnest($2::text[]) AS t) u
        ON CONFLICT (page_id,tag) DO UPDATE SET tag_source = 'added'`, [pageId, [...tags]]);
}
