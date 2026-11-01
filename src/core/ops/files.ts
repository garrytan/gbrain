/**
 * File Operations cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `filesOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { opError } from './contract.ts';
import { hostFix, readFix } from './op-fix.ts';
import { validateFilename, validatePageSlug, validateUploadPath } from './context.ts';
import { privatePagesFilterForCaller, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { hookSessionCwd } from '../session-cwd.ts';
import { pageNotVisibleError } from '../persistence/page-visibility.ts';

// --- File Operations ---

// Both branches need a LIMIT. Without one, the slug-filtered branch materializes
// every file for that slug — an MCP caller can force unbounded memory consumption
// by targeting a page with many attachments.
const FILE_LIST_LIMIT = 100;

/**
 * GBRA-218: a caller under the read policy (every remote caller, stdio included) sees no file attached to a page it
 * cannot read, by the page's id or by its slug in any source (a file row names its page loosely, so it fails closed).
 */
async function fileReadableSql(ctx: OperationContext): Promise<string> {
  if (!await resolveExcludePrivatePages(ctx.engine, ctx.remote)) return 'TRUE';
  return `NOT EXISTS (SELECT 1 FROM pages fp WHERE (fp.id = f.page_id OR fp.slug = f.page_slug) AND NOT ${privatePagesFilterForCaller('fp')})`;
}

const file_list: Operation = {
  name: 'file_list',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'List files stored in the brain\'s file storage, optionally for one page. Use when finding attachments before file_url. Needs admin scope and the local stdio server.',
  params: {
    slug: { type: 'string', description: 'Filter by page slug' },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const slug = p.slug as string | undefined;
    const rows = await ctx.engine.executeRaw<Record<string, unknown>>(`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${slug === undefined ? 'TRUE' : 'f.page_slug = $2'}) AND ${await fileReadableSql(ctx)}
      ORDER BY ${slug === undefined ? 'page_slug, filename' : 'filename'} LIMIT $1`, slug === undefined ? [FILE_LIST_LIMIT] : [FILE_LIST_LIMIT, slug]);
    // Postgres returns size_bytes (BIGINT) as native BigInt — JSON.stringify
    // throws on those, breaking MCP callers. PGLite returns Number already.
    // 9 PB ceiling (2^53 bytes) is far above any plausible file size.
    return rows.map((r: Record<string, unknown>) => ({
      ...r,
      size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
    }));
  },
};

const file_upload: Operation = {
  name: 'file_upload',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Upload a local file into brain storage and attach it to a page. Use when a page needs its source document or image. Needs admin scope and the local stdio server; agent callers may only upload files under the server\'s working directory.',
  params: {
    path: { type: 'string', required: true, description: 'Local file path' },
    page_slug: { type: 'string', description: 'Associate with page' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload', path: p.path };

    const { statSync } = await import('fs');
    const { basename, extname, resolve } = await import('path');
    const { hashStorageFile, uploadUnchangedFile } = await import('../storage.ts');

    // A relative path means the session directory a launcher-started serve records, the same root it is confined to (#8426).
    const filePath = resolve(hookSessionCwd(), p.path as string);
    const pageSlug = (p.page_slug as string) || null;

    // Fix 1 / B5 / H5 / M4: validate path, slug, filename before any filesystem read.
    // Remote callers (MCP, agent) are confined to cwd (strict). Local CLI callers
    // can upload from anywhere on the filesystem (loose) — the user owns the machine.
    // Default is strict when ctx.remote is undefined (defense-in-depth).
    const strict = ctx.remote !== false;
    validateUploadPath(filePath, hookSessionCwd(), strict);
    if (pageSlug) validatePageSlug(pageSlug);
    const filename = basename(filePath);
    validateFilename(filename);

    const stat = statSync(filePath);
    const hash = hashStorageFile(filePath);
    const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;

    const MIME_TYPES: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    };
    const mimeType = MIME_TYPES[extname(filePath).toLowerCase()] || null;

    // #4302 (fail-closed honesty): a files row must never claim bytes that
    // were stored nowhere. With no storage backend configured, the old path
    // inserted the row and returned status:'uploaded' anyway — every later
    // read (file_url, files verify, restore) would trust a phantom object.
    // Typed error BEFORE any insert; git-tracked small files have their own
    // lane (`gbrain files upload-raw --page <slug>`).
    if (!ctx.config.storage) {
      const slugOk = pageSlug !== null && /^[a-z0-9][a-z0-9._/-]*$/i.test(pageSlug);
      // #5963: the git-tracked lane is refused on a managed worktree, so it is not offered there.
      if (slugOk && await (await import('../raw-file-upload.ts')).rawUploadRefusedFor(ctx.engine, pageSlug!, ctx.sourceId ?? 'default')) throw opError('storage_error',
        'No storage backend configured — file_upload would record a files row with no stored bytes.',
        'Configure `storage` in your gbrain config (supabase | s3 | local), then upload again. This page lives in a managed canonical worktree, which does not accept raw files from outside the persistence coordinator, so a storage backend is the only way to store it.');
      throw opError(
        'storage_error',
        'No storage backend configured — file_upload would record a files row with no stored bytes.',
        `Configure \`storage\` in your gbrain config (supabase | s3 | local), or use \`gbrain files upload-raw ${filePath} --page ${slugOk ? pageSlug : '<slug>'}\` for git-tracked small files.`,
        ...(slugOk ? [{ fix: hostFix(ctx, ['gbrain', 'files', 'upload-raw', filePath, '--page', pageSlug!],
          'With no storage backend, a small file goes into the brain repo next to its page instead (git-tracked, with a .redirect.yaml pointer).') }] : []),
      );
    }
    const { createStorage } = await import('../storage.ts');
    const storage = await createStorage(ctx.config.storage as any);

    const { sqlQueryForEngine, executeRawJsonb, FILES_METADATA_MERGE_SQL } = await import('../sql-query.ts');
    const sql = sqlQueryForEngine(ctx.engine);
    const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
    if (existing.length > 0) {
      // #4302: only claim already_exists when the BACKEND really holds the
      // object — a DB row whose bytes vanished must re-upload, not lie.
      let inBackend = false;
      try {
        inBackend = await storage.exists(storagePath);
      } catch { /* probe failure → treat as absent, re-upload below */ }
      if (inBackend) {
        return { status: 'already_exists', storage_path: storagePath };
      }
    }

    try {
      await uploadUnchangedFile(storage, storagePath, filePath, hash, mimeType || undefined);
    } catch (uploadErr) {
      throw opError('storage_error', `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
        'Nothing was recorded. Check the storage backend (credentials, bucket, disk) with `gbrain doctor --json`, then upload again; the upload is keyed by content hash, so repeating it is safe.');
    }

    try {
      // #4910: stamp the storage lane (doctor image_assets / files verify
      // classify on it) and merge metadata on conflict so legacy `{}` rows
      // heal on their next content change. Real object via executeRawJsonb —
      // never a JSON string into ::jsonb (#2339).
      await executeRawJsonb(
        ctx.engine,
        `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (storage_path) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           size_bytes = EXCLUDED.size_bytes,
           mime_type = EXCLUDED.mime_type,
           ${FILES_METADATA_MERGE_SQL}`,
        [pageSlug, filename, storagePath, mimeType, stat.size, hash],
        [{ storage: (ctx.config.storage as { backend: string }).backend }],
      );
    } catch (dbErr) {
      // Rollback: clean up storage if DB write failed
      try {
        await storage.delete(storagePath);
      } catch { /* best effort cleanup */ }
      throw dbErr;
    }

    return { status: 'uploaded', storage_path: storagePath, size_bytes: stat.size };
  },
};

const file_url: Operation = {
  name: 'file_url',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Return a URL for a stored file. Use when a user needs to open an attachment listed by file_list. Needs admin scope and the local stdio server. On storage_error: list the files again with file_list.',
  params: {
    storage_path: { type: 'string', required: true },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const rows = await ctx.engine.executeRaw<Record<string, unknown>>(`SELECT storage_path, mime_type, size_bytes FROM files f
      WHERE storage_path = $1 AND ${await fileReadableSql(ctx)}`, [p.storage_path as string]);
    if (rows.length === 0) {
      throw opError('storage_error', `File not found: ${p.storage_path}`, 'No file row has that storage_path. List stored files (fix) and use a storage_path from that list.',
        { fix: readFix('Lists stored files with their storage_path.', { argv: ['gbrain', 'files', 'list'], mcp: { tool: 'file_list', arguments: {} } }) });
    }
    // #4302: resolve a REAL URL from the backend, after confirming the object
    // is actually there — the old `gbrain:files/<path>` placeholder pointed
    // at nothing and hid rows whose bytes had vanished.
    if (!ctx.config.storage) {
      throw opError(
        'storage_error',
        `No storage backend configured — cannot produce a URL for ${p.storage_path}.`,
        'Configure `storage` in your gbrain config (supabase | s3 | local).',
      );
    }
    const { createStorage } = await import('../storage.ts');
    const storage = await createStorage(ctx.config.storage as any);
    const present = await storage.exists(rows[0].storage_path as string).catch(() => false);
    if (!present) {
      throw opError(
        'storage_error',
        `File row exists but the storage backend has no object at ${rows[0].storage_path} — re-upload it.`,
        'The bytes are missing from storage. Re-upload the original file with file_upload (same path); `gbrain files verify` lists every row in this state.',
      );
    }
    return { storage_path: rows[0].storage_path, url: await storage.getUrl(rows[0].storage_path as string) };
  },
};


/**
 * A storage path as a host hands it: relative, forward-slash separated, with no empty, `.` or `..` segment, no
 * backslash and no control character. The backend resolves it under its own bucket, so this is the whole check.
 */
function validateStoragePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) {
    throw opError('invalid_params', 'storage_path must be a non-empty string of at most 1024 characters', 'Pass the object\'s path in the brain\'s storage, such as people/alice-example/photo.jpg.');
  }
  // eslint-disable-next-line no-control-regex
  if (path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw opError('invalid_params', `Invalid storage_path: ${JSON.stringify(path)}`, 'Pass a relative path of forward-slash separated segments, with no empty, "." or ".." segment, no backslash and no control character.');
  }
  return path;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Registers a file whose bytes a host has already put in the brain's storage backend: it checks the backend holds
 * an object at `storage_path` and records the files row, the same row `file_upload` records, and nothing else. It
 * reads no local file, so it is not localOnly; the bytes never pass through the process that runs it.
 */
const file_register: Operation = {
  name: 'file_register',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Record a file whose bytes are already in the brain\'s file storage at storage_path, and attach it to a page. Use when a host has stored the object itself and needs the brain to know about it. Needs admin scope; refused, with nothing recorded, when storage holds no object at storage_path.',
  params: {
    storage_path: { type: 'string', required: true, description: 'Where the object is in the brain\'s storage' },
    filename: { type: 'string', required: true, description: 'The file\'s name' },
    size_bytes: { type: 'number', required: true, description: 'The object\'s size in bytes' },
    content_hash: { type: 'string', required: true, description: 'SHA-256 of the object\'s bytes, 64 lowercase hex characters' },
    mime_type: { type: 'string', description: 'The file\'s media type' },
    page_slug: { type: 'string', description: 'Associate with page' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const storagePath = validateStoragePath(p.storage_path);
    const filename = p.filename as string;
    validateFilename(filename);
    const pageSlug = (p.page_slug as string | undefined) || null;
    if (pageSlug) validatePageSlug(pageSlug);
    const size = p.size_bytes;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw opError('invalid_params', 'size_bytes must be a whole number of bytes, zero or more', 'Pass the object\'s size as an integer.');
    }
    const hash = p.content_hash;
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      throw opError('invalid_params', 'content_hash must be the SHA-256 of the bytes as 64 lowercase hex characters', 'Pass the hex SHA-256 of the object\'s bytes.');
    }
    const mimeType = typeof p.mime_type === 'string' && p.mime_type.length > 0 ? p.mime_type : null;
    if (ctx.dryRun) return { dry_run: true, action: 'file_register', storage_path: storagePath };

    // The read policy file_list and file_url apply: a caller cannot attach a file to a page it cannot read, nor
    // replace the row of a file attached to one.
    const readable = await fileReadableSql(ctx);
    if (readable !== 'TRUE') {
      const hidden = await ctx.engine.executeRaw(`SELECT 1 FROM (SELECT $1::text AS page_slug, NULL::integer AS page_id
        UNION ALL SELECT page_slug, page_id FROM files WHERE storage_path = $2) f WHERE NOT ${readable} LIMIT 1`, [pageSlug, storagePath]);
      if (hidden.length > 0) throw pageNotVisibleError();
    }

    // #4302 (fail-closed honesty): a files row never claims bytes that are stored nowhere.
    if (!ctx.config.storage) {
      throw opError('storage_error', 'No storage backend configured — file_register would record a files row for bytes stored nowhere.',
        'Configure `storage` in the gbrain config the host hands this brain, then register again.');
    }
    const { createStorage } = await import('../storage.ts');
    const storage = await createStorage(ctx.config.storage as any);
    let present: boolean;
    try {
      present = await storage.exists(storagePath);
    } catch (error) {
      throw opError('storage_error', `Could not reach the storage backend: ${error instanceof Error ? error.message : String(error)}`,
        'Nothing was recorded. Check the storage backend, then register again; registering is idempotent.');
    }
    if (!present) {
      throw opError('storage_error', `The storage backend holds no object at ${storagePath}; nothing was recorded.`,
        'Store the object at storage_path first, then register it.');
    }

    const { executeRawJsonb, FILES_METADATA_MERGE_SQL } = await import('../sql-query.ts');
    await executeRawJsonb(
      ctx.engine,
      `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         page_slug = EXCLUDED.page_slug,
         filename = EXCLUDED.filename,
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type,
         ${FILES_METADATA_MERGE_SQL}`,
      [pageSlug, filename, storagePath, mimeType, size, hash],
      [{ storage: (ctx.config.storage as { backend: string }).backend }],
    );
    return { status: 'registered', storage_path: storagePath, size_bytes: size };
  },
};

/** Whether the backend holds an object; a backend that cannot be asked is an error, never an object reported missing. */
async function present(storage: { exists(path: string): Promise<boolean> }, path: string): Promise<boolean> {
  try {
    return await storage.exists(path);
  } catch (error) {
    throw opError('storage_error', `Could not reach the storage backend: ${error instanceof Error ? error.message : String(error)}`,
      'Nothing about the files is known until the storage backend answers. Check it, then ask again.');
  }
}

// The same bound file_list keeps, for the same reason.
const FILE_VERIFY_LIMIT = 100;

/**
 * The files rows, each checked against the storage backend (`gbrain files verify`, as an operation): without
 * storage_path, every row (optionally one page's) and whether its object is present; with storage_path, that row's
 * bytes read back through the backend, hashed as they stream, and compared with the row. Reads no local file and
 * returns no file content, so it is not localOnly.
 */
const file_verify: Operation = {
  name: 'file_verify',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Check stored files against the brain\'s file storage. Without storage_path, lists the files (optionally one page\'s) and whether each object is present; with storage_path, reads that file\'s bytes back and says whether they match its recorded size and hash. Needs admin scope.',
  params: {
    storage_path: { type: 'string', description: 'Read back this file and compare it with its row' },
    slug: { type: 'string', description: 'Only this page\'s files' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    if (!ctx.config.storage) {
      throw opError('storage_error', 'No storage backend configured — stored files cannot be checked.',
        'Configure `storage` in the gbrain config the host hands this brain.');
    }
    const { createStorage } = await import('../storage.ts');
    const storage = await createStorage(ctx.config.storage as any);
    const row = (r: Record<string, unknown>): Record<string, unknown> => ({ ...r, size_bytes: r.size_bytes == null ? null : Number(r.size_bytes) });
    // The same read policy as file_list and file_url: a caller sees no file attached to a page it cannot read.
    const readable = await fileReadableSql(ctx);

    if (p.storage_path !== undefined) {
      const storagePath = validateStoragePath(p.storage_path);
      const rows = await ctx.engine.executeRaw<Record<string, unknown>>(`SELECT page_slug, filename, storage_path, mime_type, size_bytes, content_hash
        FROM files f WHERE storage_path = $1 AND ${readable}`, [storagePath]);
      if (rows.length === 0) {
        throw opError('storage_error', `File not found: ${storagePath}`, 'No file row has that storage_path. List the stored files with file_verify and no storage_path.');
      }
      const recorded = row(rows[0] as Record<string, unknown>);
      if (!(await present(storage, storagePath))) return { ...recorded, present: false, matches: false };
      const { hashStoredObject } = await import('../storage.ts');
      const read = await hashStoredObject(storage, storagePath);
      return {
        ...recorded,
        present: true,
        read_bytes: read.size,
        read_sha256: read.sha256,
        matches: read.size === recorded.size_bytes && read.sha256 === String(recorded.content_hash).replace(/^sha256:/, ''),
      };
    }

    const slug = p.slug as string | undefined;
    const rows = await ctx.engine.executeRaw<Record<string, unknown>>(`SELECT page_slug, filename, storage_path, mime_type, size_bytes, content_hash
      FROM files f WHERE (${slug === undefined ? 'TRUE' : 'f.page_slug = $2'}) AND ${readable}
      ORDER BY ${slug === undefined ? 'page_slug, filename' : 'filename'} LIMIT $1`, slug === undefined ? [FILE_VERIFY_LIMIT] : [FILE_VERIFY_LIMIT, slug]);
    const out = [];
    for (const r of rows) {
      out.push({ ...row(r as Record<string, unknown>), present: await present(storage, String((r as Record<string, unknown>).storage_path)) });
    }
    return out;
  },
};


// Ops in EXACTLY the canonical `operations` array order.
export const filesOperations: Operation[] = [file_list, file_upload, file_url, file_register, file_verify];
