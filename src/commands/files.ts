import { readFileSync, readdirSync, statSync, lstatSync, existsSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync } from 'fs';
import { join, relative, extname, basename, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { StorageBackend, StorageConfig } from '../core/storage.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../core/sql-query.ts';
import { humanSize } from '../core/file-resolver.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

/** Size threshold: files >= 100 MB use TUS resumable upload */
const SIZE_THRESHOLD = 100 * 1024 * 1024;

interface FileRecord {
  id: number;
  page_slug: string | null;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | bigint | string | null;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.heic': 'image/heic',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mpga': 'audio/mpeg',
  '.webm': 'video/webm', '.mpeg': 'video/mpeg',
  '.tiff': 'image/tiff', '.tif': 'image/tiff', '.dng': 'image/x-adobe-dng',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function getMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || null;
}

function fileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function formatFileSizeKb(rawSizeBytes: number | bigint | string | null): string {
  if (rawSizeBytes == null) return '?';
  const sizeBytes = Number(rawSizeBytes);
  return Number.isFinite(sizeBytes) && sizeBytes >= 0
    ? `${Math.round(sizeBytes / 1024)}KB`
    : '?';
}

/**
 * The message every storage-dependent `files` subcommand prints when there is
 * no backend. Exported so tests assert the contract without spawning a CLI.
 */
export function noStorageBackendMessage(op: string): string {
  return (
    `gbrain files ${op}: no storage backend configured — refusing to continue.\n` +
    `  The files table records metadata only (there is no blob column), so without a\n` +
    `  backend the bytes go nowhere while the DB claims they are stored.\n` +
    `  Fix: configure storage (see gbrain init storage settings), or keep the binary\n` +
    `  outside the brain and capture its extracted text instead.`
  );
}

/**
 * Single precondition for every storage-dependent `files` subcommand (#4022).
 *
 * Class fix (see `noStorageBackendMessage`): `upload`, `sync`, and `redirect`
 * each tested storage permissively (`if (config?.storage)`) and then carried on
 * when the answer was "no" — inserting rows, printing "uploaded", and in
 * `redirect` unlinking local originals whose bytes had never left the machine.
 * Storage-dependent work must refuse up front rather than half-succeed, so this
 * exits BEFORE any DB write or local mutation.
 */
async function requireStorageBackend(
  op: string,
): Promise<{ storage: StorageBackend; storageConfig: StorageConfig }> {
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    console.error(noStorageBackendMessage(op));
    process.exit(1);
  }
  const { createStorage } = await import('../core/storage.ts');
  const storageConfig = config.storage as StorageConfig;
  return { storage: await createStorage(storageConfig), storageConfig };
}

export async function runFiles(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list':
      await listFiles(engine, args[1]);
      break;
    case 'upload':
      await uploadFile(engine, args.slice(1));
      break;
    case 'sync':
      await syncFiles(engine, args[1]);
      break;
    case 'verify':
      await verifyFiles(engine);
      break;
    case 'mirror':
      await mirrorFiles(args.slice(1));
      break;
    case 'unmirror':
      await unmirrorFiles(args.slice(1));
      break;
    case 'redirect':
      await redirectFiles(args.slice(1));
      break;
    case 'restore':
      await restoreFiles(args.slice(1));
      break;
    case 'clean':
      await cleanFiles(args.slice(1));
      break;
    case 'upload-raw':
      await uploadRaw(engine, args.slice(1));
      break;
    case 'signed-url':
      await signedUrl(args.slice(1));
      break;
    case 'status':
      await filesStatus(args.slice(1));
      break;
    default:
      console.error(`Usage: gbrain files <command> [args]`);
      console.error(`  list [slug]               List files for a page (or all)`);
      console.error(`  upload <file> --page <slug>  Upload file linked to page`);
      console.error(`  upload-raw <file> --page <slug> [--type <type>]  Smart upload with .redirect.yaml pointer`);
      console.error(`  signed-url <path>         Generate signed URL for stored file`);
      console.error(`  sync <dir>                Upload directory to storage`);
      console.error(`  verify                    Verify all uploads match local`);
      console.error(`  mirror <dir> [--dry-run]  Mirror files to cloud storage`);
      console.error(`  unmirror <dir>            Remove mirror marker (files stay in storage)`);
      console.error(`  redirect <dir> [--dry-run]  Replace files with .redirect.yaml pointers`);
      console.error(`  restore <dir>             Download from storage, recreate local files`);
      console.error(`  clean <dir> [--yes]       Delete redirect pointers (irreversible)`);
      console.error(`  status                    Show migration status of directories`);
      process.exit(1);
  }
}

async function listFiles(engine: BrainEngine, slug?: string) {
  const sql = sqlQueryForEngine(engine);
  let rows;
  if (slug) {
    rows = await sql`SELECT * FROM files WHERE page_slug = ${slug} ORDER BY filename LIMIT 100`;
  } else {
    rows = await sql`SELECT * FROM files ORDER BY page_slug, filename LIMIT 100`;
  }

  if (rows.length === 0) {
    console.log(slug ? `No files for page: ${slug}` : 'No files stored.');
    return;
  }

  console.log(`${rows.length} file(s):`);
  for (const row of rows) {
    const size = formatFileSizeKb(row.size_bytes as FileRecord['size_bytes']);
    console.log(`  ${row.page_slug || '(unlinked)'} / ${row.filename}  [${size}, ${row.mime_type || '?'}]`);
  }
}

async function uploadFile(engine: BrainEngine, args: string[]) {
  const filePath = args.find(a => !a.startsWith('--'));
  const pageSlug = args.find((a, i) => args[i - 1] === '--page') || null;

  if (!filePath || !existsSync(filePath)) {
    console.error('Usage: gbrain files upload <file> --page <slug>');
    process.exit(1);
  }

  // Precondition first: a backend-less upload can only produce a phantom row
  // (metadata for bytes that were never stored), so refuse before touching the
  // DB or reporting anything as uploaded.
  const { storage } = await requireStorageBackend('upload');

  const stat = statSync(filePath);
  const hash = fileHash(filePath);
  const filename = basename(filePath);
  const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;
  const mimeType = getMimeType(filePath);

  const sql = sqlQueryForEngine(engine);

  // Check for existing file by hash — but only trust the row when the
  // BACKEND really holds the object (#4302); vanished bytes must re-upload.
  const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
  if (existing.length > 0 && (await storage.exists(storagePath).catch(() => false))) {
    console.log(`File already uploaded (hash match): ${storagePath}`);
    return;
  }

  const content = readFileSync(filePath);
  const method = content.length >= SIZE_THRESHOLD ? 'TUS resumable' : 'standard';
  console.log(`Uploading ${humanSize(stat.size)} via ${method}...`);
  await storage.upload(storagePath, content, mimeType || undefined);

  // files.metadata is JSONB — bind a real object via executeRawJsonb instead
  // of casting a string into ::jsonb (the #2339 double-encode class).
  await executeRawJsonb(
    engine,
    `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (storage_path) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       size_bytes = EXCLUDED.size_bytes,
       mime_type = EXCLUDED.mime_type`,
    [pageSlug, filename, storagePath, mimeType, stat.size, hash],
    [{}],
  );

  console.log(`Uploaded: ${storagePath} (${humanSize(stat.size)})`);
}

/**
 * Smart upload with size routing and .redirect.yaml pointer creation.
 *
 * Size routing:
 *   < 100 MB text/PDF  → stays in git (brain repo), no cloud upload
 *   >= 100 MB OR media  → upload to cloud storage, create .redirect.yaml pointer
 *
 * The .redirect.yaml pointer stays in the brain repo so git tracks what was stored.
 */
async function uploadRaw(engine: BrainEngine, args: string[]) {
  const filePath = args.find(a => !a.startsWith('--'));
  const pageSlug = args.find((a, i) => args[i - 1] === '--page') || null;
  const fileType = args.find((a, i) => args[i - 1] === '--type') || null;
  const noPointer = args.includes('--no-pointer');

  if (!filePath || !existsSync(filePath)) {
    console.error('Usage: gbrain files upload-raw <file> --page <slug> [--type <type>] [--no-pointer]');
    process.exit(1);
  }

  const stat = statSync(filePath);
  const filename = basename(filePath);
  const mimeType = getMimeType(filePath);
  const isMedia = mimeType?.startsWith('video/') || mimeType?.startsWith('audio/') || mimeType?.startsWith('image/');
  const needsCloud = stat.size >= SIZE_THRESHOLD || isMedia;

  if (!needsCloud) {
    // #2297: small text/PDF files "stay in git" — which used to mean the
    // command did NOTHING (no repo copy, no files row) while printing
    // success:true. Actually bank the file: copy it into the page's .raw/
    // sidecar dir inside the brain repo and record a files row so
    // `gbrain files list` / `verify` can see it.
    if (!pageSlug) {
      console.error('files upload-raw: --page <slug> is required for git-storage (small text/PDF) files.');
      process.exit(1);
    }
    const { resolveSourceId } = await import('../core/source-resolver.ts');
    const { resolvePageWriteTarget } = await import('../core/write-through.ts');
    const sourceArg = args.find((a, i) => args[i - 1] === '--source') || null;
    const sourceId = await resolveSourceId(engine, sourceArg);
    const target = await resolvePageWriteTarget(engine, pageSlug, sourceId);
    if (!target.ok) {
      console.error(
        `files upload-raw: cannot resolve a brain-repo destination for page "${pageSlug}" ` +
        `(${target.skipped}). Configure sync.repo_path (or the source's local_path), ` +
        `or use \`gbrain files upload\` with a cloud storage backend.`,
      );
      process.exit(1);
    }
    // <pageDir>/.raw/<page-name>/<basename> — sidecar layout next to the
    // page's canonical markdown artifact.
    const pageDir = dirname(target.filePath);
    const pageName = basename(target.filePath).replace(/\.md$/i, '');
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- pageDir/pageName derive from resolvePageWriteTarget's brain-repo target for the operator's own --page slug; upload-raw is a trusted-local CLI lane (runFiles is wired only from cli.ts, remote:false — the MCP file_upload op is a separate localOnly handler)
    const destDir = join(pageDir, '.raw', pageName);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- filename is basename() of the operator's own CLI file arg (basename yields a single separator-free segment), joined under the brain-repo sidecar dir above
    const dest = join(destDir, filename);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- identity comparison only (skip self-copy when source already IS the dest); no fs path is derived from this expression
    if (resolve(dest) !== resolve(filePath)) {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(filePath, dest);
    }
    const hash = fileHash(filePath);
    const storagePath = relative(target.writeRoot, dest);
    await executeRawJsonb(
      engine,
      `INSERT INTO files (source_id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type`,
      [sourceId, pageSlug, filename, storagePath, mimeType, stat.size, 'sha256:' + hash],
      [{ storage: 'git', type: fileType }],
    );
    console.log(JSON.stringify({
      success: true,
      storage: 'git',
      path: dest,
      storagePath,
      size: stat.size,
      size_human: humanSize(stat.size),
      hash: `sha256:${hash}`,
    }));
    return;
  }

  // Upload to cloud storage
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    console.error('No storage backend configured. Run gbrain init with storage settings.');
    console.error('Or use gbrain files upload for manual uploads.');
    process.exit(1);
  }

  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);
  const content = readFileSync(filePath);
  const hash = createHash('sha256').update(content).digest('hex');
  const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;
  const bucket = (config.storage as any).bucket || 'brain-files';

  const method = content.length >= SIZE_THRESHOLD ? 'TUS resumable' : 'standard';
  console.error(`Uploading ${humanSize(stat.size)} via ${method}...`);
  await storage.upload(storagePath, content, mimeType || undefined);

  // Create .redirect.yaml pointer in the brain repo
  let pointerPath: string | null = null;
  if (!noPointer && pageSlug) {
    const { stringify } = await import('../core/yaml-lite.ts');
    const pointer = stringify({
      target: `supabase://${bucket}/${storagePath}`,
      bucket,
      storage_path: storagePath,
      size: stat.size,
      size_human: humanSize(stat.size),
      hash: `sha256:${hash}`,
      mime: mimeType || 'application/octet-stream',
      uploaded: new Date().toISOString(),
      ...(fileType ? { type: fileType } : {}),
    });
    // Write pointer next to the original file
    pointerPath = filePath + '.redirect.yaml';
    writeFileSync(pointerPath, pointer);
    console.error(`Pointer written: ${pointerPath}`);
  }

  // Record in DB. files.metadata is JSONB — pass the object via
  // executeRawJsonb with an explicit ::jsonb cast so post-v0.31 reads see
  // an actual object, not a JSON-encoded string (D1 wave).
  await executeRawJsonb(
    engine,
    `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (storage_path) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       size_bytes = EXCLUDED.size_bytes,
       mime_type = EXCLUDED.mime_type`,
    [pageSlug, filename, storagePath, mimeType, stat.size, 'sha256:' + hash],
    [{ type: fileType, upload_method: method }],
  );

  // Output JSON for scripting
  console.log(JSON.stringify({
    success: true,
    storage: 'supabase',
    storagePath,
    bucket,
    reference: `supabase://${bucket}/${storagePath}`,
    pointerPath,
    size: stat.size,
    size_human: humanSize(stat.size),
    hash: `sha256:${hash}`,
    upload_method: method,
  }));
}

/** Generate a signed URL for a stored file */
async function signedUrl(args: string[]) {
  const storagePath = args.find(a => !a.startsWith('--'));
  if (!storagePath) {
    console.error('Usage: gbrain files signed-url <storage-path>');
    process.exit(1);
  }

  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (!config?.storage) {
    console.error('No storage backend configured.');
    process.exit(1);
  }

  const { createStorage } = await import('../core/storage.ts');
  const storage = await createStorage(config.storage as any);
  const url = await storage.getUrl(storagePath);
  console.log(url);
}

async function syncFiles(engine: BrainEngine, dir?: string) {
  if (!dir || !existsSync(dir)) {
    console.error('Usage: gbrain files sync <directory>');
    process.exit(1);
  }

  // Pre-fix this command inserted a `files` row per file and reported them as
  // "uploaded" without ever calling the storage backend — every row it produced
  // was a phantom, even on a brain WITH storage configured.
  const { storage } = await requireStorageBackend('sync');

  const files = collectFiles(dir);
  console.log(`Found ${files.length} files to sync`);

  let uploaded = 0;
  let skipped = 0;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('files.sync', files.length);

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relativePath = relative(dir, filePath);

    progress.tick(1);

    const hash = fileHash(filePath);
    const filename = basename(filePath);
    const storagePath = relativePath.replace(/\\/g, '/');
    const mimeType = getMimeType(filePath);
    const stat = statSync(filePath);

    const sql = sqlQueryForEngine(engine);
    const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    // Infer page slug from directory structure
    const pathParts = relativePath.split('/');
    const pageSlug = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : null;

    // Actually put the bytes in storage before recording them as stored.
    await storage.upload(storagePath, readFileSync(filePath), mimeType || undefined);

    // files.metadata is JSONB — bind a real object via executeRawJsonb instead
    // of casting a string into ::jsonb (the #2339 double-encode class).
    await executeRawJsonb(
      engine,
      `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type`,
      [pageSlug, filename, storagePath, mimeType, stat.size, hash],
      [{}],
    );

    uploaded++;
  }

  progress.finish();
  // Stdout summary preserved for scripts/tests that grep for it.
  console.log(`Files sync complete: ${uploaded} uploaded, ${skipped} skipped (unchanged)`);
}

async function verifyFiles(engine: BrainEngine) {
  const sql = sqlQueryForEngine(engine);
  const rows = await sql`SELECT * FROM files ORDER BY storage_path LIMIT 1000`;

  if (rows.length === 0) {
    console.log('No files to verify.');
    return;
  }

  // Pre-fix this loop asked only "does the ROW carry a hash and a path" — true
  // for any row an INSERT produced — and then printed a hardcoded
  // "0 mismatches, 0 missing". `missing` was declared and never incremented.
  // So the one command whose job is catching un-stored files reported phantom
  // rows as "verified". The check that matters is byte existence at
  // storage_path, which requires the backend (#4022) — except git-lane rows
  // (#4302), which verify against the brain repo on disk.
  let verified = 0;
  let mismatches = 0;
  let missing = 0;
  // #4022: cloud rows with no configured (or constructible) backend are
  // UNVERIFIABLE, never "verified" — almost certainly phantoms left by a
  // backend-less upload/sync. Counted per row so a git-lane-only brain
  // still passes without a backend.
  let unverifiable = 0;

  // #4302: verify against the actual bytes, not just DB row shape. Cloud rows
  // are probed via storage.exists (+ hash-checked via download for small
  // objects); git-storage rows (metadata.storage === 'git', the upload-raw
  // small-file lane) are checked against the brain repo on disk.
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  const storage = config?.storage
    ? await (await import('../core/storage.ts')).createStorage(config.storage as any).catch(() => null)
    : null;
  const repoPath = await engine.getConfig('sync.repo_path').catch(() => null);
  // Git-lane root resolution mirrors upload-raw's resolvePageWriteTarget:
  // storage_path was banked relative to the row's OWNING source's local_path
  // when that source has its own working tree, with sync.repo_path only as
  // the fallback. Joining every row against sync.repo_path falsely reported
  // MISSING (or hash-checked the wrong file) for separate-tree sources.
  const sourceLocalPathCache = new Map<string, string | null>();
  const gitRootFor = async (sourceId: unknown): Promise<string | null> => {
    const sid = typeof sourceId === 'string' && sourceId ? sourceId : null;
    if (!sid) return repoPath ? String(repoPath) : null;
    if (!sourceLocalPathCache.has(sid)) {
      let localPath: string | null = null;
      try {
        const srcRows = await sql`SELECT local_path FROM sources WHERE id = ${sid}`;
        localPath = srcRows[0]?.local_path ? String(srcRows[0].local_path) : null;
      } catch { /* sources table unavailable — fall back to sync.repo_path */ }
      sourceLocalPathCache.set(sid, localPath);
    }
    return sourceLocalPathCache.get(sid) ?? (repoPath ? String(repoPath) : null);
  };
  const HASH_CHECK_MAX_BYTES = 10 * 1024 * 1024;
  const normalizeHash = (h: string) => h.replace(/^sha256:/, '');

  for (const row of rows) {
    if (!row.content_hash || !row.storage_path) {
      mismatches++;
      console.error(`  MISMATCH: ${row.storage_path} (missing hash or path)`);
      continue;
    }
    const storagePath = String(row.storage_path);
    const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown> | null;
    if (meta?.storage === 'git') {
      const gitRoot = await gitRootFor(row.source_id);
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- gitRoot is the operator-written sources.local_path / sync.repo_path config; storage_path rows are banked exclusively by trusted-local writers (upload-raw's relative(writeRoot, dest) on the CLI, plus the localOnly file_upload op) — files verify is itself a CLI-only read that hash-compares and reports, never serves content
      const local = gitRoot ? join(gitRoot, storagePath) : null;
      if (!local || !existsSync(local)) {
        missing++;
        console.error(`  MISSING: ${row.storage_path} (git-storage file not in brain repo)`);
      } else if (normalizeHash(fileHash(local)) !== normalizeHash(String(row.content_hash))) {
        mismatches++;
        console.error(`  MISMATCH: ${row.storage_path} (repo file hash differs from DB record)`);
      } else {
        verified++;
      }
      continue;
    }
    if (storage) {
      const present = await storage.exists(storagePath).catch(() => false);
      if (!present) {
        missing++;
        console.error(`  MISSING: ${row.storage_path} (not in storage backend)`);
        continue;
      }
      const size = row.size_bytes == null ? null : Number(row.size_bytes);
      if (size !== null && size <= HASH_CHECK_MAX_BYTES) {
        try {
          const bytes = await storage.download(storagePath);
          const actual = createHash('sha256').update(bytes).digest('hex');
          if (actual !== normalizeHash(String(row.content_hash))) {
            mismatches++;
            console.error(`  MISMATCH: ${row.storage_path} (backend hash differs from DB record)`);
            continue;
          }
        } catch { /* download hiccup — exists() already vouched; count verified */ }
      }
      verified++;
    } else {
      // #4022: no backend — byte existence cannot be checked; report, never vouch.
      unverifiable++;
      console.error(`  UNVERIFIABLE: ${row.storage_path} (no storage backend configured)`);
    }
  }
  if (unverifiable > 0) {
    console.error(
      `gbrain files verify: ${unverifiable} cloud file row(s) recorded, but no storage backend is configured.\n` +
      `  Byte existence cannot be checked and these rows cannot be retrieved, so they are\n` +
      `  reported as UNVERIFIABLE rather than "verified" — almost certainly phantoms left by\n` +
      `  a backend-less upload/sync. Configure storage, or delete the rows.`,
    );
  }

  // Always report the real counts — never a hardcoded pair.
  console.log(`${verified} files verified, ${mismatches} mismatches, ${missing} missing, ${unverifiable} unverifiable`);
  if (mismatches > 0 || missing > 0 || unverifiable > 0) {
    console.error(`VERIFY FAILED: ${mismatches} mismatches, ${missing} missing, ${unverifiable} unverifiable.`);
    console.error(`Run: gbrain files sync --retry-failed`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────
// File Migration Commands (mirror → redirect → clean lifecycle)
// ─────────────────────────────────────────────────────────────────

async function mirrorFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files mirror <dir> [--dry-run]'); process.exit(1); }

  const { stringify } = await import('../core/yaml-lite.ts');
  const { storage, storageConfig } = await requireStorageBackend('mirror');
  const files = collectFiles(dir);
  console.log(`Found ${files.length} files to mirror`);

  if (dryRun) {
    for (const f of files) { console.log(`  Would upload: ${relative(dir, f)}`); }
    console.log(`\nDry run: ${files.length} files would be uploaded.`);
    return;
  }

  let uploaded = 0;
  for (const filePath of files) {
    const relPath = relative(dir, filePath);
    const data = readFileSync(filePath);
    const mime = getMimeType(filePath);
    await storage.upload(relPath, data, mime || undefined);
    uploaded++;
  }

  // Write .supabase marker
  const marker = stringify({
    synced_at: new Date().toISOString(),
    bucket: storageConfig?.bucket || 'brain-files',
    prefix: basename(dir) + '/',
    file_count: uploaded,
  });
  writeFileSync(join(dir, '.supabase'), marker);

  console.log(`Mirrored ${uploaded} files. Marker written to ${dir}/.supabase`);
}

async function unmirrorFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) { console.error('Usage: gbrain files unmirror <dir>'); process.exit(1); }

  const markerPath = join(dir, '.supabase');
  if (existsSync(markerPath)) {
    unlinkSync(markerPath);
    console.log(`Removed mirror marker from ${dir}. Files remain in storage.`);
  } else {
    console.log(`No mirror marker found in ${dir}. Nothing to do.`);
  }
}

async function redirectFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files redirect <dir> [--dry-run]'); process.exit(1); }

  const markerPath = join(dir, '.supabase');
  if (!existsSync(markerPath)) {
    console.error('Directory must be mirrored first. Run: gbrain files mirror <dir>');
    process.exit(1);
  }

  const { parse: parseYaml, stringify } = await import('../core/yaml-lite.ts');
  const marker = parseYaml(readFileSync(markerPath, 'utf-8'));
  const files = collectFiles(dir);

  if (dryRun) {
    for (const f of files) { console.log(`  Would redirect: ${relative(dir, f)}`); }
    console.log(`\nDry run: ${files.length} files would be redirected.`);
    return;
  }

  // Verify remote files exist before deleting locals.
  //
  // This is the destructive path: it unlinks the local original and leaves a
  // `supabase://` pointer behind. Pre-fix, `storage` was only built when a
  // backend happened to be configured (`if (config?.storage)`) and the
  // existence check was correspondingly conditional (`if (storage)`) — so with
  // no backend the guard was skipped entirely and the loop deleted originals
  // while writing pointers to bytes that had never been uploaded. Data loss,
  // not a phantom row. The backend is now mandatory here.
  const { storage } = await requireStorageBackend('redirect');

  let redirected = 0;
  let skippedMissing = 0;
  for (const filePath of files) {
    const relPath = relative(dir, filePath);
    const hash = fileHash(filePath);

    // Unconditional: never unlink a local original we have not confirmed
    // exists remotely.
    const remoteExists = await storage.exists(relPath);
    if (!remoteExists) {
      console.error(`  Skipping ${relPath}: not found in remote storage (would lose data)`);
      skippedMissing++;
      continue;
    }

    const stat = statSync(filePath);
    const mimeType = getMimeType(filePath);
    const bucket = marker.bucket || 'brain-files';
    const pointer = stringify({
      target: `supabase://${bucket}/${relPath}`,
      bucket,
      storage_path: relPath,
      size: stat.size,
      size_human: humanSize(stat.size),
      hash: `sha256:${hash}`,
      mime: mimeType || 'application/octet-stream',
      uploaded: new Date().toISOString(),
    });
    writeFileSync(filePath + '.redirect.yaml', pointer);
    unlinkSync(filePath);
    redirected++;
  }

  console.log(`Redirected ${redirected} files. Originals removed, breadcrumbs created.`);
  if (skippedMissing > 0) {
    console.log(`Skipped ${skippedMissing} files (not found in remote storage — run 'gbrain files mirror' first).`);
  }
  console.log('To undo: gbrain files restore <dir>');
}

async function restoreFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files restore <dir>'); process.exit(1); }

  const { createStorage } = await import('../core/storage.ts');
  const { loadConfig } = await import('../core/config.ts');
  const { parse: parseYaml } = await import('../core/yaml-lite.ts');
  const config = loadConfig();
  if (!config?.storage) { console.error('No storage backend configured.'); process.exit(1); }

  const storage = await createStorage(config.storage as any);
  const redirectFiles: string[] = [];

  function findRedirects(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // Broken symlink or permission error
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) findRedirects(full);
      else if (entry.endsWith('.redirect.yaml') || entry.endsWith('.redirect')) redirectFiles.push(full);
    }
  }
  findRedirects(dir);

  let restored = 0;
  let failed = 0;
  for (const redirectPath of redirectFiles) {
    const info = parseYaml(readFileSync(redirectPath, 'utf-8'));
    const originalPath = redirectPath.replace(/\.redirect(\.yaml)?$/, '');
    try {
      const storagePath = info.storage_path || info.path; // v0.9 or legacy format
      const data = await storage.download(storagePath);
      writeFileSync(originalPath, data);
      unlinkSync(redirectPath);
      restored++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  Failed to restore ${info.path}: ${msg}`);
      failed++;
    }
  }

  console.log(`Restored ${restored} files. ${failed > 0 ? `${failed} failed.` : ''}`);
}

async function cleanFiles(args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const confirmed = args.includes('--yes');
  if (!dir || !existsSync(dir)) { console.error('Usage: gbrain files clean <dir> [--yes]'); process.exit(1); }

  if (!confirmed) {
    console.error('WARNING: This permanently removes redirect pointers.');
    console.error('After this, files are only accessible from cloud storage.');
    console.error('Git history still has the originals if you need them.');
    console.error('Run with --yes to confirm.');
    process.exit(1);
  }

  let cleaned = 0;
  function findAndClean(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // Broken symlink or permission error
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) findAndClean(full);
      else if (entry.endsWith('.redirect.yaml') || entry.endsWith('.redirect')) { unlinkSync(full); cleaned++; }
    }
  }
  findAndClean(dir);

  console.log(`Cleaned ${cleaned} redirect breadcrumbs. Cloud storage is now the only source.`);
}

async function filesStatus(args: string[]) {
  const dir = args[0] || '.';

  let mirrored = 0, redirected = 0, local = 0;

  function scan(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.') && entry !== '.supabase') continue;
      const full = join(d, entry);
      if (entry === '.supabase') { mirrored++; continue; }
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // Broken symlink or permission error
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) scan(full);
      else if (entry.endsWith('.redirect.yaml') || entry.endsWith('.redirect')) redirected++;
      else if (!entry.endsWith('.md')) local++;
    }
  }
  scan(dir);

  console.log('File migration status:');
  console.log(`  Mirrored directories: ${mirrored}`);
  console.log(`  Redirected files: ${redirected}`);
  console.log(`  Local binary files: ${local}`);

  if (mirrored === 0 && redirected === 0 && local > 0) {
    console.log(`\n${local} local files. Run: gbrain files mirror <dir> to start migration.`);
  } else if (redirected > 0) {
    console.log(`\n${redirected} files redirected to storage. Run: gbrain files clean <dir> --yes to remove breadcrumbs.`);
  }
}

export function collectFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules') continue;

      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // Broken symlink or permission error
      }
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        walk(full);
      } else if (!entry.endsWith('.md')) {
        // Non-markdown files are candidates for storage
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
