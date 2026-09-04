import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalStorage } from '../src/core/storage/local.ts';
import { createStorage, LOCAL_STORAGE_ID_FILE, pageImageStorageIdentity } from '../src/core/storage.ts';

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

  test('download rejects an object larger than the caller cap before reading it', async () => {
    await storage.upload('test/oversized.bin', Buffer.alloc(32, 1));
    await expect(storage.download('test/oversized.bin', 16)).rejects.toThrow('download limit');
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

  test('blocks a symlinked parent directory for upload and download', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-storage-outside-'));
    try {
      const storage = new LocalStorage(tmpDir);
      symlinkSync(outside, join(tmpDir, 'escape'));
      await expect(storage.upload('escape/new.bin', Buffer.from('secret'))).rejects.toThrow('ancestor symlink');
      expect(existsSync(join(outside, 'new.bin'))).toBe(false);
      writeFileSync(join(outside, 'existing.bin'), Buffer.from('secret'));
      await expect(storage.download('escape/existing.bin')).rejects.toThrow('ancestor symlink');
      await expect(storage.exists('escape/existing.bin')).rejects.toThrow('ancestor symlink');
      await expect(storage.list('escape')).rejects.toThrow('ancestor symlink');
      await expect(storage.getUrl('escape/existing.bin')).rejects.toThrow('ancestor symlink');
    } finally {
      rmSync(tmpDir, { recursive: true });
      rmSync(outside, { recursive: true });
    }
  });

  test('upload replaces a final symlink without writing through it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    const outside = join(tmpDir, '..', `gbrain-storage-outside-file-${Date.now()}`);
    try {
      const storage = new LocalStorage(tmpDir);
      mkdirSync(join(tmpDir, 'safe'), { recursive: true });
      writeFileSync(outside, 'outside-original');
      symlinkSync(outside, join(tmpDir, 'safe', 'image.png'));

      await storage.upload('safe/image.png', Buffer.from('inside-object'));

      expect(readFileSync(outside, 'utf8')).toBe('outside-original');
      expect(readFileSync(join(tmpDir, 'safe', 'image.png'), 'utf8')).toBe('inside-object');
      expect(lstatSync(join(tmpDir, 'safe', 'image.png')).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  test('delete unlinks a final symlink without deleting its target', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      mkdirSync(join(tmpDir, 'safe'), { recursive: true });
      writeFileSync(join(tmpDir, 'safe', 'target.bin'), 'keep-me');
      symlinkSync(join(tmpDir, 'safe', 'target.bin'), join(tmpDir, 'safe', 'alias.bin'));

      await storage.delete('safe/alias.bin');

      expect(existsSync(join(tmpDir, 'safe', 'alias.bin'))).toBe(false);
      expect(readFileSync(join(tmpDir, 'safe', 'target.bin'), 'utf8')).toBe('keep-me');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('protects the durable identity marker through normalized aliases on every object operation', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-marker-guard-'));
    try {
      const storage = new LocalStorage(tmpDir);
      const markerPath = join(tmpDir, LOCAL_STORAGE_ID_FILE);
      const marker = readFileSync(markerPath);
      const aliases = [
        LOCAL_STORAGE_ID_FILE,
        `./${LOCAL_STORAGE_ID_FILE}`,
        `sub/../${LOCAL_STORAGE_ID_FILE}`,
        `${LOCAL_STORAGE_ID_FILE}.tmp-attacker`,
        `sub/../${LOCAL_STORAGE_ID_FILE}.tmp-attacker`,
      ];

      for (const alias of aliases) {
        await expect(storage.upload(alias, Buffer.from('corrupt'))).rejects.toThrow('reserved');
        await expect(storage.download(alias)).rejects.toThrow('reserved');
        await expect(storage.delete(alias)).rejects.toThrow('reserved');
        await expect(storage.exists(alias)).rejects.toThrow('reserved');
        await expect(storage.getUrl(alias)).rejects.toThrow('reserved');
        await expect(storage.list(alias)).rejects.toThrow('reserved');
      }

      expect(readFileSync(markerPath)).toEqual(marker);
      await storage.upload('safe/after-marker-guard.bin', Buffer.from('ok'));
      expect(await storage.download('safe/after-marker-guard.bin')).toEqual(Buffer.from('ok'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createStorage', () => {
  test('page-image identity changes with every physical backend locator', () => {
    const namespace = 'brain-prod';
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-storage-identity-'));
    try {
      const physicalA = join(tmpDir, 'physical-a');
      const physicalB = join(tmpDir, 'physical-b');
      const alias = join(tmpDir, 'active');
      mkdirSync(physicalA);
      mkdirSync(physicalB);
      symlinkSync(physicalA, alias);
      const config = { backend: 'local' as const, bucket: 'images', localPath: alias };
      const backendA = new LocalStorage(alias);
      const identityA = pageImageStorageIdentity(config, namespace, backendA);

      unlinkSync(alias);
      symlinkSync(physicalB, alias);
      const backendB = new LocalStorage(alias);
      const identityB = pageImageStorageIdentity(config, namespace, backendB);

      expect(identityA).not.toBe(identityB);
      expect(backendA.identityLocator).not.toBe(backendB.identityLocator);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    expect(pageImageStorageIdentity(
      { backend: 'supabase', bucket: 'images', projectUrl: 'https://a.supabase.co' }, namespace,
    )).not.toBe(pageImageStorageIdentity(
      { backend: 'supabase', bucket: 'images', projectUrl: 'https://b.supabase.co' }, namespace,
    ));
    expect(pageImageStorageIdentity(
      { backend: 's3', bucket: 'images', endpoint: 'https://minio-a.test', region: 'eu-west-1' }, namespace,
    )).not.toBe(pageImageStorageIdentity(
      { backend: 's3', bucket: 'images', endpoint: 'https://minio-b.test', region: 'eu-west-1' }, namespace,
    ));
    expect(pageImageStorageIdentity(
      { backend: 's3', bucket: 'images', endpoint: 'https://minio-a.test', region: 'eu-west-1' }, namespace,
    )).not.toBe(pageImageStorageIdentity(
      { backend: 's3', bucket: 'images', endpoint: 'https://minio-a.test', region: 'us-east-1' }, namespace,
    ));
  });

  test('local identity survives a same-path restore only when the durable marker is restored', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-storage-restore-'));
    const root = join(tmpDir, 'objects');
    const config = { backend: 'local' as const, bucket: 'images', localPath: root };
    const namespace = 'brain-prod';
    try {
      const original = new LocalStorage(root);
      const identity = pageImageStorageIdentity(config, namespace, original);
      const marker = readFileSync(join(root, LOCAL_STORAGE_ID_FILE));

      rmSync(root, { recursive: true });
      mkdirSync(root);
      writeFileSync(join(root, LOCAL_STORAGE_ID_FILE), marker, { mode: 0o600 });
      const restored = new LocalStorage(root);
      expect(pageImageStorageIdentity(config, namespace, restored)).toBe(identity);

      rmSync(root, { recursive: true });
      mkdirSync(root);
      const unrelatedReplacement = new LocalStorage(root);
      expect(pageImageStorageIdentity(config, namespace, unrelatedReplacement)).not.toBe(identity);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
