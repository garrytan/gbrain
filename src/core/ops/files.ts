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
import { embeddedSettingsRecord, isEmbeddedEngine } from '../embedded-engine.ts';

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
    const embedded = isEmbeddedEngine(ctx.engine) ? await embeddedFileStore(ctx, 'file_upload') : null;
    if (!embedded && !ctx.config.storage) {
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
    const storage = embedded?.storage ?? await createStorage(ctx.config.storage as any);

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
        [embedded?.metadata ?? { storage: (ctx.config.storage as { backend: string }).backend }],
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
    const embedded = isEmbeddedEngine(ctx.engine);
    if (!embedded && !ctx.config.storage) {
      throw opError(
        'storage_error',
        `No storage backend configured — cannot produce a URL for ${p.storage_path}.`,
        'Configure `storage` in your gbrain config (supabase | s3 | local).',
      );
    }
    const { createStorage } = await import('../storage.ts');
    const storage = embedded ? await embeddedStorage(ctx, 'file_url') : await createStorage(ctx.config.storage as any);
    const present = await storage.exists(rows[0].storage_path as string).catch(error => {
      if (embedded) throw storeUnavailable('file_url', error);
      return false;
    });
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

/** file_verify serves a host that stores bytes itself: it runs only on an engine opened from settings, against its settings.storage, which every file op on such an engine uses. */
async function embeddedStorage(ctx: OperationContext, op: string) {
  if (!isEmbeddedEngine(ctx.engine)) throw opError('embedded_engine_required', `${op} runs only on an engine an embedding host opened from settings (embedded_core: true).`,
    'A brain the CLI or a server opens stores files only through file_upload (gbrain files upload), so there is nothing to check this way.');
  const settings = embeddedSettingsRecord(ctx.engine)?.storage;
  if (!settings) throw opError('storage_error', `This engine was opened with no settings.storage, so ${op} cannot check any stored object.`,
    'Open the engine with storage (local or s3, with its values) in its settings; the process storage config is never used for an engine opened from settings. Nothing was recorded.');
  const { settingsStorage } = await import('../storage.ts');
  try { return (await settingsStorage(ctx.engine))!; } catch (error) { throw storeUnavailable(op, error); }
}

async function embeddedFileStore(ctx: OperationContext, op: string) {
  const storage = await embeddedStorage(ctx, op);
  const { backend, prefix } = embeddedSettingsRecord(ctx.engine)!.storage!;
  return { storage, metadata: { storage: backend, ...(prefix ? { prefix } : {}) } };
}

function storeUnavailable(op: string, error: unknown) {
  return opError('store_unavailable', `${op} could not ask the storage backend: ${error instanceof Error ? error.message : String(error)}`,
    'The backend did not answer, so nothing is known about the object and nothing was recorded or reported missing. Check the backend with gbrain doctor --json, then call again.');
}

const file_verify: Operation = {
  name: 'file_verify',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: `Check files rows against the storage backend. Without storage_path, lists up to ${FILE_LIST_LIMIT} rows (optionally one page's) with whether each object is present; with it, reads that object back and says whether its size and SHA-256 match the row. Runs only on an engine opened from settings. A backend that fails the check is store_unavailable, never a file reported missing.`,
  params: {
    storage_path: { type: 'string', description: 'Read back and hash this one object' },
    slug: { type: 'string', description: 'List only this page\'s files' },
  },
  scope: 'admin',
  localOnly: true,
  cliOnly: { argv: ['gbrain', 'files', 'verify'] },
  handler: async (ctx, p) => {
    const storage = await embeddedStorage(ctx, 'file_verify');
    const readable = await fileReadableSql(ctx);
    if (p.storage_path !== undefined) {
      const rows = await ctx.engine.executeRaw<{ size_bytes: unknown; content_hash: string }>(`SELECT size_bytes, content_hash FROM files f WHERE f.storage_path = $1 AND ${readable}`, [p.storage_path as string]);
      if (rows.length === 0) throw opError('storage_error', `File not found: ${p.storage_path}`, 'No file row this caller can read has that storage_path. List them with file_verify and no storage_path.');
      const { hashStoredObject } = await import('../storage.ts');
      let stored: { size: number; sha256: string } | null;
      try { stored = await storage.exists(p.storage_path as string) ? await hashStoredObject(storage, p.storage_path as string) : null; }
      catch (error) { throw storeUnavailable('file_verify', error); }
      return { storage_path: p.storage_path, present: stored !== null,
        size_matches: stored !== null && stored.size === Number(rows[0]!.size_bytes), hash_matches: stored !== null && stored.sha256 === rows[0]!.content_hash };
    }
    const slug = p.slug as string | undefined;
    const rows = await ctx.engine.executeRaw<{ storage_path: string; page_slug: string | null }>(`SELECT storage_path, page_slug FROM files f
      WHERE (${slug === undefined ? 'TRUE' : 'f.page_slug = $2'}) AND ${readable} ORDER BY storage_path LIMIT $1`, slug === undefined ? [FILE_LIST_LIMIT] : [FILE_LIST_LIMIT, slug]);
    try { return await Promise.all(rows.map(async row => ({ ...row, present: await storage.exists(row.storage_path) }))); }
    catch (error) { throw storeUnavailable('file_verify', error); }
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const filesOperations: Operation[] = [file_list, file_upload, file_url, file_verify];
