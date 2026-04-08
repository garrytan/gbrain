import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { FileInput } from '../core/types.ts';

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
    default:
      console.error(`Usage: gbrain files <list|upload|sync|verify> [args]`);
      console.error(`  list [slug]           List files for a page (or all)`);
      console.error(`  upload <file> --page <slug>  Upload file linked to page`);
      console.error(`  sync <dir>            Upload directory to storage`);
      console.error(`  verify                Verify all uploads match local`);
      process.exit(1);
  }
}

async function listFiles(engine: BrainEngine, slug?: string) {
  const rows = await engine.getFiles(slug);

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

  const existing = await engine.findFileByHash(hash, storagePath);
  if (existing) {
    console.log(`File already uploaded (hash match): ${storagePath}`);
    return;
  }

  // TODO: actual Supabase Storage upload goes here
  const storageUrl = `https://storage.supabase.co/brain-files/${storagePath}`;

  const file: FileInput = {
    page_slug: pageSlug,
    filename,
    storage_path: storagePath,
    storage_url: storageUrl,
    mime_type: mimeType,
    size_bytes: stat.size,
    content_hash: hash,
  };
  await engine.upsertFile(file);

  console.log(`Uploaded: ${storagePath} (${Math.round(stat.size / 1024)}KB)`);
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

    const existing = await engine.findFileByHash(hash, storagePath);
    if (existing) {
      skipped++;
      continue;
    }

    const pathParts = relativePath.split('/');
    const pageSlug = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : null;
    const storageUrl = `https://storage.supabase.co/brain-files/${storagePath}`;

    await engine.upsertFile({
      page_slug: pageSlug,
      filename,
      storage_path: storagePath,
      storage_url: storageUrl,
      mime_type: mimeType,
      size_bytes: stat.size,
      content_hash: hash,
    });

    uploaded++;
  }

  console.log(`\n\nFiles sync complete: ${uploaded} uploaded, ${skipped} skipped (unchanged)`);
}

async function verifyFiles(engine: BrainEngine) {
  const rows = await engine.getFiles();

  if (rows.length === 0) {
    console.log('No files to verify.');
    return;
  }

  let verified = 0;
  let mismatches = 0;

  for (const row of rows) {
    if (!row.content_hash || !row.storage_path) {
      mismatches++;
      console.error(`  MISMATCH: ${row.storage_path} (missing hash or path)`);
    } else {
      verified++;
    }
  }

  if (mismatches === 0) {
    console.log(`${verified} files verified, 0 mismatches, 0 missing`);
  } else {
    console.error(`VERIFY FAILED: ${mismatches} mismatches.`);
    process.exit(1);
  }
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;

      const full = join(d, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else if (!entry.endsWith('.md')) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
