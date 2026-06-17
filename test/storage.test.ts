import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalStorage } from '../src/core/storage/local.ts';
import { createStorage } from '../src/core/storage.ts';

describe('LocalStorage', () => {
  let storage: LocalStorage;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-storage-test-'));
    storage = new LocalStorage(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test('upload creates file', async () => {
    await storage.upload('test/file.txt', Buffer.from('hello'));
    expect(existsSync(join(tmpDir, 'test/file.txt'))).toBe(true);
  });

  test('download returns uploaded data', async () => {
    await storage.upload('test/roundtrip.bin', Buffer.from('binary data'));
    const data = await storage.download('test/roundtrip.bin');
    expect(data.toString()).toBe('binary data');
  });

  test('download throws for missing file', async () => {
    expect(storage.download('nonexistent.txt')).rejects.toThrow('not found');
  });

  test('exists returns true for uploaded file', async () => {
    await storage.upload('test/exists.txt', Buffer.from('x'));
    expect(await storage.exists('test/exists.txt')).toBe(true);
  });

  test('exists returns false for missing file', async () => {
    expect(await storage.exists('nope.txt')).toBe(false);
  });

  test('delete removes file', async () => {
    await storage.upload('test/deleteme.txt', Buffer.from('x'));
    await storage.delete('test/deleteme.txt');
    expect(await storage.exists('test/deleteme.txt')).toBe(false);
  });

  test('delete is idempotent (missing file is ok)', async () => {
    await storage.delete('already-gone.txt');
    // No throw
  });

  test('list returns uploaded files', async () => {
    await storage.upload('listdir/a.txt', Buffer.from('a'));
    await storage.upload('listdir/b.txt', Buffer.from('b'));
    await storage.upload('listdir/sub/c.txt', Buffer.from('c'));
    const files = await storage.list('listdir');
    expect(files.length).toBe(3);
    expect(files).toContain('listdir/a.txt');
    expect(files).toContain('listdir/b.txt');
    expect(files).toContain('listdir/sub/c.txt');
  });

  test('list returns empty for missing prefix', async () => {
    const files = await storage.list('nonexistent-prefix');
    expect(files.length).toBe(0);
  });

  test('getUrl returns file:// URL', async () => {
    const url = await storage.getUrl('test/file.txt');
    expect(url.startsWith('file://')).toBe(true);
  });
});

// --- Path traversal containment ---

describe('LocalStorage path traversal', () => {
  test('blocks upload path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.upload('../../etc/evil', Buffer.from('pwned'))).rejects.toThrow('Path traversal blocked');
      await expect(storage.upload('../sibling/file', Buffer.from('x'))).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks download path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.download('../../etc/passwd')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks delete path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.delete('../../../tmp/important')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks list path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.list('../../etc')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks getUrl path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.getUrl('../../etc/passwd')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('allows legitimate nested paths', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await storage.upload('pages/people/elon/avatar.png', Buffer.from('img'));
      const data = await storage.download('pages/people/elon/avatar.png');
      expect(data.toString()).toBe('img');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('createStorage', () => {
  test('creates LocalStorage for backend: local', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-factory-test-'));
    try {
      const storage = await createStorage({ backend: 'local', bucket: 'test', localPath: tmpDir });
      await storage.upload('test.txt', Buffer.from('hello'));
      expect(await storage.exists('test.txt')).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('throws for unknown backend', async () => {
    expect(createStorage({ backend: 'unknown' as any, bucket: 'test' })).rejects.toThrow('Unknown storage backend');
  });

  test('S3Storage requires credentials', async () => {
    expect(createStorage({ backend: 's3', bucket: 'test' })).rejects.toThrow('accessKeyId');
  });

  test('SupabaseStorage requires projectUrl', async () => {
    expect(createStorage({ backend: 'supabase', bucket: 'test' })).rejects.toThrow('projectUrl');
  });
});
