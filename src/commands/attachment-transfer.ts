/** Client-side byte loop. Only metadata reaches stdout / the agent's context. */
import { createHash, randomUUID } from 'node:crypto';
import { open, stat, link, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getMimeType } from './files.ts';

export type AttachmentCall = (name: string, params: Record<string, unknown>) => Promise<any>;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK = 256 * 1024;
export async function uploadAttachment(call: AttachmentCall, path: string, slug: string, requestId: string,
  sourceId?: string) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Attachment must be a regular file no larger than 64 MiB.');
    const bytes = await file.readFile();
    if (bytes.length > MAX_BYTES) throw new Error('Attachment grew beyond the 64 MiB limit.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = await call('attachment_begin', { request_id: requestId, page_slug: slug,
      filename: basename(path), mime_type: getMimeType(path) ?? 'application/octet-stream',
      size_bytes: bytes.length, sha256, ...(sourceId ? { source_id: sourceId } : {}) });
    if (!Number.isSafeInteger(upload.chunk_bytes) || upload.chunk_bytes < 1 || upload.chunk_bytes > MAX_CHUNK) throw new Error('Invalid server chunk limit.');
    if (upload.state === 'aborted') throw new Error('Upload was aborted; use a new request ID.');
    if (upload.state !== 'complete') {
      for (let offset = 0; offset < bytes.length; offset += upload.chunk_bytes) {
        await call('attachment_write', { upload_id: upload.upload_id, offset,
          data_base64: bytes.subarray(offset, offset + upload.chunk_bytes).toString('base64') });
      }
    }
    const saved = await call('attachment_complete', { upload_id: upload.upload_id });
    if (saved.state !== 'complete' || saved.sha256 !== sha256 || saved.size_bytes !== bytes.length) throw new Error('Server did not confirm a matching completed attachment.');
    return saved;
  } finally { await file.close(); }
}

export async function downloadAttachment(call: AttachmentCall, id: number, output: string) {
  // Never truncate an existing output, even if another process creates it mid-transfer.
  try { await stat(output); throw new Error('Output already exists. Choose a new filename.'); }
  catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e; }
  const temp = join(dirname(output), `.gbrain-download-${randomUUID()}`);
  const file = await open(temp, 'wx', 0o600);
  const hash = createHash('sha256');
  let offset = 0;
  let expected: { sha256: string; size_bytes: number } | undefined;
  try {
    while (true) {
      const part = await call('attachment_read', { attachment_id: id, offset });
      if (!Number.isSafeInteger(part.size_bytes) || part.size_bytes < 0 || part.size_bytes > MAX_BYTES ||
        typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256) ||
        typeof part.data_base64 !== 'string' || part.data_base64.length > 4 * Math.ceil(MAX_CHUNK / 3)) throw new Error('Invalid attachment response.');
      expected ??= { sha256: part.sha256, size_bytes: part.size_bytes };
      const bytes = Buffer.from(part.data_base64, 'base64');
      if (part.sha256 !== expected.sha256 || part.size_bytes !== expected.size_bytes || part.offset !== offset ||
        bytes.toString('base64') !== part.data_base64 || part.next_offset !== offset + bytes.length ||
        part.next_offset > expected.size_bytes || (!part.eof && !bytes.length) ||
        part.eof !== (part.next_offset === expected.size_bytes)) throw new Error('Attachment changed or returned invalid chunk boundaries.');
      await file.writeFile(bytes);
      hash.update(bytes);
      offset = part.next_offset;
      if (part.eof) break;
    }
    if (hash.digest('hex') !== expected.sha256 || offset !== expected.size_bytes) throw new Error('Downloaded attachment checksum mismatch.');
    await file.sync();
    await file.close();
    await link(temp, output);
    return { attachment_id: id, output, ...expected };
  } finally { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
