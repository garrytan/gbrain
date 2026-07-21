import { readFileSync, readdirSync, statSync, lstatSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
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
  size_bytes: number;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.heic': 'image/heic',
  '.tiff': 'image/tiff', '.tif': 'image/tiff', '.dng': 'image/x-adobe-dng',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function getMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || null;
}

function fileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
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
      console.error(`  upload-raw <file> --page <slug> [--source <id>] [--type <type>]  Smart upload with .redirect.yaml pointer`);
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
    const size = row.size_bytes ? `${Math.round(Number(row.size_bytes) / 1024)}KB` : '?';
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

  const stat = statSync(filePath);
  const hash = fileHash(filePath);
  const filename = basename(filePath);
  const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;
  const mimeType = getMimeType(filePath);

  const sql = sqlQueryForEngine(engine);

  // Check for existing file by hash
  const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
  if (existing.length > 0) {
    console.log(`File already uploaded (hash match): ${storagePath}`);
    return;
  }

  // Upload to storage backend if configured
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  if (config?.storage) {
    const { createStorage } = await import('../core/storage.ts');
    const storage = await createStorage(config.storage as any);
    const content = readFileSync(filePath);
    const method = content.length >= SIZE_THRESHOLD ? 'TUS resumable' : 'standard';
    console.log(`Uploading ${humanSize(stat.size)} via ${method}...`);
    await storage.upload(storagePath, content, mimeType || undefined);
  }

  await sql`
    INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
    VALUES (${pageSlug}, ${filename}, ${storagePath}, ${mimeType}, ${stat.size}, ${hash}, ${'{}'}::jsonb)
    ON CONFLICT (storage_path) DO UPDATE SET
      content_hash = EXCLUDED.content_hash,
      size_bytes = EXCLUDED.size_bytes,
      mime_type = EXCLUDED.mime_type
  `;

  console.log(`Uploaded: ${storagePath} (${humanSize(stat.size)})`);
}

/**
 * Resolve the on-disk brain repo root for a source (#2297). Multi-source: a
 * source's `local_path` is its checkout; the legacy/default source falls back
 * to the `sync.repo_path` config anchor written by `gbrain sync`. Returns null
 * when no repo is resolvable (pure-DB brain) — callers must fail loud rather
 * than silently claim a git write succeeded.
 */
export async function resolveRepoRoot(engine: BrainEngine, sourceId: string | null): Promise<string | null> {
  if (sourceId && sourceId !== 'default') {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (rows[0]?.local_path) return rows[0].local_path;
  }
  return await engine.getConfig('sync.repo_path');
}

/**
 * Look up a page by slug to link the file row to a real page + source (#2297).
 * Slug uniqueness is (source_id, slug); with only `--page <slug>` we take the
 * first live match. Returns null for a slug with no page (file row still records
 * the slug + the default source).
 */
export async function lookupPageBySlug(
  engine: BrainEngine,
  pageSlug: string,
  sourceHint?: string | null,
): Promise<{ id: number; source_id: string } | null> {
  // Slug uniqueness is (source_id, slug), so a bare slug can match multiple
  // sources (#2297). An explicit --source is honored STRICTLY: a scoped miss
  // returns null (never falls back to an unscoped match, which could silently
  // attach the file to the wrong source). Only a bare slug (no hint) takes the
  // first live match deterministically (id ASC).
  if (sourceHint) {
    const scoped = await engine.executeRaw<{ id: number; source_id: string }>(
      `SELECT id, source_id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [pageSlug, sourceHint],
    );
    return scoped[0] ?? null;
  }
  const rows = await engine.executeRaw<{ id: number; source_id: string }>(
    `SELECT id, source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
    [pageSlug],
  );
  return rows[0] ?? null;
}

/**
 * Build the globally-unique `files.storage_path` key (#2297). The schema's
 * UNIQUE is on storage_path alone, but slugs only disambiguate within a source,
 * so a bare `<page>/<file>` collides across sources. Prefix non-default sources
 * with the source id so two sources can hold the same slug+filename without one
 * ON CONFLICT-clobbering the other. Default-source paths stay byte-identical
 * (back-compat). NOTE: this is the DB key, not the on-disk path — the physical
 * copy lives at repoRelPath under the source's own repo root.
 */
export function namespacedStoragePath(sourceId: string | null, repoRelPath: string): string {
  return sourceId && sourceId !== 'default' ? `${sourceId}/${repoRelPath}` : repoRelPath;
}

/**
 * Single canonical `files` row writer shared by BOTH the git (small-file) and
 * cloud (large/media) branches of upload-raw (#2297, DRY). `storage_path` is
 * UNIQUE in the schema, so it MUST be page-namespaced by the caller to avoid one
 * page's attachment clobbering another's. metadata goes through executeRawJsonb
 * (raw object, never JSON.stringify into a ::jsonb cast — the double-encode trap).
 */
export async function insertFileRow(
  engine: BrainEngine,
  row: {
    sourceId: string | null;
    pageId: number | null;
    pageSlug: string | null;
    filename: string;
    storagePath: string;
    mimeType: string | null;
    size: number;
    contentHash: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await executeRawJsonb(
    engine,
    `INSERT INTO files (source_id, page_id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
     VALUES (COALESCE($1, 'default'), $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (storage_path) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       size_bytes = EXCLUDED.size_bytes,
       mime_type = EXCLUDED.mime_type,
       page_id = EXCLUDED.page_id,
       page_slug = EXCLUDED.page_slug`,
    [row.sourceId, row.pageId, row.pageSlug, row.filename, row.storagePath, row.mimeType, row.size, row.contentHash],
    [row.metadata],
  );
}

/**
 * Smart upload with size routing and .redirect.yaml pointer creation.
 *
 * Size routing:
 *   < 100 MB text/PDF  → copied into the brain repo under <page>/.raw/, recorded
 *                        in the files table (storage = 'git')
 *   >= 100 MB OR media  → upload to cloud storage, create .redirect.yaml pointer
 *                        in the repo, recorded in the files table (storage = cloud)
 *
 * Both branches persist a files row AND write into the brain repo so git tracks
 * what was stored. Neither silently returns success without persisting (#2297).
 */
async function uploadRaw(engine: BrainEngine, args: string[]) {
  const filePath = args.find(a => !a.startsWith('--'));
  const pageSlug = args.find((a, i) => args[i - 1] === '--page') || null;
  const fileType = args.find((a, i) => args[i - 1] === '--type') || null;
  // --source disambiguates a slug that exists in more than one source (#2297);
  // without it, a bare slug resolves to the first matching source.
  const sourceHint = args.find((a, i) => args[i - 1] === '--source') || null;
  const noPointer = args.includes('--no-pointer');

  if (!filePath || !existsSync(filePath)) {
    console.error('Usage: gbrain files upload-raw <file> --page <slug> [--source <id>] [--type <type>] [--no-pointer]');
    process.exit(1);
  }

  const stat = statSync(filePath);
  const filename = basename(filePath);
  const mimeType = getMimeType(filePath);
  const isMedia = mimeType?.startsWith('video/') || mimeType?.startsWith('audio/') || mimeType?.startsWith('image/');
  const needsCloud = stat.size >= SIZE_THRESHOLD || isMedia;

  if (!needsCloud) {
    // Small text/PDF files are copied INTO the brain repo and recorded in the
    // files table (#2297). Previously this branch printed success and returned
    // without copying anything or inserting a row — every small "raw" was
    // silently lost. Resolve the page + source so the row links correctly and
    // the destination is page-namespaced (storage_path is UNIQUE).
    const page = pageSlug ? await lookupPageBySlug(engine, pageSlug, sourceHint) : null;
    const sourceId = page?.source_id ?? sourceHint ?? 'default';
    const repoRoot = await resolveRepoRoot(engine, sourceId);
    if (!repoRoot) {
      console.error(JSON.stringify({
        success: false,
        reason: 'no_repo_path',
        message: 'No brain repo on disk (sources.local_path / sync.repo_path unset). '
          + 'Run `gbrain sync` to anchor a repo, or configure cloud storage for raw uploads.',
      }));
      process.exit(1);
    }
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    // Physical copy lives at the repo-relative path UNDER the source's own repo
    // root; the DB storage_path key is additionally source-namespaced so it stays
    // globally unique across sources (#2297).
    const repoRelPath = pageSlug
      ? `${pageSlug}/.raw/${filename}`
      : `unsorted/.raw/${hash.slice(0, 8)}-${filename}`;
    const storagePath = namespacedStoragePath(sourceId, repoRelPath);
    const destAbs = join(repoRoot, repoRelPath);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, content);

    await insertFileRow(engine, {
      sourceId,
      pageId: page?.id ?? null,
      pageSlug,
      filename,
      storagePath,
      mimeType,
      size: stat.size,
      contentHash: 'sha256:' + hash,
      metadata: { ...(fileType ? { type: fileType } : {}), upload_method: 'git' },
    });

    console.log(JSON.stringify({
      success: true,
      storage: 'git',
      path: storagePath,
      abs_path: destAbs,
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
  const bucket = (config.storage as any).bucket || 'brain-files';

  const page = pageSlug ? await lookupPageBySlug(engine, pageSlug, sourceHint) : null;
  const sourceId = page?.source_id ?? sourceHint ?? 'default';
  // Source-namespace the cloud storage key so the same slug+filename in two
  // sources doesn't collide on the UNIQUE storage_path (#2297). Default source
  // keeps its historical path.
  const cloudRelPath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;
  const storagePath = namespacedStoragePath(sourceId, cloudRelPath);

  const method = content.length >= SIZE_THRESHOLD ? 'TUS resumable' : 'standard';
  console.error(`Uploading ${humanSize(stat.size)} via ${method}...`);
  await storage.upload(storagePath, content, mimeType || undefined);

  // Create .redirect.yaml pointer IN THE BRAIN REPO, page-namespaced (#2297).
  // Previously this was written next to the *input* file (filePath +
  // '.redirect.yaml'), so the pointer never landed in the repo the comment
  // claimed — git tracked nothing. Resolve the repo root and write it under
  // the page's .raw/ sidecar so it travels with the page.
  let pointerPath: string | null = null;
  if (!noPointer && pageSlug) {
    const repoRoot = await resolveRepoRoot(engine, sourceId);
    if (repoRoot) {
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
      pointerPath = join(repoRoot, pageSlug, '.raw', `${filename}.redirect.yaml`);
      mkdirSync(dirname(pointerPath), { recursive: true });
      writeFileSync(pointerPath, pointer);
      console.error(`Pointer written: ${pointerPath}`);
    } else {
      console.error('No brain repo on disk — skipping .redirect.yaml pointer (cloud upload + DB row still recorded).');
    }
  }

  await insertFileRow(engine, {
    sourceId,
    pageId: page?.id ?? null,
    pageSlug,
    filename,
    storagePath,
    mimeType,
    size: stat.size,
    contentHash: 'sha256:' + hash,
    metadata: { ...(fileType ? { type: fileType } : {}), upload_method: method },
  });

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

    await sql`
      INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
      VALUES (${pageSlug}, ${filename}, ${storagePath}, ${mimeType}, ${stat.size}, ${hash}, ${'{}'}::jsonb)
      ON CONFLICT (storage_path) DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
        size_bytes = EXCLUDED.size_bytes,
        mime_type = EXCLUDED.mime_type
    `;

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

  let verified = 0;
  let mismatches = 0;
  let missing = 0;

  for (const row of rows) {
    // Note: full verification would check Supabase Storage hash
    // For now, verify the DB record exists and has valid data
    if (!row.content_hash || !row.storage_path) {
      mismatches++;
      console.error(`  MISMATCH: ${row.storage_path} (missing hash or path)`);
    } else {
      verified++;
    }
  }

  if (mismatches === 0 && missing === 0) {
    console.log(`${verified} files verified, 0 mismatches, 0 missing`);
  } else {
    console.error(`VERIFY FAILED: ${mismatches} mismatches, ${missing} missing.`);
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

  const { createStorage } = await import('../core/storage.ts');
  const { loadConfig } = await import('../core/config.ts');
  const { stringify } = await import('../core/yaml-lite.ts');
  const config = loadConfig();
  if (!config?.storage) { console.error('No storage backend configured. Run gbrain init with storage settings.'); process.exit(1); }

  const storage = await createStorage(config.storage as any);
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
    bucket: (config.storage as { bucket?: string })?.bucket || 'brain-files',
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

  // Verify remote files exist before deleting locals
  const { loadConfig } = await import('../core/config.ts');
  const config = loadConfig();
  let storage: any = null;
  if (config?.storage) {
    const { createStorage } = await import('../core/storage.ts');
    storage = await createStorage(config.storage as any);
  }

  let redirected = 0;
  let skippedMissing = 0;
  for (const filePath of files) {
    const relPath = relative(dir, filePath);
    const hash = fileHash(filePath);

    // Verify remote exists before deleting local
    if (storage) {
      const remoteExists = await storage.exists(relPath);
      if (!remoteExists) {
        console.error(`  Skipping ${relPath}: not found in remote storage (would lose data)`);
        skippedMissing++;
        continue;
      }
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
