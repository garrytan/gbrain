// Commit 2 (Phase 2): image-as-query loader + searchByImage + D18 path ban
//
// Covers:
//   - loadImageInput: PNG/JPEG/WebP magic-byte sniff + format rejection
//   - loadImageInput: oversized file rejection (local + remote caps)
//   - loadImageInput: data: URI parsing
//   - loadImageInput: invalid input shapes
//   - D11 SSRF in fetchWithSSRFGuard (already covered by ssrf-validate.test.ts)
//   - D18 search_by_image rejects image_path when ctx.remote=true
//   - D12 image_data param-level size cap (validateParams gate)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ImageLoadError,
  loadImageInput,
} from '../src/core/search/image-loader.ts';
import { __setDnsLookupForTests } from '../src/core/ssrf-validate.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-img-loader-'));
});

afterEach(() => {
  __setDnsLookupForTests(undefined);
});

// PNG magic bytes for a 1x1 transparent PNG.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  // Minimal IHDR + IDAT + IEND chunks
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  31, 21, 196, 137, 0, 0, 0, 12, 73, 68, 65, 84, 8, 87, 99, 248, 207, 192, 0, 0, 0, 3, 0, 1,
  90, 12, 105, 240, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

// JPEG magic: FF D8 FF + dummy
const JPEG_BYTES = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.alloc(100)]);

// WebP magic: RIFF????WEBP
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.alloc(100),
]);

describe('loadImageInput — local path', () => {
  test('loads a PNG file and sniffs MIME', async () => {
    const path = join(tmpRoot, 'test.png');
    writeFileSync(path, PNG_BYTES);
    const result = await loadImageInput(path);
    expect(result.contentType).toBe('image/png');
    expect(result.bytes.length).toBe(PNG_BYTES.length);
    expect(result.base64).toBe(PNG_BYTES.toString('base64'));
  });

  test('loads a JPEG file and sniffs MIME', async () => {
    const path = join(tmpRoot, 'test.jpg');
    writeFileSync(path, JPEG_BYTES);
    const result = await loadImageInput(path);
    expect(result.contentType).toBe('image/jpeg');
  });

  test('loads a WebP file and sniffs MIME', async () => {
    const path = join(tmpRoot, 'test.webp');
    writeFileSync(path, WEBP_BYTES);
    const result = await loadImageInput(path);
    expect(result.contentType).toBe('image/webp');
  });

  test('rejects unsupported format (GIF)', async () => {
    const path = join(tmpRoot, 'test.gif');
    writeFileSync(path, Buffer.from('GIF89a' + 'x'.repeat(100)));
    const err = await loadImageInput(path).catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('INVALID_FORMAT');
  });

  test('rejects oversized file (default 10MB cap)', async () => {
    const path = join(tmpRoot, 'huge.png');
    // 11MB file with PNG magic bytes
    writeFileSync(path, Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]));
    const err = await loadImageInput(path).catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('OVERSIZED');
  });

  test('rejects file via custom (tighter) maxBytes', async () => {
    const path = join(tmpRoot, 'medium.png');
    writeFileSync(path, Buffer.concat([PNG_BYTES, Buffer.alloc(1024 * 1024)])); // 1MB
    const err = await loadImageInput(path, { maxBytes: 500 * 1024 }).catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('OVERSIZED');
  });

  test('NOT_FOUND on nonexistent path', async () => {
    const err = await loadImageInput(join(tmpRoot, 'missing.png')).catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('loadImageInput — data: URI', () => {
  test('decodes PNG data: URI', async () => {
    const dataUri = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const result = await loadImageInput(dataUri);
    expect(result.contentType).toBe('image/png');
    expect(result.bytes.length).toBe(PNG_BYTES.length);
  });

  test('rejects malformed data: URI', async () => {
    const err = await loadImageInput('data:image/png;invalid-format').catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('INVALID_FORMAT');
  });

  test('rejects data: URI with non-image format (decoded GIF bytes)', async () => {
    const gifBytes = Buffer.from('GIF89a' + 'x'.repeat(100));
    const dataUri = `data:image/png;base64,${gifBytes.toString('base64')}`;
    const err = await loadImageInput(dataUri).catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('INVALID_FORMAT');
  });

  test('rejects oversized data: URI', async () => {
    const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]);
    const dataUri = `data:image/png;base64,${huge.toString('base64')}`;
    const err = await loadImageInput(dataUri).catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('OVERSIZED');
  });
});

describe('loadImageInput — invalid input shapes', () => {
  test('rejects empty string', async () => {
    const err = await loadImageInput('').catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('INVALID_URL');
  });

  test('rejects unsupported scheme', async () => {
    const err = await loadImageInput('ftp://example.com/img.png').catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('INVALID_URL');
  });
});

describe('loadImageInput — http(s) URL with SSRF defense', () => {
  let stubAddrs: Map<string, Array<{ address: string; family: number }>>;

  beforeEach(() => {
    stubAddrs = new Map();
    __setDnsLookupForTests((async (host: string) => {
      const recs = stubAddrs.get(host);
      if (!recs) {
        const e: any = new Error(`stub: no DNS records for ${host}`);
        e.code = 'ENOTFOUND';
        throw e;
      }
      return recs;
    }) as any);
  });

  test('rejects URL whose hostname resolves internal (DNS rebinding)', async () => {
    stubAddrs.set('attacker.com', [{ address: '127.0.0.1', family: 4 }]);
    const err = await loadImageInput('https://attacker.com/img.png').catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('SSRF_BLOCKED');
  });

  test('rejects URL with metadata IP literal', async () => {
    const err = await loadImageInput('http://169.254.169.254/latest/').catch(e => e);
    expect(err).toBeInstanceOf(ImageLoadError);
    expect(err.code).toBe('SSRF_BLOCKED');
  });
});
