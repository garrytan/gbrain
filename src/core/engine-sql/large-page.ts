/**
 * The large-page reads. readStoredBodyBytes is the write guard's read (persistence/large-page-guard.ts): the stored body size of a live page, which a
 * remote put_page measures before it is queued; listPageSizeRows is the size-state read of a sync receipt
 * (page-embedding-budget.ts). One SQL implementation for both engines; the statement text is what
 * the guard sent through `executeRaw`. The decision (inline read size, shrink fraction) stays in the guard.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

const STORED_BODY_BYTES_SQL = `SELECT CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(compiled_truth) + COALESCE(octet_length(timeline), 0) END AS bytes
      FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`;

/**
 * The stored body size of live page `slug` of `sourceId`: a segmented page's `body_bytes`, else the UTF-8 bytes of
 * `compiled_truth` and `timeline`. Null when the page is not live or the size is NULL.
 */
export async function readStoredBodyBytes(exec: LegacyUnscopedRead, slug: string, sourceId: string): Promise<number | null> {
  const [row] = await exec.executeRaw<{ bytes: unknown }>(STORED_BODY_BYTES_SQL, [slug, sourceId]);
  return row?.bytes == null ? null : Number(row.bytes);
}

/** A stored page whose size or frontmatter can give it a size state (page-embedding-budget.ts `readPageSizeStates`). */
export interface PageSizeRow {
  slug: string;
  /** A segmented page's body_bytes, else the UTF-8 bytes of compiled_truth and timeline; null when unknown. */
  bytes: number | null;
  segmented: boolean;
  frontmatter: Record<string, unknown> | null;
  /** The page's embedding budget row: null when it has none. */
  state: string | null;
  reason: string | null;
}

const PAGE_SIZE_BYTES = trustedSql(`(CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)`);

/** The size-state read, for every candidate page of the source (`slugs` null) or only the given slugs. */
export function pageSizeRowsSql(sourceId: string, inlineMaxBytes: number, slugs: readonly string[] | null): SqlFragment {
  return sqlFragment`SELECT p.slug, ${PAGE_SIZE_BYTES}::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL${slugs ? sqlFragment` AND p.slug = ANY(${[...slugs]}::text[])` : sqlFragment``}
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR ${PAGE_SIZE_BYTES} > ${inlineMaxBytes} OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug COLLATE "C"`;
}

/**
 * The live pages of `sourceId` (all, or only `slugs`) that have an `embed_skip` frontmatter key, a body over
 * `inlineMaxBytes`, segmented storage, or an embedding budget row, in slug byte order. An empty `slugs` reads nothing.
 */
export async function listPageSizeRows(exec: LegacyUnscopedRead, sourceId: string, opts: { inlineMaxBytes: number; slugs: readonly string[] | null }): Promise<PageSizeRow[]> {
  if (opts.slugs?.length === 0) return [];
  const { rows } = await exec.run<Omit<PageSizeRow, 'bytes'> & { bytes: unknown }>(pageSizeRowsSql(sourceId, opts.inlineMaxBytes, opts.slugs));
  return rows.map(row => ({ ...row, bytes: row.bytes == null ? null : Number(row.bytes), segmented: row.segmented === true }));
}
