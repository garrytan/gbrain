/**
 * The large-page write guard's read (persistence/large-page-guard.ts): the stored body size of a live page, which a
 * remote put_page measures before it is queued. One SQL implementation for both engines; the statement text is what
 * the guard sent through `executeRaw`. The decision (inline read size, shrink fraction) stays in the guard.
 */
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
