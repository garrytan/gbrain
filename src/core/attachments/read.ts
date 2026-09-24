import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { backend, CHUNK_BYTES, fail, integer, MAX_FILE_BYTES, page, sha256, storageConfig } from './context.ts';

interface FileRow {
  id: number; source_id: string; page_id: number | null; page_slug: string | null;
  filename: string; size_bytes: number | string | null; content_hash: string; mime_type: string | null;
  storage_path: string; storage: string | null;
}
function metadata(row: FileRow) {
  return { attachment_id: row.id, source_id: row.source_id, page_slug: row.page_slug,
    filename: row.filename, size_bytes: row.size_bytes === null ? null : Number(row.size_bytes), sha256: row.content_hash,
    mime_type: row.mime_type, chunk_bytes: CHUNK_BYTES };
}
export async function list(ctx: OperationContext, p: Record<string, unknown>) {
  const target = await page(ctx, p, false);
  const after = integer(p.after_id ?? 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(p.limit ?? 100, 100);
  if (!limit) fail('invalid_params', 'limit must be positive.');
  const rows = await ctx.engine.executeRaw<FileRow>(`SELECT f.* FROM files f WHERE source_id=$1
    AND page_id=$2 AND id>$3 ORDER BY id LIMIT $4`,
  [target.source_id, target.id, after, limit + 1]);
  return { attachments: rows.slice(0, limit).map(row => metadata({ ...row, page_slug: target.slug })),
    next_after_id: rows.length > limit ? rows[limit - 1].id : null };
}
export async function read(ctx: OperationContext, p: Record<string, unknown>) {
  const id = integer(p.attachment_id, Number.MAX_SAFE_INTEGER);
  const offset = integer(p.offset ?? 0, MAX_FILE_BYTES);
  // The row is internal until its owning page passes the normal visibility policy.
  const [row] = await ctx.engine.executeRaw<FileRow>(`SELECT f.*, f.metadata->>'storage' AS storage,
    p.slug AS page_slug FROM files f JOIN pages p ON p.id=f.page_id AND p.source_id=f.source_id WHERE f.id=$1`, [id]);
  if (!row || !row.page_slug || row.page_id === null) fail('not_found', 'Attachment or page not found.');
  const target = await page(ctx, { page_slug: row.page_slug, source_id: row.source_id }, false).catch(error => {
    if (error instanceof OperationError && error.code === 'not_found') fail('not_found', 'Attachment or page not found.');
    throw error;
  });
  if (row.page_id !== null && row.page_id !== target.id) fail('not_found', 'Attachment or page not found.');
  const size = Number(row.size_bytes);
  if (row.size_bytes === null || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) fail('invalid_params', 'This attachment exceeds the bounded MCP download limit or has no verified size.');
  if (offset > size) fail('invalid_params', 'Offset exceeds the attachment size.');
  if (row.storage !== storageConfig(ctx).backend) fail('storage_error', 'This file is not registered in the configured attachment backend.');
  let bytes: Buffer;
  try { bytes = await (await backend(ctx)).download(row.storage_path); }
  catch { return fail('storage_error', 'Attachment bytes could not be read from storage.'); }
  if (bytes.length !== size || sha256(bytes) !== row.content_hash) fail('checksum_mismatch', 'Stored attachment does not match its registered checksum.');
  const end = Math.min(size, offset + CHUNK_BYTES);
  return { ...metadata(row), offset, next_offset: end, eof: end === size, data_base64: bytes.subarray(offset, end).toString('base64') };
}
