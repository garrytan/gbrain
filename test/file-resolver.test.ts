import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveFile, parseRedirect, parseMarker } from '../src/core/file-resolver.ts';
import { LocalStorage } from '../src/core/storage/local.ts';

describe('file-resolver', () => {
  let brainRoot: string;
  let storageDir: string;
  let storage: LocalStorage;

  beforeAll(() => {
    brainRoot = mkdtempSync(join(tmpdir(), 'gbrain-resolver-'));
    storageDir = mkdtempSync(join(tmpdir(), 'gbrain-resolver-storage-'));
    storage = new LocalStorage(storageDir);

    // Create a local file
    mkdirSync(join(brainRoot, 'people'), { recursive: true });
    writeFileSync(join(brainRoot, 'people/sarah.json'), '{"name":"Sarah"}');
  });

  afterAll(() => {
    rmSync(brainRoot, { recursive: true });
    rmSync(storageDir, { recursive: true });
  });

  test('resolves local file', async () => {
    const result = await resolveFile('people/sarah.json', brainRoot);
    expect(result.source).toBe('local');
    expect(result.data.toString()).toBe('{"name":"Sarah"}');
  });

  test('throws for missing file with no redirect or marker', async () => {
    expect(resolveFile('nonexistent.json', brainRoot)).rejects.toThrow('not found');
  });

  test('resolves via .redirect breadcrumb', async () => {
    // Upload to storage
    await storage.upload('redirected/file.json', Buffer.from('{"from":"storage"}'));

    // Create redirect breadcrumb
    writeFileSync(join(brainRoot, 'people/redirected.json.redirect'),
      'moved_to: supabase\nbucket: brain-files\npath: redirected/file.json\nmoved_at: 2026-04-09\noriginal_hash: sha256:abc\n'
    );

    const result = await resolveFile('people/redirected.json', brainRoot, storage);
    expect(result.source).toBe('redirect');
    expect(result.data.toString()).toBe('{"from":"storage"}');
  });

  test('throws when redirect exists but no storage backend', async () => {
    writeFileSync(join(brainRoot, 'people/no-storage.json.redirect'),
      'moved_to: supabase\nbucket: test\npath: test.json\nmoved_at: 2026-04-09\noriginal_hash: sha256:abc\n'
    );

    expect(resolveFile('people/no-storage.json', brainRoot)).rejects.toThrow('no storage backend');
  });

  test('blocks resolveFile path traversal at root level', async () => {
    await expect(
      resolveFile('../../etc/passwd', brainRoot, storage)
    ).rejects.toThrow('Path traversal blocked');
  });

  test('blocks .supabase marker with traversal prefix', async () => {
    const subDir = join(brainRoot, 'poisoned');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, '.supabase'),
      'synced_at: 2026-04-12\nbucket: brain-files\nprefix: ../../etc/\nfile_count: 1\n'
    );
    await expect(
      resolveFile('poisoned/secret.json', brainRoot, storage)
    ).rejects.toThrow('marker prefix contains path traversal');
  });

  test('blocks .supabase marker with absolute path prefix', async () => {
    const subDir = join(brainRoot, 'abs');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, '.supabase'),
      'synced_at: 2026-04-12\nbucket: brain-files\nprefix: /etc/\nfile_count: 1\n'
    );
    await expect(
      resolveFile('abs/passwd', brainRoot, storage)
    ).rejects.toThrow('marker prefix contains path traversal');
  });

  test('allows .supabase marker with clean prefix', async () => {
    const subDir = join(brainRoot, 'media');
    mkdirSync(subDir, { recursive: true });
    await storage.upload('media/.raw/photo.jpg', Buffer.from('jpeg-data'));
    writeFileSync(join(subDir, '.supabase'),
      'synced_at: 2026-04-12\nbucket: brain-files\nprefix: media/.raw/\nfile_count: 1\n'
    );
    const result = await resolveFile('media/photo.jpg', brainRoot, storage);
    expect(result.source).toBe('storage');
    expect(result.data.toString()).toBe('jpeg-data');
  });
});

describe('parseRedirect', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-redirect-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test('parses redirect YAML', () => {
    const path = join(tmpDir, 'test.redirect');
    writeFileSync(path, 'moved_to: supabase\nbucket: brain-files\npath: people/sarah.json\nmoved_at: 2026-04-09\noriginal_hash: sha256:abc123\n');

    const info = parseRedirect(path);
    expect(info.moved_to).toBe('supabase');
    expect(info.bucket).toBe('brain-files');
    expect(info.path).toBe('people/sarah.json');
    expect(info.original_hash).toBe('sha256:abc123');
  });
});

describe('parseMarker', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-marker-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test('parses .supabase marker YAML', () => {
    const path = join(tmpDir, '.supabase');
    writeFileSync(path, 'synced_at: 2026-04-09T14:58:00Z\nbucket: brain-files\nprefix: people/.raw/\nfile_count: 484\n');

    const info = parseMarker(path);
    expect(info.synced_at).toBe('2026-04-09T14:58:00Z');
    expect(info.bucket).toBe('brain-files');
    expect(info.prefix).toBe('people/.raw/');
    expect(info.file_count as any).toBe('484');
  });
});
