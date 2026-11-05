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

const normalizeCount = compileRowNormalizer<{
  kind: string; source_id: string | null; type: string | null; types: string[] | null; pages: number; distinct_slugs: number;
}>({
  pages: 'bigint', distinct_slugs: 'bigint',
});

export async function countPagesBy(exec: ScopedRead, query: PageCountQuery, groupTypes?: TypeGrouper): Promise<PageCounts> {
  const since = query.since
    ? sqlFragment`AND COALESCE(p.effective_date, p.updated_at, p.created_at) >= ${query.since}::text::timestamptz`
    : sqlFragment``;
  const where = sqlFragment`${visiblePages(query)} ${since}`;
  // One statement, including the type inventory passed to the JS grouper.
  // A second read can see inserts/deletes/type changes even inside a READ
  // COMMITTED transaction. Do not change the caller's transaction isolation.
  const statement = !groupTypes ? sqlFragment`
    SELECT CASE WHEN GROUPING(p.source_id) = 1 THEN 'total' ELSE 'source_type' END AS kind,
           p.source_id, p.type, NULL::text[] AS types, count(*) AS pages,
           count(DISTINCT p.slug COLLATE "C") AS distinct_slugs
      FROM pages p JOIN sources s ON s.id = p.source_id
     WHERE ${where}
     GROUP BY GROUPING SETS ((p.source_id, p.type), ())
  ` : sqlFragment`
    WITH visible AS MATERIALIZED (
      SELECT p.source_id, p.type, p.slug COLLATE "C" AS slug
        FROM pages p JOIN sources s ON s.id = p.source_id
       WHERE ${where}
    ), slug_types AS (
      SELECT array_agg(DISTINCT type COLLATE "C" ORDER BY type COLLATE "C") AS types
        FROM visible GROUP BY slug
    )
    SELECT 'source_type' AS kind, source_id, type, NULL::text[] AS types,
           count(*) AS pages, 0::bigint AS distinct_slugs
      FROM visible GROUP BY source_id, type
    UNION ALL
    SELECT 'slug_types', NULL::text, NULL::text, types, 0::bigint, count(*)
      FROM slug_types GROUP BY types
  `;
  const rows = (await exec.run(statement)).rows.map(normalizeCount);
  const bySourceType = rows.filter(row => row.kind === 'source_type')
    .map(row => ({ source_id: row.source_id!, type: row.type!, pages: row.pages }));
  if (!groupTypes) {
    const total = rows.find(row => row.kind === 'total');
    return { bySourceType, byTypeGroup: [], total: { pages: total?.pages ?? 0, distinct_slugs: total?.distinct_slugs ?? 0 } };
  }
  const types = [...new Set(bySourceType.map(row => row.type))];
  const groups = groupTypes(types);
  const groupOf = new Map(types.map((type, i) => [type, groups[i]]));
  const byGroup = new Map<string, { group: string; pages: number; distinct_slugs: number }>();
  let pages = 0, distinctSlugs = 0;
  for (const row of bySourceType) {
    const group = groupOf.get(row.type) ?? '';
    const count = byGroup.get(group) ?? { group, pages: 0, distinct_slugs: 0 };
    count.pages += row.pages;
    pages += row.pages;
    byGroup.set(group, count);
  }
  // A histogram of type sets, not page slugs: all slugs with the same set
  // contribute once to each collapsed group, even when twins have different
  // stored types. Neither page identities nor bodies cross the SQL boundary.
  for (const row of rows) {
    if (row.kind !== 'slug_types') continue;
    distinctSlugs += row.distinct_slugs;
    for (const group of new Set(row.types!.map(type => groupOf.get(type) ?? ''))) {
      byGroup.get(group)!.distinct_slugs += row.distinct_slugs;
    }
  }
  return {
    bySourceType,
    byTypeGroup: [...byGroup.values()],
    total: { pages, distinct_slugs: distinctSlugs },
  };
}
