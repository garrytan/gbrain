/**
 * The large-page write guard's read (persistence/large-page-guard.ts): the stored body size of a live page, which a
 * remote put_page measures before it is queued. One SQL implementation for both engines; the statement text is what
 * the guard sent through `executeRaw`. The decision (inline read size, shrink fraction) stays in the guard.
 *
 * `readPageBodySizes` is append_page's read after its write (persistence/page-append.ts): the page's body and truth
 * sizes by id, which the append reports and takes the mention range of its added bytes from.
 */
import type { BrainEngine } from '../engine.ts';
import type { LegacyUnscopedRead } from './brands.ts';

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

const PAGE_BODY_SIZES_SQL = `SELECT COALESCE(body_bytes, octet_length(COALESCE(compiled_truth,'')) + octet_length(COALESCE(timeline,'')))::text AS bytes,
      (CASE WHEN body_storage='segmented' THEN truth_bytes ELSE octet_length(COALESCE(compiled_truth,'')) END)::text AS truth FROM pages WHERE id=$1`;

/** Body and truth sizes of page `pageId` (deleted or not), as append_page reads them after its write. */
export interface PageBodySizes { bytes: number | null; truth: number | null }

/**
 * Page `pageId`'s stored sizes: `bytes` is `body_bytes` when set, else the UTF-8 bytes of both body columns; `truth` is
 * a segmented page's `truth_bytes`, else the UTF-8 bytes of `compiled_truth`. Null when no page has the id.
 */
export async function readPageBodySizes(tx: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<PageBodySizes | null> {
  const [row] = await tx.executeRaw<{ bytes: string | null; truth: string | null }>(PAGE_BODY_SIZES_SQL, [pageId]);
  if (!row) return null;
  return { bytes: row.bytes == null ? null : Number(row.bytes), truth: row.truth == null ? null : Number(row.truth) };
}
