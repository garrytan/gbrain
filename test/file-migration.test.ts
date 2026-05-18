import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalStorage } from '../src/core/storage/local.ts';
import { resolveFile } from '../src/core/file-resolver.ts';
import { parse, stringify } from '../src/core/yaml-lite.ts';
import { createHash } from 'crypto';

describe('file migration lifecycle', () => {
  let brainDir: string;
  let storageDir: string;
  let storage: LocalStorage;

  beforeAll(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'gbrain-migration-'));
    storageDir = mkdtempSync(join(tmpdir(), 'gbrain-migration-storage-'));
    storage = new LocalStorage(storageDir);

    // Create test files
    mkdirSync(join(brainDir, 'raw'), { recursive: true });
    writeFileSync(join(brainDir, 'raw/photo.jpg'), 'fake jpg data');
    writeFileSync(join(brainDir, 'raw/doc.pdf'), 'fake pdf data');
    writeFileSync(join(brainDir, 'notes.md'), '# Notes\nMarkdown file');
  });

  afterAll(() => {
    rmSync(brainDir, { recursive: true });
    rmSync(storageDir, { recursive: true });
  });

  test('LOCAL state: file resolver returns local file', async () => {
    const result = await resolveFile('raw/photo.jpg', brainDir);
    expect(result.source).toBe('local');
    expect(result.data.toString()).toBe('fake jpg data');
  });

  test('MIRROR: upload to storage + create marker', async () => {
    // Upload files
    const files = ['raw/photo.jpg', 'raw/doc.pdf'];
    for (const f of files) {
      const data = readFileSync(join(brainDir, f));
      await storage.upload(f, data);
    }

    // Create marker
    const marker = stringify({
      synced_at: new Date().toISOString(),
      bucket: 'test',
      prefix: 'raw/',
      file_count: 2,
    });
    writeFileSync(join(brainDir, 'raw', '.supabase'), marker);

    // Verify marker exists
    expect(existsSync(join(brainDir, 'raw', '.supabase'))).toBe(true);
    const parsed = parse(readFileSync(join(brainDir, 'raw', '.supabase'), 'utf-8'));
    expect(parsed.file_count).toBe('2');

    // Local file still exists
    expect(existsSync(join(brainDir, 'raw/photo.jpg'))).toBe(true);

    // Storage has the copy
    expect(await storage.exists('raw/photo.jpg')).toBe(true);
  });

  test('UNMIRROR: delete marker, files remain everywhere', async () => {
    // Remove marker
    const markerPath = join(brainDir, 'raw', '.supabase');
    if (existsSync(markerPath)) {
      rmSync(markerPath);
    }

    expect(existsSync(markerPath)).toBe(false);
    // Local still exists
    expect(existsSync(join(brainDir, 'raw/photo.jpg'))).toBe(true);
    // Storage still has it
    expect(await storage.exists('raw/photo.jpg')).toBe(true);
  });

  test('REDIRECT: replace files with breadcrumbs', async () => {
    // Re-create marker first (redirect requires prior mirror)
    writeFileSync(join(brainDir, 'raw', '.supabase'), stringify({
      synced_at: new Date().toISOString(), bucket: 'test', prefix: 'raw/', file_count: 2,
    }));

    // Create redirect breadcrumbs
    for (const f of ['raw/photo.jpg', 'raw/doc.pdf']) {
      const fullPath = join(brainDir, f);
      const hash = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
      const breadcrumb = stringify({
        moved_to: 'storage', bucket: 'test', path: f,
        moved_at: '2026-04-09', original_hash: `sha256:${hash}`,
      });
      writeFileSync(fullPath + '.redirect', breadcrumb);
      rmSync(fullPath); // delete original
    }

    // Original gone
    expect(existsSync(join(brainDir, 'raw/photo.jpg'))).toBe(false);
    // Breadcrumb exists
    expect(existsSync(join(brainDir, 'raw/photo.jpg.redirect'))).toBe(true);

    // Resolver fetches from storage via redirect
    const result = await resolveFile('raw/photo.jpg', brainDir, storage);
    expect(result.source).toBe('redirect');
    expect(result.data.toString()).toBe('fake jpg data');
  });

  test('RESTORE: download from storage, recreate originals', async () => {
    // Restore photo
    const redirectPath = join(brainDir, 'raw/photo.jpg.redirect');
    const info = parse(readFileSync(redirectPath, 'utf-8'));
    const data = await storage.download(info.path);
    writeFileSync(join(brainDir, 'raw/photo.jpg'), data);
    rmSync(redirectPath);

    // Original restored
    expect(existsSync(join(brainDir, 'raw/photo.jpg'))).toBe(true);
    expect(readFileSync(join(brainDir, 'raw/photo.jpg'), 'utf-8')).toBe('fake jpg data');
    // Breadcrumb gone
    expect(existsSync(redirectPath)).toBe(false);
  });

  test('CLEAN: delete remaining redirect breadcrumbs', async () => {
    // doc.pdf still has a redirect
    expect(existsSync(join(brainDir, 'raw/doc.pdf.redirect'))).toBe(true);
    rmSync(join(brainDir, 'raw/doc.pdf.redirect'));
    expect(existsSync(join(brainDir, 'raw/doc.pdf.redirect'))).toBe(false);
  });

  test('edge: markdown files are never mirrored', () => {
    // Markdown files should be left alone by the migration process
    expect(existsSync(join(brainDir, 'notes.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'notes.md.redirect'))).toBe(false);
  });
});
