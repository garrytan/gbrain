/**
 * Tags: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/tags.json`). `addTag` / `removeTag` already share one
 * page-state guarded implementation (`page-state/tags.ts`) and stay there.
 * `getTags` was unscoped on master (EO4 inventory): `LegacyUnscopedRead`.
 */
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
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
    const privacy = opts?.excludePrivate ? trustedSql(`AND ${privatePagesFilterFragment('pages')}`) : sqlFragment``;
    const live = opts?.liveOnly ? sqlFragment`AND deleted_at IS NULL` : sqlFragment``;
    const { rows } = await exec.run<{ tag: string }>(sqlFragment`
      SELECT DISTINCT tag FROM tags
      WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug} AND ${scope} ${privacy} ${live})
      ORDER BY tag
    `);
    return rows.map((r) => r.tag);
  }
