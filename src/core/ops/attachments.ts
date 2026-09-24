import type { Operation, ParamDef } from './contract.ts';
import { begin, write, complete, abort } from '../attachments/write.ts';
import { list, read } from '../attachments/read.ts';

const uploadId: Record<string, ParamDef> = { upload_id: { type: 'string', required: true, description: 'UUID returned by attachment_begin.' } };
const pageParams: Record<string, ParamDef> = {
  page_slug: { type: 'string', required: true, description: 'Existing page that owns the attachment.' },
  source_id: { type: 'string', description: 'Source within your grant; defaults to your current source.' },
};
export const attachmentsOperations: Operation[] = [
  { name: 'attachment_begin', scope: 'write', mutating: true,
    description: 'Begin a resumable binary attachment upload (maximum 64 MiB) to an existing page. Supply a stable request UUID, size and SHA-256; replay identical metadata to resume. Send canonical base64 in 256 KiB chunks using attachment_write, then attachment_complete. Pending bytes expire after 24 hours. Use a client-side transfer helper for large files to keep binary data out of model context. Does not ingest or summarize file contents.',
    params: { ...pageParams,
      request_id: { type: 'string', required: true, description: 'Client-generated UUID; reuse on retries.' },
      filename: { type: 'string', required: true, description: 'Filename only; no paths.' },
      size_bytes: { type: 'number', required: true, description: 'Exact byte length, from 0 through 67108864.' },
      sha256: { type: 'string', required: true, description: 'Lowercase 64-character SHA-256 digest of the complete original file.' },
      mime_type: { type: 'string', description: 'MIME type; defaults to application/octet-stream.' } }, handler: begin },
  { name: 'attachment_write', scope: 'write', mutating: true,
    description: 'Store one attachment chunk. Offsets must be multiples of the returned chunk_bytes; all but the final chunk must have that size. Identical retries are safe; conflicting bytes are rejected. This acknowledges staging, not a saved attachment.',
    params: { ...uploadId, offset: { type: 'number', required: true, description: 'Zero-based byte offset, aligned to chunk_bytes.' },
      data_base64: { type: 'string', required: true, description: 'Canonical base64 encoding of this chunk, at most 256 KiB decoded.' } }, handler: write },
  { name: 'attachment_complete', scope: 'write', mutating: true,
    description: 'Verify every chunk and the complete SHA-256, write to configured storage, read back and verify, then publish attachment metadata. Retry the same upload ID if interrupted. Only state=complete confirms a saved attachment; use attachment_list/read to verify retrieval.',
    params: uploadId, handler: complete },
  { name: 'attachment_abort', scope: 'write', mutating: true,
    description: 'Cancel your pending attachment upload and discard its staged chunks. Does not remove completed attachments.',
    params: uploadId, handler: abort },
  { name: 'attachment_list', scope: 'read',
    description: 'List attachment metadata for a readable page, including original filenames, sizes and SHA-256 hashes. Preserves page/source privacy; does not expose server paths. Pass next_after_id as after_id for the next page.',
    params: { ...pageParams, after_id: { type: 'number', description: 'Exclusive attachment-ID cursor; pass next_after_id from the previous response.' }, limit: { type: 'number', description: '1–100; default 100.' } }, handler: list },
  { name: 'attachment_read', scope: 'read',
    description: 'Download up to 256 KiB of a page attachment as base64. Checks current page/source visibility and full stored checksum. Repeat using next_offset until eof. Maximum file size 64 MiB. Prefer a client-side helper to avoid putting binary data in model context.',
    params: { attachment_id: { type: 'number', required: true, description: 'Attachment ID returned by attachment_complete or attachment_list.' }, offset: { type: 'number', description: 'Byte offset; default 0.' } }, handler: read },
];
