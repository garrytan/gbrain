import type { OperationContext } from '../ops/contract.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { backend, CHUNK_BYTES, fail, integer, MAX_FILE_BYTES, owner, page, receipt, sha256, storageConfig, storageIdentity, upload, uuid, type Upload } from './context.ts';

export async function begin(ctx: OperationContext, p: Record<string, unknown>) {
  const id = uuid(p.request_id);
  const size = integer(p.size_bytes, MAX_FILE_BYTES);
  // Display metadata only: the filename never participates in a storage path.
  if (typeof p.filename !== 'string' || !p.filename.trim() || Buffer.byteLength(p.filename) > 255 ||
    /[\/\\\x00-\x1f\x7f]/.test(p.filename) || ['.', '..'].includes(p.filename)) fail('invalid_params', 'A filename of at most 255 bytes, without paths or control characters, is required.');
  if (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)) fail('invalid_params', 'sha256 must be a lowercase SHA-256 hex digest.');
  const mime = p.mime_type ?? 'application/octet-stream';
  if (typeof mime !== 'string' || mime.length > 255 || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) fail('invalid_params', 'Invalid MIME type.');
  const config = storageConfig(ctx);
  const identity = storageIdentity(ctx);
  const principal = owner(ctx);
  const target = await page(ctx, p, true);
  if (ctx.dryRun) return { dry_run: true, chunk_bytes: CHUNK_BYTES, max_file_bytes: MAX_FILE_BYTES };
  return ctx.engine.transaction(async tx => {
    const scoped = { ...ctx, engine: tx };
    // Lock a real source row (works on both engines) to serialize quota admission.
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [target.source_id]);
    await tx.executeRaw("DELETE FROM attachment_uploads WHERE state='pending' AND expires_at <= now()");
    const [prior] = await tx.executeRaw('SELECT id FROM attachment_uploads WHERE id=$1', [id]);
    if (prior) {
      const row = await upload(scoped, id);
      if (row.page_id !== target.id || row.filename !== p.filename || row.size_bytes !== size || row.sha256 !== p.sha256 || row.mime_type !== mime) fail('conflict', 'The request ID already belongs to different attachment metadata.');
      return receipt(row);
    }
    const [count] = await tx.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM attachment_uploads WHERE source_id=$1 AND state='pending'", [target.source_id]);
    if (count.n >= 8) fail('upload_limit', 'This source already has eight pending uploads. Finish or abort them, or wait for expiry.');
    await tx.executeRaw(`INSERT INTO attachment_uploads
      (id, owner_key, source_id, page_id, filename, mime_type, size_bytes, sha256, storage_backend, storage_identity)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, principal, target.source_id, target.id, p.filename, mime, size, p.sha256, config.backend, identity]);
    return receipt(await upload(scoped, id));
  });
}

export async function write(ctx: OperationContext, p: Record<string, unknown>) {
  const offset = integer(p.offset, MAX_FILE_BYTES);
  if (offset % CHUNK_BYTES !== 0 || typeof p.data_base64 !== 'string' || p.data_base64.length > 4 * Math.ceil(CHUNK_BYTES / 3)) fail('invalid_params', 'Use an aligned offset and a chunk no larger than chunk_bytes.');
  const bytes = Buffer.from(p.data_base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== p.data_base64) fail('invalid_params', 'Chunk must contain canonical, nonempty base64.');
  return ctx.engine.transaction(async tx => {
    const row = await upload({ ...ctx, engine: tx }, p.upload_id);
    if (row.state !== 'pending') fail('conflict', 'This upload is no longer pending.');
    if (bytes.length !== Math.min(CHUNK_BYTES, row.size_bytes - offset)) fail('invalid_params', 'Chunk size does not match its declared position in the file.');
    const [prior] = await tx.executeRaw<{ data_base64: string }>('SELECT data_base64 FROM attachment_chunks WHERE upload_id=$1 AND byte_offset=$2', [row.id, offset]);
    if (prior && prior.data_base64 !== p.data_base64) fail('conflict', 'Different bytes already occupy this chunk; start a new upload.');
    if (ctx.dryRun) return { dry_run: true };
    if (!prior) await tx.executeRaw('INSERT INTO attachment_chunks (upload_id, byte_offset, data_base64) VALUES ($1,$2,$3)', [row.id, offset, p.data_base64]);
    return { upload_id: row.id, offset, accepted_bytes: bytes.length };
  });
}

async function verifyStored(ctx: OperationContext, row: Upload, key: string) {
  try {
    const bytes = await (await backend(ctx)).download(key);
    if (bytes.length !== row.size_bytes || sha256(bytes) !== row.sha256) fail('checksum_mismatch', 'Stored attachment checksum does not match.');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'checksum_mismatch') throw e;
    fail('storage_error', 'Cannot read back the stored attachment. Retry the same upload ID.');
  }
}

export async function complete(ctx: OperationContext, p: Record<string, unknown>) {
  return ctx.engine.transaction(async tx => {
    const scoped = { ...ctx, engine: tx };
    const row = await upload(scoped, p.upload_id);
    const key = `attachments/${row.storage_key}`;
    if (row.state === 'aborted') fail('conflict', 'This upload was aborted.');
    if (row.state === 'complete') {
      if (!row.file_id) fail('not_found', 'The attachment record was removed.');
      await verifyStored(scoped, row, key);
      return receipt(row);
    }
    const chunks = await tx.executeRaw<{ byte_offset: number; data_base64: string }>('SELECT byte_offset, data_base64 FROM attachment_chunks WHERE upload_id=$1 ORDER BY byte_offset', [row.id]);
    if (chunks.length !== Math.ceil(row.size_bytes / CHUNK_BYTES) || chunks.some((c, i) => c.byte_offset !== i * CHUNK_BYTES)) fail('upload_incomplete', 'Upload every chunk before completing the attachment.');
    const bytes = Buffer.concat(chunks.map(c => Buffer.from(c.data_base64, 'base64')));
    if (bytes.length !== row.size_bytes || sha256(bytes) !== row.sha256) fail('checksum_mismatch', 'Uploaded bytes do not match the declared SHA-256.');
    if (ctx.dryRun) return { dry_run: true, sha256: row.sha256 };
    // Immutable request-owned key: retries can safely overwrite identical bytes.
    // Never delete on a database error: a commit may have succeeded remotely.
    try { await (await backend(ctx)).upload(key, bytes, row.mime_type); }
    catch { fail('storage_error', 'Storage upload failed. Retry the same upload ID.'); }
    await verifyStored(scoped, row, key);
    await executeRawJsonb(tx, `INSERT INTO files (source_id, page_id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (storage_path) DO NOTHING`,
    [row.source_id, row.page_id, row.slug, row.filename, key, row.mime_type, row.size_bytes, row.sha256], [{ storage: row.storage_backend, upload_method: 'mcp_attachment' }]);
    const [file] = await tx.executeRaw<{ id: number }>('SELECT id FROM files WHERE storage_path=$1 AND source_id=$2 AND content_hash=$3', [key, row.source_id, row.sha256]);
    if (!file) fail('conflict', 'The attachment storage key is already registered differently.');
    await tx.executeRaw("UPDATE attachment_uploads SET state='complete', file_id=$2 WHERE id=$1", [row.id, file.id]);
    await tx.executeRaw('DELETE FROM attachment_chunks WHERE upload_id=$1', [row.id]);
    return receipt({ ...row, state: 'complete', file_id: file.id });
  });
}

export async function abort(ctx: OperationContext, p: Record<string, unknown>) {
  return ctx.engine.transaction(async tx => {
    const row = await upload({ ...ctx, engine: tx }, p.upload_id);
    if (row.state === 'complete') fail('conflict', 'Completed attachments cannot be aborted.');
    if (ctx.dryRun) return { dry_run: true };
    await tx.executeRaw('DELETE FROM attachment_chunks WHERE upload_id=$1', [row.id]);
    await tx.executeRaw("UPDATE attachment_uploads SET state='aborted' WHERE id=$1", [row.id]);
    return { upload_id: row.id, state: 'aborted' };
  });
}
