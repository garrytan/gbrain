import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectMimeType } from '../src/core/file-mime.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { createStorage } from '../src/core/storage.ts';
import { S3Storage } from '../src/core/storage/s3.ts';
import { SupabaseStorage } from '../src/core/storage/supabase.ts';

describe('detectMimeType', () => {
  test('prefers sniffed binary signatures over file extensions', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMimeType('photo.jpg', png)).toBe('image/png');
  });

  test('stores active SVG/HTML content as octet-stream instead of trusted renderable content', () => {
    expect(detectMimeType('icon.svg', Buffer.from('<svg><script>alert(1)</script></svg>')))
      .toBe('application/octet-stream');
    expect(detectMimeType('index.html', Buffer.from('<!doctype html><script>alert(1)</script>')))
      .toBe('application/octet-stream');
    expect(detectMimeType('icon.svg')).toBe('application/octet-stream');
  });

  test('detects common safe binary formats from content', () => {
    expect(detectMimeType('download.bin', Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectMimeType('download.bin', Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
  });
});

describe('LocalStorage', () => {
  let storage: LocalStorage;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-storage-test-'));
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

  test('getUrl returns file:// URL for a missing nested key', async () => {
    const url = await storage.getUrl('missing/nested/file.txt');
    expect(url).toContain('/missing/nested/file.txt');
    expect(url.startsWith('file://')).toBe(true);
  });
});

describe('signed storage URLs', () => {
  test('S3Storage getUrl returns a scoped presigned URL with the requested TTL', async () => {
    const storage = new S3Storage({
      backend: 's3',
      bucket: 'brain-files',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'test-secret',
    });

    const url = await storage.getUrl('pages/report.pdf', { expiresInSeconds: 60 });

    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=60');
    expect(url).toContain('/pages/report.pdf');
  });

  test('SupabaseStorage getUrl requests a signed URL instead of returning a public object URL', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        signedURL: '/object/sign/brain-files/pages/report.pdf?token=signed-token',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const storage = new SupabaseStorage({
        backend: 'supabase',
        bucket: 'brain-files',
        projectUrl: 'https://example.supabase.co',
        serviceRoleKey: 'service-role',
      });

      const url = await storage.getUrl('pages/report.pdf', { expiresInSeconds: 120 });

      expect(url).toBe('https://example.supabase.co/storage/v1/object/sign/brain-files/pages/report.pdf?token=signed-token');
      expect(calls[0].url).toBe('https://example.supabase.co/storage/v1/object/sign/brain-files/pages/report.pdf');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ expiresIn: 120 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('file_url operation delegates to configured storage backends for signed URLs', () => {
    const operationsSource = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf-8');

    expect(operationsSource).toContain('expires_in_seconds');
    expect(operationsSource).toContain('storage.getUrl(String(rows[0].storage_path), { expiresInSeconds })');
    expect(operationsSource).toContain('mbrain:files/${rows[0].storage_path}');
  });
});

describe('LocalStorage path traversal', () => {
  test('blocks upload path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.upload('../../etc/evil', Buffer.from('pwned'))).rejects.toThrow('Path traversal blocked');
      await expect(storage.upload('../sibling/file', Buffer.from('x'))).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks download path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.download('../../etc/passwd')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks delete path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.delete('../../../tmp/important')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks list path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.list('../../etc')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks getUrl path traversal via ../', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await expect(storage.getUrl('../../etc/passwd')).rejects.toThrow('Path traversal blocked');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('allows legitimate nested paths', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    try {
      const storage = new LocalStorage(tmpDir);
      await storage.upload('pages/people/elon/avatar.png', Buffer.from('img'));
      const data = await storage.download('pages/people/elon/avatar.png');
      expect(data.toString()).toBe('img');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('blocks upload through symlinked directories inside the storage root', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-outside-'));
    try {
      symlinkSync(outsideDir, join(tmpDir, 'alias'), 'dir');
      const storage = new LocalStorage(tmpDir);

      await expect(storage.upload('alias/escape.txt', Buffer.from('pwned')))
        .rejects.toThrow('Path traversal blocked');
      expect(existsSync(join(outsideDir, 'escape.txt'))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('blocks upload through symlinked file targets inside the storage root', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'mbrain-traversal-outside-'));
    const outsideFile = join(outsideDir, 'target.txt');
    try {
      writeFileSync(outsideFile, 'original', 'utf-8');
      symlinkSync(outsideFile, join(tmpDir, 'escape.txt'), 'file');
      const storage = new LocalStorage(tmpDir);

      await expect(storage.upload('escape.txt', Buffer.from('pwned')))
        .rejects.toThrow('Path traversal blocked');
      expect(readFileSync(outsideFile, 'utf-8')).toBe('original');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('createStorage', () => {
  test('creates LocalStorage for backend: local', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mbrain-factory-test-'));
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
