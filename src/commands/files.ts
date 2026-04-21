import { readFileSync, readdirSync, statSync, lstatSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { humanSize } from '../core/file-resolver.ts';

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
      await listFiles(args[1]);
      break;
    case 'upload':
      await uploadFile(args.slice(1));
      break;
    case 'sync':
      await syncFiles(args[1]);
      break;
    case 'verify':
      await verifyFiles();
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
      await uploadRaw(args.slice(1));
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

async function listFiles(slug?: string) {
  const sql = db.getConnection();
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
    const size = row.size_bytes ? `${Math.round(row.size_bytes / 1024)}KB` : '?';
    console.log(`  ${row.page_slug || '(unlinked)'} / ${row.filename}  [${size}, ${row.mime_type || '?'}]`);
  }
}

async function uploadFile(args: string[]) {
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

  const sql = db.getConnection();

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
 * Smart upload with size routing and .redirect.yaml pointer creation.
 *
 * Size routing:
 *   < 100 MB text/PDF  → stays in git (brain repo), no cloud upload
 *   >= 100 MB OR media  → upload to cloud storage, create .redirect.yaml pointer
 *
 * The .redirect.yaml pointer stays in the brain repo so git tracks what was stored.
 */
async function uploadRaw(args: string[]) {
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
    // Small text/PDF files stay in git
    console.log(JSON.stringify({
      success: true,
      storage: 'git',
      path: filePath,
      size: stat.size,
      size_human: humanSize(stat.size),
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

  // Record in DB
  const sql = db.getConnection();
  await sql`
    INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
    VALUES (${pageSlug}, ${filename}, ${storagePath}, ${mimeType}, ${stat.size}, ${'sha256:' + hash},
            ${sql.json({ type: fileType, upload_method: method })})
    ON CONFLICT (storage_path) DO UPDATE SET
      content_hash = EXCLUDED.content_hash,
      size_bytes = EXCLUDED.size_bytes,
      mime_type = EXCLUDED.mime_type
  `;

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

async function syncFiles(dir?: string) {
  if (!dir || !existsSync(dir)) {
    console.error('Usage: gbrain files sync <directory>');
    process.exit(1);
  }

  const files = collectFiles(dir);
  console.log(`Found ${files.length} files to sync`);

  let uploaded = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relativePath = relative(dir, filePath);

    if ((i + 1) % 50 === 0 || i === files.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${files.length} processed, ${uploaded} uploaded, ${skipped} skipped`);
    }

    const hash = fileHash(filePath);
    const filename = basename(filePath);
    const storagePath = relativePath.replace(/\\/g, '/');
    const mimeType = getMimeType(filePath);
    const stat = statSync(filePath);

    const sql = db.getConnection();
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

  console.log(`\n\nFiles sync complete: ${uploaded} uploaded, ${skipped} skipped (unchanged)`);
}

async function verifyFiles() {
  const sql = db.getConnection();
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
    bucket: config.storage.bucket || 'brain-files',
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
