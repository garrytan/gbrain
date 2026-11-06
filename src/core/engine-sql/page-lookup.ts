/**
 * #7191: page lookups agents otherwise run on the filesystem: find by name
 * or path (`BrainEngine.findPages`, the `find_pages` op) and grouped page
 * counts (`BrainEngine.countPagesBy`, `get_stats` with `by`/`since`). One
 * implementation for both engines; reads take `ScopedRead` (Postgres runs
 * them in `withScopedReadTransaction`).
 *
 * Visibility: live pages (`deleted_at IS NULL`) in unarchived sources for
 * every caller; an untrusted caller's policy adds `pageReadFilter(..., live)`,
 * the shared read-policy predicate (private pages, trust floor, quarantine).
 * Find also hides the ranked-search hard-exclude prefixes
 * (`buildHardExcludeClause` over `resolveHardExcludes`, resolved by the op).
 *
 * Index use: a find pattern is one ILIKE pattern. A name pattern matches
 * `title` or the slug (rechecked on its last segment), so `idx_pages_trgm`
 * and `idx_pages_slug_trgm` combine in a BitmapOr. A glob or prefix pattern
 * also matches `source_path`, which has no trigram index, so it reads every
 * page in scope (measured in the PR). Rows sort by `slug`, then `source_id`,
 * in the C collation so both engines and every database locale agree; the
 * distinct-slug counts use it too (a C sort is several times faster than a
 * locale sort, and both collations are deterministic, so counts match).
 */
import type { FindPagesQuery, FoundPage, FoundPages, UntrustedReadPolicy } from '../page-find.ts';
import type { PageCountQuery, PageCounts, TypeGrouper } from '../page-counts.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { buildHardExcludeClause } from '../search/sql-ranking.ts';
import type { ScopedRead } from './brands.ts';
import { sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { compileRowNormalizer } from './normalize.ts';

function visiblePages(scope: { sourceId?: string; sourceIds?: string[]; untrusted?: UntrustedReadPolicy }): SqlFragment {
  const source = scope.sourceIds && scope.sourceIds.length > 0
    ? sqlFragment`AND p.source_id = ANY(${scope.sourceIds}::text[])`
    : scope.sourceId
      ? sqlFragment`AND p.source_id = ${scope.sourceId}`
      : sqlFragment``;
  const policy = scope.untrusted ? trustedSql(`AND ${pageReadFilter('p', scope.untrusted, [], true)}`) : sqlFragment``;
  return sqlFragment`p.deleted_at IS NULL AND NOT s.archived ${source} ${policy}`;
}

const normalizeFound = compileRowNormalizer<FoundPage & { total: number }>({ total: 'bigint' });

export async function findPages(exec: ScopedRead, query: FindPagesQuery): Promise<FoundPages> {
  const like = query.pattern.like;
  const match = query.pattern.kind === 'name'
    ? sqlFragment`(p.title ILIKE ${like} OR (p.slug ILIKE ${like} AND regexp_replace(p.slug, '^.*/', '') ILIKE ${like}))`
    : sqlFragment`(p.slug ILIKE ${like} OR p.source_path ILIKE ${like})`;
  const types = query.types && query.types.length > 0 ? sqlFragment`AND p.type = ANY(${query.types}::text[])` : sqlFragment``;
  const hidden = trustedSql(buildHardExcludeClause('p.slug', query.excludeSlugPrefixes));
  const { rows } = await exec.run(sqlFragment`
    SELECT p.slug, p.source_id, p.type, p.title, p.source_path,
           to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
           count(*) OVER () AS total
      FROM pages p
      JOIN sources s ON s.id = p.source_id
     WHERE ${match} AND ${visiblePages(query)} ${types} ${hidden}
     ORDER BY p.slug COLLATE "C", p.source_id COLLATE "C"
     LIMIT ${query.limit}
  `);
  const found = rows.map(normalizeFound);
  return {
    rows: found.map(({ total: _total, ...page }) => page),
    total: found[0]?.total ?? 0,
  };
}

const normalizeTypeCount = compileRowNormalizer<{ source_id: string; type: string; pages: number }>({ pages: 'bigint' });
const normalizeDistinct = compileRowNormalizer<{ grp: string | null; is_total: boolean; pages: number; distinct_slugs: number }>({
  pages: 'bigint', distinct_slugs: 'bigint',
});

export async function countPagesBy(exec: ScopedRead, query: PageCountQuery, groupTypes?: TypeGrouper): Promise<PageCounts> {
  const since = query.since
    ? sqlFragment`AND COALESCE(p.effective_date, p.updated_at, p.created_at) >= ${query.since}::text::timestamptz`
    : sqlFragment``;
  const where = sqlFragment`${visiblePages(query)} ${since}`;
  const bySourceType = (await exec.run(sqlFragment`
    SELECT p.source_id, p.type, count(*) AS pages
      FROM pages p
      JOIN sources s ON s.id = p.source_id
     WHERE ${where}
     GROUP BY p.source_id, p.type
  `)).rows.map(normalizeTypeCount);
  if (!groupTypes) {
    const [total] = (await exec.run(sqlFragment`
      SELECT NULL::text AS grp, true AS is_total, count(*) AS pages, count(DISTINCT p.slug COLLATE "C") AS distinct_slugs
        FROM pages p
        JOIN sources s ON s.id = p.source_id
       WHERE ${where}
    `)).rows.map(normalizeDistinct);
    return { bySourceType, byTypeGroup: [], total: { pages: total?.pages ?? 0, distinct_slugs: total?.distinct_slugs ?? 0 } };
  }
  const types = [...new Set(bySourceType.map((row) => row.type))];
  const groups = groupTypes(types);
  const rows = (await exec.run(sqlFragment`
    SELECT m.grp, GROUPING(m.grp) = 1 AS is_total, count(*) AS pages, count(DISTINCT p.slug COLLATE "C") AS distinct_slugs
      FROM pages p
      JOIN sources s ON s.id = p.source_id
      JOIN unnest(${types}::text[], ${groups}::text[]) AS m(type, grp) ON m.type = p.type
     WHERE ${where}
     GROUP BY GROUPING SETS ((m.grp), ())
  `)).rows.map(normalizeDistinct);
  const total = rows.find((row) => row.is_total);
  return {
    bySourceType,
    byTypeGroup: rows.filter((row) => !row.is_total).map((row) => ({ group: row.grp ?? '', pages: row.pages, distinct_slugs: row.distinct_slugs })),
    total: { pages: total?.pages ?? 0, distinct_slugs: total?.distinct_slugs ?? 0 },
  };
}
