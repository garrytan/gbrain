/**
 * Alias rows whose target page is not live: the plan and apply of `gbrain repair aliases` (#6619) and doctor's
 * `dangling_aliases` check, moved here from repair/aliases.ts and onboard/checks.ts so the Rust engine can serve
 * them as typed members. A target is the slug an alias row resolves to: `page_aliases.slug` and
 * `slug_aliases.canonical_slug`. Neither table has a foreign key to pages, so the rows outlive a hard delete or a
 * purge of the page. PGLite and Postgres read unscoped through executeRaw, as before; the delete takes the engine's
 * own executor. The Rust engine answers from its alias keys (rust/docs/store/repair-bookkeeping.md, "Alias
 * targets").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/** One target slug whose page is `missing` (no page row) or `soft_deleted`, and how many rows of each table name it. */
export interface AliasTarget {
  source_id: string;
  slug: string;
  page: 'missing' | 'soft_deleted';
  page_aliases: number;
  slug_redirects: number;
}

/**
 * Every alias target of `sourceIds` (every source when null) whose page is missing or soft-deleted, by source then
 * slug in byte order. A live page's target is not listed.
 */
export async function listAliasTargets(exec: LegacyUnscopedRead, sourceIds: readonly string[] | null): Promise<AliasTarget[]> {
  const rows = await exec.executeRaw<AliasTarget>(
    `SELECT o.source_id,o.slug,CASE WHEN p.slug IS NULL THEN 'missing' ELSE 'soft_deleted' END AS page,
       sum(o.page_aliases)::int AS page_aliases,sum(o.slug_redirects)::int AS slug_redirects FROM (
         SELECT pa.source_id,pa.slug,1 AS page_aliases,0 AS slug_redirects FROM page_aliases pa WHERE $1::text[] IS NULL OR pa.source_id=ANY($1::text[])
         UNION ALL SELECT sa.source_id,sa.canonical_slug,0,1 FROM slug_aliases sa WHERE $1::text[] IS NULL OR sa.source_id=ANY($1::text[])
       ) o LEFT JOIN pages p ON p.source_id=o.source_id AND p.slug=o.slug
     WHERE p.slug IS NULL OR p.deleted_at IS NOT NULL
     GROUP BY o.source_id,o.slug,p.slug IS NULL ORDER BY o.source_id COLLATE "C",o.slug COLLATE "C"`,
    [sourceIds === null ? null : [...sourceIds]]);
  return rows.map(row => ({ source_id: row.source_id, slug: row.slug, page: row.page,
    page_aliases: Number(row.page_aliases), slug_redirects: Number(row.slug_redirects) }));
}

/**
 * When `(sourceId, slug)` has no page row, deletes every page alias of the slug and every slug redirect that resolves
 * to it, and answers how many rows went. A page row, live or soft-deleted, keeps every row (`gbrain restore` still
 * needs them). A redirect whose alias_slug is the slug (an old name of a page that still exists) is never touched.
 * The caller holds the page key lock.
 */
export async function deleteOrphanedAliases(exec: SqlExecutor, sourceId: string, slug: string): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(`WITH target AS (SELECT $1::text AS source_id,$2::text AS slug WHERE NOT EXISTS
      (SELECT 1 FROM pages p WHERE p.source_id=$1 AND p.slug=$2)),
    pa AS (DELETE FROM page_aliases a USING target t WHERE a.source_id=t.source_id AND a.slug=t.slug RETURNING 1),
    sa AS (DELETE FROM slug_aliases a USING target t WHERE a.source_id=t.source_id AND a.canonical_slug=t.slug RETURNING 1)
    SELECT (SELECT count(*) FROM pa)::int+(SELECT count(*) FROM sa)::int AS n`, [sourceId, slug]);
  return Number(row?.n ?? 0);
}
