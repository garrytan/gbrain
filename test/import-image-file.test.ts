// Phase 8 (D1-D3 + cherry-2 + cherry-3 + Sec5 + Eng-1C): importImageFile
// + withImportTransaction shared helper. Verifies the core ingest path on
// PGLite without a real Voyage API key (uses noEmbed=true).
//
// Real-API embedding is exercised in test/e2e/voyage-multimodal.test.ts (gated
// VOYAGE_API_KEY) and the dual-engine parity gate lands in Phase 10.

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile, isImageFilePath, pLimit, SUPPORTED_IMAGE_EXTS } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-img-test-'));
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('isImageFilePath / SUPPORTED_IMAGE_EXTS', () => {
  test('recognizes all supported extensions', () => {
    for (const ext of SUPPORTED_IMAGE_EXTS) {
      expect(isImageFilePath(`some/path/foo${ext}`)).toBe(true);
      expect(isImageFilePath(`some/path/FOO${ext.toUpperCase()}`)).toBe(true);
    }
  });

  test('rejects non-image extensions', () => {
    expect(isImageFilePath('readme.md')).toBe(false);
    expect(isImageFilePath('script.ts')).toBe(false);
    expect(isImageFilePath('image_no_ext')).toBe(false);
  });
});

describe('pLimit semaphore (Eng-1C)', () => {
  test('serializes work to the configured concurrency', async () => {
    const limit = pLimit(2);
    const order: string[] = [];
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    const tasks = [
      limit(async () => { order.push('A-start'); await sleep(20); order.push('A-end'); }),
      limit(async () => { order.push('B-start'); await sleep(20); order.push('B-end'); }),
      limit(async () => { order.push('C-start'); await sleep(5);  order.push('C-end'); }),
      limit(async () => { order.push('D-start'); await sleep(5);  order.push('D-end'); }),
    ];

    await Promise.all(tasks);

    // First two start before either finishes (concurrency=2). C/D wait.
    expect(order.indexOf('A-start')).toBeLessThan(order.indexOf('C-start'));
    expect(order.indexOf('B-start')).toBeLessThan(order.indexOf('C-start'));
    // All four eventually run.
    expect(order.filter(s => s.endsWith('-end')).length).toBe(4);
  });

  test('propagates rejections without leaving the slot held', async () => {
    const limit = pLimit(1);
    const reject = limit(async () => { throw new Error('boom'); });
    let caught: unknown;
    try { await reject; } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('boom');
    // Slot must release; the next call should run promptly.
    const ok = await limit(async () => 'ok');
    expect(ok).toBe('ok');
  });
});

describe('importImageFile happy path (noEmbed)', () => {
  test('imports a PNG fixture, creates a single image chunk + files row', async () => {
    // Copy the tiny.avif fixture as a stand-in for a generic image; the test
    // runs noEmbed:true so no decode/voyage call fires. Rename to .png so the
    // dispatcher routes correctly without needing actual decode.
    const target = join(tmpDir, 'photo.png');
    copyFileSync('test/fixtures/images/tiny.avif', target);

    const result = await importImageFile(engine, target, 'originals/photos/photo.png', { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(result.chunks).toBe(1);

    const page = await engine.getPage('originals/photos/photo.png');
    expect(page).not.toBeNull();
    expect(page!.type).toBe('image');
    expect((page!.frontmatter as Record<string, unknown>).mime_type).toBe('image/png');

    const file = await engine.getFile('default', 'originals/photos/photo.png');
    expect(file).not.toBeNull();
    expect(file!.filename).toBe('photo.png');
    expect(file!.mime_type).toBe('image/png');
    expect(file!.page_id).toBe(page!.id);

    const chunks = await engine.getChunks('originals/photos/photo.png');
    expect(chunks.length).toBe(1);
    expect((chunks[0] as { chunk_source: string }).chunk_source).toBe('image_asset');
    // chunk_text falls back to filename when OCR is off (default).
    expect(chunks[0].chunk_text).toBe('photo.png');
  });

  test('idempotent on content_hash: re-import same bytes returns skipped', async () => {
    const target = join(tmpDir, 'photo2.png');
    writeFileSync(target, Buffer.from('fake-png-bytes-stable'));

    const r1 = await importImageFile(engine, target, 'photos/photo2.png', { noEmbed: true });
    expect(r1.status).toBe('imported');
    const r2 = await importImageFile(engine, target, 'photos/photo2.png', { noEmbed: true });
    expect(r2.status).toBe('skipped');
  });

  test('refuses oversized files (>20MB)', async () => {
    const target = join(tmpDir, 'huge.png');
    // Write a 21MB file. Buffer.alloc is fast.
    writeFileSync(target, Buffer.alloc(21 * 1024 * 1024));
    const result = await importImageFile(engine, target, 'photos/huge.png', { noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(result.error).toMatch(/Image too large/);
  });
});

describe('importImageFile source_id routing (multi-source)', () => {
  // Regression for the image-import body wiring. Pre-fix, importImageFile
  // accepted opts.sourceId for typecheck but never routed page/chunk/file
  // writes to that source — they all silently landed in 'default'. Under
  // multi-source full-sync with GBRAIN_EMBEDDING_MULTIMODAL=true, that
  // recreated the same silent-misroute bug the text-path fix addressed.

  async function pageCountBySource(engine: PGLiteEngine): Promise<Record<string, number>> {
    const rows = await engine.executeRaw<{ source_id: string; n: number }>(
      `SELECT source_id, COUNT(*)::int AS n FROM pages WHERE type = 'image' GROUP BY source_id`,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.source_id] = r.n;
    return out;
  }

  test('imports image to a named source when sourceId is passed', async () => {
    // Pre-create the named source so the FK on pages.source_id is satisfied.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('img-src', 'Image Source') ON CONFLICT (id) DO NOTHING`,
    );

    const target = join(tmpDir, 'sourced-photo.png');
    copyFileSync('test/fixtures/images/tiny.avif', target);

    const result = await importImageFile(engine, target, 'photos/sourced-photo.png', {
      noEmbed: true,
      sourceId: 'img-src',
    });
    expect(result.status).toBe('imported');

    const counts = await pageCountBySource(engine);
    expect(counts['img-src']).toBe(1);
    expect(counts['default'] ?? 0).toBe(0);

    // File row also lands in img-src (FileSpec identity is (source_id, storage_path)).
    const fileInSrc = await engine.getFile('img-src', 'photos/sourced-photo.png');
    expect(fileInSrc).not.toBeNull();
    const fileInDefault = await engine.getFile('default', 'photos/sourced-photo.png');
    expect(fileInDefault).toBeNull();

    // Page is reachable in img-src, not default.
    const pageInSrc = await engine.getPage('photos/sourced-photo.png', { sourceId: 'img-src' });
    expect(pageInSrc).not.toBeNull();
    const pageInDefault = await engine.getPage('photos/sourced-photo.png', { sourceId: 'default' });
    expect(pageInDefault).toBeNull();
  });

  test('omitting sourceId still targets default (back-compat preserved)', async () => {
    const target = join(tmpDir, 'default-photo.png');
    copyFileSync('test/fixtures/images/tiny.avif', target);

    const result = await importImageFile(engine, target, 'photos/default-photo.png', { noEmbed: true });
    expect(result.status).toBe('imported');

    const counts = await pageCountBySource(engine);
    expect(counts['default']).toBe(1);
    expect(counts['img-src'] ?? 0).toBe(0);

    const file = await engine.getFile('default', 'photos/default-photo.png');
    expect(file).not.toBeNull();
  });
});
