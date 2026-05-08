// v0.27.1 follow-up: CLI helper that loads + base64-encodes an image path
// for `gbrain query --image <path>`. Verifies MIME derivation, oversize
// rejection, and explicit-MIME override.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveQueryImage } from '../src/cli.ts';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-cli-img-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveQueryImage (v0.27.1 CLI helper)', () => {
  test('reads file and base64-encodes', () => {
    const path = join(tmp, 'photo.png');
    writeFileSync(path, Buffer.from('binary png bytes'));
    const out = resolveQueryImage(path);
    expect(out.path).toBe(path);
    expect(out.base64).toBe(Buffer.from('binary png bytes').toString('base64'));
    expect(out.mime).toBe('image/png');
  });

  test('derives mime from each supported extension', () => {
    const cases: Array<[string, string]> = [
      ['photo.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
      ['photo.JPEG', 'image/jpeg'],
      ['photo.gif', 'image/gif'],
      ['photo.webp', 'image/webp'],
      ['photo.heic', 'image/heic'],
      ['photo.HEIF', 'image/heif'],
      ['photo.avif', 'image/avif'],
    ];
    for (const [name, expectedMime] of cases) {
      const path = join(tmp, name);
      writeFileSync(path, Buffer.from('x'));
      const out = resolveQueryImage(path);
      expect(out.mime).toBe(expectedMime);
    }
  });

  test('falls back to image/jpeg for unknown extensions', () => {
    const path = join(tmp, 'photo.tiff');
    writeFileSync(path, Buffer.from('x'));
    const out = resolveQueryImage(path);
    expect(out.mime).toBe('image/jpeg');
  });

  test('explicit mime wins over extension-derived', () => {
    const path = join(tmp, 'photo.png');
    writeFileSync(path, Buffer.from('x'));
    const out = resolveQueryImage(path, 'image/webp');
    expect(out.mime).toBe('image/webp');
  });

  test('refuses oversized files (>20MB)', () => {
    const path = join(tmp, 'huge.png');
    writeFileSync(path, Buffer.alloc(21 * 1024 * 1024));
    expect(() => resolveQueryImage(path)).toThrow(/too large/i);
  });

  test('throws ENOENT-shaped error for missing file', () => {
    const path = join(tmp, 'missing.png');
    expect(() => resolveQueryImage(path)).toThrow();
  });
});
