/**
 * Slug reads that callers ran through `executeRaw`, each with the statement text and parameters its caller used; only
 * its home moved. Every one orders by byte (`COLLATE "C"`), so the row a caller takes first is the same on every
 * engine whatever the database locale is (test/engine-parity/collate-*.test.ts). The text of each is pinned in
 * test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { Page } from '../types.ts';
import { rowToPage } from '../utils.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';

/**
 * The slug of the live page that records `path` as its origin, across every source; with several such pages, the one in
 * the lowest source id by byte, then the lowest slug. Null when no live page claims the path. A soft-deleted page's
 * record names no slug (sync-git.ts `resolveSlugsForRemovedPaths`, the unscoped lane).
 */
export async function resolveLiveSlugByPath(raw: EngineRawRead, path: string): Promise<string | null> {
  const rows = await raw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_path = $1 AND deleted_at IS NULL
            ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 1`,
    [path],
  );
  return rows.length > 0 && rows[0]!.slug ? rows[0]!.slug : null;
}

/**
 * The ids of the unarchived sources that hold a live page at `slug`, in byte order: the sources the scoped get_links miss
 * hint offers to rerun in (ops/links.ts `hintScopedLinkMiss`).
 */
export async function listUnarchivedSlugSources(raw: EngineRawRead, slug: string): Promise<string[]> {
  const rows = await raw<{ source_id: string }>(
    `SELECT DISTINCT p.source_id COLLATE "C" AS source_id FROM pages p JOIN sources s ON s.id = p.source_id
       WHERE p.slug = $1 AND p.deleted_at IS NULL AND s.archived IS NOT TRUE
       ORDER BY p.source_id COLLATE "C"`,
    [slug],
  );
  return rows.map((r) => r.source_id);
}

/**
 * The ids of the sources that hold a live page at `slug`, in byte order, archived or not: the holders the trust page-ref
 * resolver (trust/refs.ts `resolvePageRef`), `gbrain quarantine clear` and `extract-conversation-facts --grammar` name
 * when a slug is ambiguous.
 */
export async function listLiveSlugSources(raw: EngineRawRead, slug: string): Promise<string[]> {
  const rows = await raw<{ source_id: string }>(
    'SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id COLLATE "C"', [slug]);
  return rows.map((r) => r.source_id);
}

/** The live pages `schema review-orphans` reads: those of `sourceIds` when given, else of `sourceId`, else every source. */
export interface TypeScope { sourceId?: string; sourceIds?: string[] }

function typeScopeWhere(scope: TypeScope): SqlFragment {
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    return sqlFragment`deleted_at IS NULL AND source_id = ANY(${scope.sourceIds}::text[])`;
  }
  if (scope.sourceId) return sqlFragment`deleted_at IS NULL AND source_id = ${scope.sourceId}`;
  return sqlFragment`deleted_at IS NULL`;
}

/** How many live pages in scope carry each stored type (schema-pack/review.ts `findTypeOrphans`). The statement has no `ORDER BY`. */
export async function countLivePageTypes(raw: EngineRawRead, scope: TypeScope): Promise<Array<{ type: string | null; n: string }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT type, count(*)::text AS n FROM pages WHERE ${typeScopeWhere(scope)} GROUP BY type`);
  return raw<{ type: string | null; n: string }>(text, params);
}

/**
 * The live pages in scope with an empty type or one of `types`, by source id then slug in byte order, up to `limit`
 * (schema-pack/review.ts `findTypeOrphans`). `limit` is a whole number of at least 1 and is written into the text, as
 * the caller wrote it.
 */
export async function listTypeOrphanPages(
  raw: EngineRawRead,
  opts: { scope: TypeScope; types: readonly string[]; limit: number },
): Promise<Array<{ slug: string; source_id: string; type: string | null }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT slug, COALESCE(source_id, 'default') AS source_id, type FROM pages
      WHERE ${typeScopeWhere(opts.scope)} AND (type IS NULL OR type = '' OR type = ANY(${[...opts.types]}::text[]))
      ORDER BY source_id COLLATE "C", slug COLLATE "C"`);
  return raw<{ slug: string; source_id: string; type: string | null }>(`${text}\n      LIMIT ${opts.limit}`, params);
}

/** A live page and its tags in byte order, as an export reads them. */
export interface ExportPageRow { page: Page; tags: string[] }

/**
 * The live pages whose id is in `ids`, each with its tags in byte order (export-snapshot.ts `readExportPages`). A repeated
 * id answers once and an id no live page has answers nothing; the statement has no `ORDER BY`, so callers map the rows by
 * `page.id`. Rows are looked up by primary key.
 */
export async function readExportPageRows(raw: EngineRawRead, ids: readonly string[]): Promise<ExportPageRow[]> {
  const rows = await raw<Record<string, unknown>>(`WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id = ANY($1::bigint[])
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.deleted_at IS NULL`,
  [[...ids]]);
  return rows.map((row) => ({ page: rowToPage(row), tags: row.export_tags as string[] }));
}
