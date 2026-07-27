import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, symlinkSync, mkdtempSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { extname } from 'path';
import { tmpdir } from 'os';
import { collectFiles } from '../src/commands/files.ts';
import { operationsByName } from '../src/core/operations.ts';
import * as db from '../src/core/db.ts';

const TMP = join(import.meta.dir, '.tmp-files-test');

// These functions are not exported from files.ts, so we reimplement and test
// the logic patterns to ensure correctness. If they ever get exported, switch
// to direct imports.

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.heic': 'image/heic',
  '.tiff': 'image/tiff', '.tif': 'image/tiff', '.dng': 'image/x-adobe-dng',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function getMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || null;
}

function fileHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, 'subdir'), { recursive: true });
  mkdirSync(join(TMP, '.hidden'), { recursive: true });
  writeFileSync(join(TMP, 'photo.jpg'), 'fake-jpg');
  writeFileSync(join(TMP, 'doc.pdf'), 'fake-pdf');
  writeFileSync(join(TMP, 'notes.md'), '# Markdown');
  writeFileSync(join(TMP, 'data.csv'), 'a,b,c');
  writeFileSync(join(TMP, 'subdir', 'nested.png'), 'fake-png');
  writeFileSync(join(TMP, '.hidden', 'secret.txt'), 'hidden');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('getMimeType', () => {
  test('returns correct MIME for .jpg', () => {
    expect(getMimeType('photo.jpg')).toBe('image/jpeg');
  });

  test('returns correct MIME for .jpeg', () => {
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  test('returns correct MIME for .png', () => {
    expect(getMimeType('image.png')).toBe('image/png');
  });

  test('returns correct MIME for .pdf', () => {
    expect(getMimeType('doc.pdf')).toBe('application/pdf');
  });

  test('returns correct MIME for .mp4', () => {
    expect(getMimeType('video.mp4')).toBe('video/mp4');
  });

  test('returns correct MIME for .svg', () => {
    expect(getMimeType('icon.svg')).toBe('image/svg+xml');
  });

  test('handles uppercase extensions via toLowerCase', () => {
    expect(getMimeType('PHOTO.JPG')).toBe('image/jpeg');
    expect(getMimeType('doc.PDF')).toBe('application/pdf');
  });

  test('returns null for unknown extensions', () => {
    expect(getMimeType('data.csv')).toBeNull();
    expect(getMimeType('script.ts')).toBeNull();
    expect(getMimeType('readme.md')).toBeNull();
  });

  test('returns null for files without extension', () => {
    expect(getMimeType('Makefile')).toBeNull();
  });

  test('handles .docx and .xlsx', () => {
    expect(getMimeType('report.docx')).toContain('wordprocessingml');
    expect(getMimeType('sheet.xlsx')).toContain('spreadsheetml');
  });

  test('handles .heic (iPhone photos)', () => {
    expect(getMimeType('IMG_0001.heic')).toBe('image/heic');
  });

  test('handles .dng (raw photos)', () => {
    expect(getMimeType('RAW_001.dng')).toBe('image/x-adobe-dng');
  });
});

describe('fileHash', () => {
  test('produces consistent SHA-256 hash', () => {
    const content = Buffer.from('hello world');
    const hash1 = fileHash(content);
    const hash2 = fileHash(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test('different content produces different hash', () => {
    const hash1 = fileHash(Buffer.from('hello'));
    const hash2 = fileHash(Buffer.from('world'));
    expect(hash1).not.toBe(hash2);
  });

  test('empty content produces valid hash', () => {
    const hash = fileHash(Buffer.from(''));
    expect(hash).toHaveLength(64);
  });
});

describe('collectFiles (production import)', () => {
  test('finds non-markdown files', () => {
    const files = collectFiles(TMP);
    const basenames = files.map(f => basename(f));
    expect(basenames).toContain('photo.jpg');
    expect(basenames).toContain('doc.pdf');
    expect(basenames).toContain('data.csv');
  });

  test('skips .md files', () => {
    const files = collectFiles(TMP);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(0);
  });

  test('skips hidden directories', () => {
    const files = collectFiles(TMP);
    const hiddenFiles = files.filter(f => f.includes('.hidden'));
    expect(hiddenFiles).toHaveLength(0);
  });

  test('recurses into subdirectories', () => {
    const files = collectFiles(TMP);
    const nested = files.filter(f => f.includes('subdir'));
    expect(nested.length).toBeGreaterThan(0);
  });

  test('returns sorted paths', () => {
    const files = collectFiles(TMP);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  test('collectFiles skips symlinks', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-symlink-'));
    try {
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      symlinkSync('/etc/passwd', join(tmpDir, 'evil.txt'));
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('evil.txt');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('collectFiles skips broken symlinks', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-broken-'));
    try {
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      symlinkSync('/nonexistent/path', join(tmpDir, 'broken.txt'));
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('broken.txt');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('file_list normalizes BigInt size_bytes for JSON serialization', async () => {
    // Postgres BIGINT(size_bytes) returns native BigInt under postgres.js's
    // {bigint: postgres.BigInt} type map. Both JSON.stringify (MCP) and the
    // CLI's `size_bytes / 1024` divide trip on it. Regression for the bug
    // openclaw's agent surfaced in v0.22.4.
    const fakeRows = [
      { id: 1, page_slug: 'a', filename: 'f1', storage_path: 'a/f1',
        mime_type: 'text/plain', size_bytes: 4096n, content_hash: 'h1',
        created_at: '2026-04-27' },
      { id: 2, page_slug: 'a', filename: 'f2', storage_path: 'a/f2',
        mime_type: null, size_bytes: null, content_hash: 'h2',
        created_at: '2026-04-27' },
    ];
    const fakeSql: any = (..._: unknown[]) => Promise.resolve(fakeRows);
    const spy = spyOn(db, 'getConnection').mockReturnValue(fakeSql);

    try {
      const op = operationsByName['file_list'];
      const ctx: any = { engine: null, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true };
      const result = await op.handler(ctx, {}) as Array<Record<string, unknown>>;

      expect(result.length).toBe(2);
      expect(typeof result[0].size_bytes).toBe('number');
      expect(result[0].size_bytes).toBe(4096);
      expect(result[1].size_bytes).toBeNull();
      // The exact failure mode openclaw reported.
      expect(() => JSON.stringify(result)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  test('collectFiles skips node_modules', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-nodemod-'));
    try {
      mkdirSync(join(tmpDir, 'node_modules'));
      writeFileSync(join(tmpDir, 'node_modules', 'pkg.js'), 'x');
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('pkg.js');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
