/**
 * Remote file transfer (docs/designs/REMOTE_FILE_TRANSFER.md): a byte-based lane for file storage that works over any
 * transport. file_upload reads a server-side path, so it stays localOnly; these ops take bytes instead:
 *
 *   file_upload_begin   reserve an upload; a backend that signs URLs (S3-compatible) answers with a presigned PUT the
 *                       caller sends the bytes to directly, any other backend takes them inline (file_upload_part)
 *   file_upload_part    one base64 part of an inline upload
 *   file_upload_commit  verify size, SHA-256 and type, store at the file_upload layout through the same recording path,
 *                       and optionally import an image (embedding + OCR) from memory
 *   file_upload_abort   drop a pending upload
 *   file_get            a stored file's bytes: an MCP image block for images, base64 otherwise
 *
 * Session state lives in the storage backend under STAGING_PREFIX (a manifest the server writes; the signed URL covers
 * only the data key), so no schema change is needed and both engines behave the same. Never import from
 * '../operations.ts' here (cycle).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Operation, OperationContext } from './contract.ts';
import { MCP_EXTRA_CONTENT, opError } from './contract.ts';
import { validateFilename, validatePageSlug } from './context.ts';
import { fileReadableSql, resolveFileStorage, storeAndRecordFile, uploadLayoutPath } from './files.ts';
import { hashStoredObject, type StorageBackend } from '../storage.ts';
import { resultByteCap } from '../egress-budget.ts';
import { partMaxFrameBytes } from '../persistence/page-upload.ts';

export const STAGING_PREFIX = '_incoming';
/** Lifetime of a pending upload: its presigned PUT and the window to commit it. */
const UPLOAD_TTL_S = 15 * 60;
const COMMIT_GRACE_S = 60 * 60;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PARTS = 10_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

interface UploadManifest {
  v: 1;
  upload_id: string;
  mode: 'direct' | 'parts';
  filename: string;
  size_bytes: number;
  sha256: string;
  mime_type: string | null;
  page_slug: string | null;
  import: boolean;
  source_id: string;
  expires_at: string;
}

export function maxUploadBytes(): number {
  const n = Number(process.env.GBRAIN_REMOTE_UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_UPLOAD_BYTES;
}

const stagingDir = (id: string) => `${STAGING_PREFIX}/${id}`;
const manifestKey = (id: string) => `${stagingDir(id)}/manifest.json`;
const dataKey = (id: string) => `${stagingDir(id)}/data`;
const partKey = (id: string, part: number) => `${stagingDir(id)}/part-${String(part).padStart(6, '0')}`;
const PART_KEY = /\/part-(\d{6})$/;

/** Raw bytes per inline part: the request cap of this connection, less the frame and base64 overhead. */
export function partMaxRawBytes(ctx: Pick<OperationContext, 'remote' | 'transport' | 'inboundFrameBytes'>): number {
  return Math.max(1024, Math.floor((partMaxFrameBytes(ctx) - 1024) / 4) * 3);
}

/** The real type of the leading bytes for the formats the brain indexes or serves inline; null when unrecognized. */
export function sniffMime(bytes: Buffer): string | null {
  const at = (offset: number, ascii: string) => bytes.length >= offset + ascii.length && bytes.toString('latin1', offset, offset + ascii.length) === ascii;
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, '%PDF-')) return 'application/pdf';
  if (at(4, 'ftyp')) {
    const brand = bytes.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

/** Extension the image importer decodes by, for the sniffed type, when the filename's own does not match it. */
const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/heic': '.heic',
};

function uploadNotFound(id: string) {
  return opError('invalid_params', `No pending upload ${id}: it was committed, aborted, has expired, or never existed.`,
    'Start again with file_upload_begin.');
}

function requireUploadId(value: unknown): string {
  if (typeof value !== 'string' || !UPLOAD_ID.test(value)) throw opError('invalid_params', 'upload_id must be the id file_upload_begin returned.', 'Pass upload_id exactly as returned.');
  return value;
}

async function readManifest(ctx: OperationContext, storage: StorageBackend, id: string): Promise<UploadManifest> {
  let manifest: UploadManifest;
  try {
    manifest = JSON.parse((await storage.download(manifestKey(id))).toString('utf8')) as UploadManifest;
  } catch {
    throw uploadNotFound(id);
  }
  // An upload belongs to the source it was begun in; any other caller sees it as unknown.
  if (manifest.v !== 1 || manifest.upload_id !== id || manifest.source_id !== (ctx.sourceId ?? 'default')) throw uploadNotFound(id);
  return manifest;
}

async function dropStaging(storage: StorageBackend, id: string): Promise<void> {
  const keys = await storage.list(stagingDir(id)).catch(() => [] as string[]);
  // The manifest goes last, so a half-finished cleanup can still be found and aborted.
  const ordered = [...keys.filter(k => !k.endsWith('/manifest.json')), manifestKey(id)];
  for (const key of ordered) await storage.delete(key).catch(() => {});
}

const file_upload_begin: Operation = {
  name: 'file_upload_begin',
  idempotent: false,
  mutating: true,
  outputRedaction: 'no_stored_text',
  description: 'Start uploading a file (image, PDF, any binary) into the brain\'s file storage from anywhere, remote callers included. '
    + 'Answers mode "direct" with a short-lived URL: send the raw file bytes as the body of an HTTP PUT to it with exactly the returned headers, '
    + 'or mode "parts": send the bytes base64-encoded with file_upload_part in parts of at most part_max_bytes. Then call file_upload_commit. '
    + 'With import: true an image also becomes a searchable image page (visual embedding + OCR). Needs files (or admin) scope.',
  callShape: '{"filename":"whiteboard.png","size_bytes":123456,"sha256":"<64 hex>","page_slug":"meetings/2026-01-15","import":true}',
  params: {
    filename: { type: 'string', required: true, description: 'File name to store under, e.g. whiteboard.png' },
    size_bytes: { type: 'integer', required: true, description: 'Exact size of the file in bytes' },
    sha256: { type: 'string', required: true, description: 'SHA-256 of the file, 64 hex characters (sha256sum / shasum -a 256)' },
    mime_type: { type: 'string', description: 'Content type, e.g. image/png (sniffed from the bytes on commit for images and PDFs)' },
    page_slug: { type: 'string', description: 'Attach to this page; the file is stored as <page_slug>/<filename>' },
    import: { type: 'boolean', description: 'Also import an image as a searchable image page (embedding + OCR)' },
    mode: { type: 'string', enum: ['direct', 'parts'], description: 'Force a transfer mode; default direct when the backend can sign URLs' },
  },
  scope: 'files',
  handler: async (ctx, p) => {
    const filename = p.filename as string;
    validateFilename(filename);
    const size = p.size_bytes as number;
    const max = maxUploadBytes();
    if (!Number.isInteger(size) || size <= 0 || size > max) throw opError('invalid_params', `size_bytes must be between 1 and ${max}.`,
      'Send the exact byte size of the file; larger files go in on the brain host (gbrain files upload).');
    const sha256 = String(p.sha256 ?? '').toLowerCase();
    if (!SHA256_HEX.test(sha256)) throw opError('invalid_params', 'sha256 must be 64 hex characters.', 'Compute it with sha256sum <file> (or shasum -a 256 on macOS).');
    const pageSlug = (p.page_slug as string | undefined) || null;
    if (pageSlug) {
      validatePageSlug(pageSlug);
      if (pageSlug === STAGING_PREFIX || pageSlug.startsWith(`${STAGING_PREFIX}/`)) throw opError('invalid_params', `page_slug may not start with ${STAGING_PREFIX}/.`, 'Attach the file to a regular page.');
    }
    const mime = typeof p.mime_type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(p.mime_type) ? p.mime_type.toLowerCase() : null;
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload_begin', filename, size_bytes: size };

    const { storage } = await resolveFileStorage(ctx, 'file_upload_begin');
    const direct = p.mode !== 'parts' && typeof storage.createUploadUrl === 'function';
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + (UPLOAD_TTL_S + COMMIT_GRACE_S) * 1000).toISOString();
    const manifest: UploadManifest = {
      v: 1, upload_id: id, mode: direct ? 'direct' : 'parts', filename, size_bytes: size, sha256, mime_type: mime,
      page_slug: pageSlug, import: p.import === true, source_id: ctx.sourceId ?? 'default', expires_at: expiresAt,
    };
    await storage.upload(manifestKey(id), Buffer.from(JSON.stringify(manifest)), 'application/json');
    if (direct) {
      const signed = await storage.createUploadUrl!(dataKey(id), { mime: mime ?? 'application/octet-stream', expiresIn: UPLOAD_TTL_S });
      return { upload_id: id, mode: 'direct', method: signed.method, url: signed.url, headers: signed.headers,
        url_expires_in_s: UPLOAD_TTL_S, expires_at: expiresAt, next: 'PUT the bytes to url with exactly these headers, then call file_upload_commit.' };
    }
    const partMax = partMaxRawBytes(ctx);
    return { upload_id: id, mode: 'parts', part_max_bytes: partMax, parts: Math.ceil(size / partMax), expires_at: expiresAt,
      next: 'Send parts 1..parts with file_upload_part (data_base64 = base64 of each slice), then call file_upload_commit.' };
  },
};

const file_upload_part: Operation = {
  name: 'file_upload_part',
  idempotent: true,
  mutating: true,
  outputRedaction: 'no_stored_text',
  description: 'Send one part of an upload begun with file_upload_begin in mode "parts": the base64 of bytes [(part-1)*part_max_bytes, part*part_max_bytes). Resending a part replaces it. Needs files (or admin) scope.',
  callShape: '{"upload_id":"<from file_upload_begin>","part":1,"data_base64":"iVBORw0KGgo..."}',
  params: {
    upload_id: { type: 'string', required: true, description: 'The upload_id file_upload_begin returned' },
    part: { type: 'integer', required: true, description: '1-based part number' },
    data_base64: { type: 'string', required: true, description: 'The part\'s bytes, base64-encoded' },
  },
  scope: 'files',
  handler: async (ctx, p) => {
    const id = requireUploadId(p.upload_id);
    const part = p.part as number;
    if (!Number.isInteger(part) || part < 1 || part > MAX_PARTS) throw opError('invalid_params', `part must be between 1 and ${MAX_PARTS}.`, 'Number parts from 1.');
    const data = String(p.data_base64 ?? '');
    if (!BASE64.test(data)) throw opError('invalid_params', 'data_base64 is not valid base64.', 'Encode the part with standard base64 (no line breaks).');
    const bytes = Buffer.from(data, 'base64');
    const partMax = partMaxRawBytes(ctx);
    if (bytes.length === 0 || bytes.length > partMax) throw opError('invalid_params', `A part holds 1..${partMax} bytes; this one has ${bytes.length}.`, 'Split the file into parts of at most part_max_bytes.');
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload_part', upload_id: id, part };
    const { storage } = await resolveFileStorage(ctx, 'file_upload_part');
    const manifest = await readManifest(ctx, storage, id);
    if (manifest.mode !== 'parts') throw opError('invalid_params', `Upload ${id} is a direct upload.`, 'PUT the bytes to the url file_upload_begin returned, then call file_upload_commit.');
    if (Date.parse(manifest.expires_at) < Date.now()) throw uploadNotFound(id);
    // Parts may be any size up to part_max_bytes, so their number is bounded by the declared size (1 KiB per part on
    // average) and each part by the size itself; commit refuses parts holding more than declared.
    const maxParts = Math.min(MAX_PARTS, Math.ceil(manifest.size_bytes / 1024));
    if (part > maxParts || bytes.length > manifest.size_bytes) throw opError('invalid_params', `Part ${part} (${bytes.length} bytes) does not fit the declared size (${manifest.size_bytes} bytes).`,
      'Send the file in order as parts 1..n of at most part_max_bytes each.');
    await storage.upload(partKey(id, part), bytes, 'application/octet-stream');
    return { upload_id: id, part, received_bytes: bytes.length };
  },
};

/** The staged bytes, checked against the manifest's size and SHA-256 before they are held in memory whole. */
async function loadStagedBytes(storage: StorageBackend, manifest: UploadManifest): Promise<Buffer> {
  const id = manifest.upload_id;
  const mismatch = (what: string) => opError('invalid_params', `Upload ${id}: ${what}, so nothing was stored.`,
    'Send the exact bytes declared at file_upload_begin (or begin a new upload with the right size_bytes and sha256).');
  let bytes: Buffer;
  if (manifest.mode === 'direct') {
    let staged: { size: number; sha256: string };
    try {
      // Streamed where the backend can, so an oversized PUT is refused without loading it.
      staged = await hashStoredObject(storage, dataKey(id));
    } catch {
      throw opError('invalid_params', `Upload ${id} has no bytes yet.`, 'PUT the file to the url file_upload_begin returned, then commit again.');
    }
    if (staged.size !== manifest.size_bytes) throw mismatch(`received ${staged.size} bytes, declared ${manifest.size_bytes}`);
    if (staged.sha256 !== manifest.sha256) throw mismatch('the SHA-256 of the received bytes differs from the declared one');
    bytes = await storage.download(dataKey(id));
  } else {
    const parts = (await storage.list(stagingDir(id)))
      .map(key => PART_KEY.exec(key))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ key: m.input, n: Number(m[1]) }))
      .sort((a, b) => a.n - b.n);
    if (parts.length === 0 || parts.some((part, i) => part.n !== i + 1)) throw mismatch(`parts are missing (have ${parts.map(x => x.n).join(', ') || 'none'})`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (const part of parts) {
      const chunk = await storage.download(part.key);
      total += chunk.length;
      if (total > manifest.size_bytes) throw mismatch(`the parts hold more than the declared ${manifest.size_bytes} bytes`);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length !== manifest.size_bytes) throw mismatch(`received ${bytes.length} bytes, declared ${manifest.size_bytes}`);
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw mismatch('the SHA-256 of the received bytes differs from the declared one');
  return bytes;
}

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

const extOf = (name: string) => (/\.[^./]+$/.exec(name)?.[0] ?? '').toLowerCase();
const sameImageExt = (ext: string, want: string) => ext === want || (want === '.jpg' && ext === '.jpeg') || (want === '.heic' && ext === '.heif');

async function importUploadedImage(ctx: OperationContext, input: { bytes: Buffer; storagePath: string; pageSlug: string | null; filename: string; metadata: Record<string, unknown> }) {
  const sourceId = ctx.sourceId ?? 'default';
  try {
    const { importImageFile } = await import('../import-file.ts');
    const result = await importImageFile(ctx.engine, input.storagePath, input.storagePath, { inMemory: input.bytes, sourceId, fileMetadata: input.metadata });
    let linked: string | undefined;
    if (result.status !== 'error' && input.pageSlug) {
      try {
        await ctx.engine.addLink(result.slug, input.pageSlug, input.filename, 'image_of', 'manual', result.slug, 'frontmatter', // gbrain-allow-direct-insert: the image_of edge from an uploaded image to the page it was attached to, as importImageFile's own path-proximity edge
          { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
        linked = input.pageSlug;
      } catch { /* the page does not exist (yet): the image page stands alone */ }
    }
    return { status: result.status, slug: result.slug, ...(result.error ? { error: result.error } : {}), ...(linked ? { image_of: linked } : {}) };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

const file_upload_commit: Operation = {
  name: 'file_upload_commit',
  idempotent: false,
  mutating: true,
  outputRedaction: 'no_stored_text',
  description: 'Finish an upload begun with file_upload_begin: checks the received bytes against the declared size and SHA-256, stores the file '
    + '(<page_slug>/<filename>, or unsorted/<hash>-<filename>) and records it, and with import: true turns an image into a searchable image page. '
    + 'A failed import never loses the stored file. Needs files (or admin) scope.',
  callShape: '{"upload_id":"<from file_upload_begin>"}',
  params: {
    upload_id: { type: 'string', required: true, description: 'The upload_id file_upload_begin returned' },
  },
  scope: 'files',
  handler: async (ctx, p) => {
    const id = requireUploadId(p.upload_id);
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload_commit', upload_id: id };
    const { storage, metadata } = await resolveFileStorage(ctx, 'file_upload_commit');
    const manifest = await readManifest(ctx, storage, id);
    if (Date.parse(manifest.expires_at) < Date.now()) {
      await dropStaging(storage, id);
      throw uploadNotFound(id);
    }
    const bytes = await loadStagedBytes(storage, manifest);
    const sniffed = sniffMime(bytes);
    const mime = sniffed ?? manifest.mime_type ?? EXT_MIME[extOf(manifest.filename)] ?? null;
    // The image importer decodes by extension and records the image at its path, so an image to import is stored under
    // a name whose extension matches its real type (photo -> photo.png); every other file keeps the caller's name.
    const imageExt = sniffed ? IMAGE_EXT[sniffed] : undefined;
    const filename = manifest.import && imageExt && !sameImageExt(extOf(manifest.filename), imageExt) ? `${manifest.filename}${imageExt}` : manifest.filename;
    const storagePath = uploadLayoutPath(manifest.page_slug, filename, manifest.sha256);
    const stored = await storeAndRecordFile(ctx, storage, metadata, {
      storagePath, filename, pageSlug: manifest.page_slug, hash: manifest.sha256, size: bytes.length, mimeType: mime,
      put: () => storage.upload(storagePath, bytes, mime ?? undefined),
    });
    const imported = !manifest.import ? undefined : imageExt
      ? await importUploadedImage(ctx, { bytes, storagePath, pageSlug: manifest.page_slug, filename, metadata })
      : { status: 'skipped', reason: 'not an image the importer reads (png, jpeg, gif, webp, avif, heic)' };
    await dropStaging(storage, id);
    return { ...stored, size_bytes: bytes.length, mime_type: mime, ...(imported ? { import: imported } : {}) };
  },
};

const file_upload_abort: Operation = {
  name: 'file_upload_abort',
  idempotent: true,
  mutating: true,
  outputRedaction: 'no_stored_text',
  description: 'Drop a pending upload begun with file_upload_begin and every byte staged for it. Needs files (or admin) scope.',
  params: {
    upload_id: { type: 'string', required: true, description: 'The upload_id file_upload_begin returned' },
  },
  scope: 'files',
  handler: async (ctx, p) => {
    const id = requireUploadId(p.upload_id);
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload_abort', upload_id: id };
    const { storage } = await resolveFileStorage(ctx, 'file_upload_abort');
    await readManifest(ctx, storage, id);
    await dropStaging(storage, id);
    return { upload_id: id, status: 'aborted' };
  },
};

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const file_get: Operation = {
  name: 'file_get',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Return a stored file\'s bytes: png/jpeg/gif/webp images as an image you can see, any other file as data_base64. '
    + 'Files larger than this connection\'s result cap are refused (result_too_large); use file_url for a download link instead. Find storage_path with file_list. Needs files (or admin) scope.',
  callShape: '{"storage_path":"meetings/2026-01-15/whiteboard.png"}',
  params: {
    storage_path: { type: 'string', required: true, description: 'Stored path of the file, as file_list lists it' },
  },
  scope: 'files',
  handler: async (ctx, p) => {
    const path = String(p.storage_path ?? '');
    const rows = await ctx.engine.executeRaw<{ storage_path: string; filename: string; mime_type: string | null; size_bytes: number | string | bigint | null; content_hash: string }>(
      `SELECT storage_path, filename, mime_type, size_bytes, content_hash FROM files f WHERE storage_path = $1 AND ${await fileReadableSql(ctx)}`, [path]);
    if (rows.length === 0) throw opError('storage_error', `File not found: ${path}`, 'No file row has that storage_path; list stored files with file_list and use a storage_path from it.');
    const row = rows[0];
    const size = row.size_bytes == null ? null : Number(row.size_bytes);
    const cap = await resultByteCap({ remote: ctx.remote, transport: ctx.transport, engine: ctx.engine, config: ctx.config });
    if (size !== null && Number.isFinite(cap) && Math.ceil(size / 3) * 4 + 4096 > cap) {
      throw opError('result_too_large', `${path} is ${size} bytes; this connection carries at most ${cap} bytes per result.`,
        'Get a download link with file_url instead (or raise mcp.max_result_bytes_http on the brain host).');
    }
    const { storage } = await resolveFileStorage(ctx, 'file_get');
    let bytes: Buffer;
    try {
      bytes = await storage.download(path);
    } catch (error) {
      throw opError('storage_error', `The storage backend has no readable object at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        'The bytes are missing from storage; `gbrain files verify` lists every row in this state.');
    }
    const mime = sniffMime(bytes) ?? row.mime_type ?? 'application/octet-stream';
    const meta = { storage_path: row.storage_path, filename: row.filename, mime_type: mime, size_bytes: bytes.length, sha256: row.content_hash };
    if (INLINE_IMAGE_TYPES.has(mime)) {
      return Object.assign({ ...meta, content: 'image (attached as an image block)' },
        { [MCP_EXTRA_CONTENT]: [{ type: 'image' as const, data: bytes.toString('base64'), mimeType: mime }] });
    }
    return { ...meta, data_base64: bytes.toString('base64') };
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const fileTransferOperations: Operation[] = [file_upload_begin, file_upload_part, file_upload_commit, file_upload_abort, file_get];
