/**
 * An image imported without its visual vector or OCR text is retried.
 *
 * The image hash-skip used to key on the byte hash alone, so an image first
 * imported under --no-embed, an OCR budget skip, or an OCR provider error kept
 * filename-only text and no visual vector until its bytes changed. The skip
 * now also requires the index to be complete for what this run would build,
 * and the page records its repo-relative source_path on every path.
 *
 * PGLite in-memory; the Voyage provider is a fetch stub ($0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let engine: PGLiteEngine;
let embedCalls = 0;
const origFetch = globalThis.fetch;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

beforeEach(() => {
  globalThis.fetch = (async () => {
    embedCalls++;
    return new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }], model: 'voyage-multimodal-3',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const configureVoyage = () => configureGateway({
  embedding_model: 'voyage:voyage-multimodal-3',
  embedding_multimodal_model: 'voyage:voyage-multimodal-3',
  embedding_dimensions: 1024,
  env: { VOYAGE_API_KEY: 'test-key' },
});

const imageRow = (slug: string) => engine.executeRaw<{ source_path: string | null; has_vec: boolean }>(
  `SELECT p.source_path, c.embedding_image IS NOT NULL AS has_vec
     FROM pages p JOIN content_chunks c ON c.page_id = p.id WHERE p.slug = $1`, [slug]);

describe('image index retry', () => {
  test('an image first imported without a visual vector gets one on the next import, then skips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-retry-'));
    mkdirSync(join(dir, 'photos'));
    writeFileSync(join(dir, 'photos/whiteboard.png'), PNG);
    const file = join(dir, 'photos/whiteboard.png');

    const first = await importImageFile(engine, file, 'photos/whiteboard.png', { noEmbed: true });
    expect(first.status).toBe('imported');
    expect((await imageRow('photos/whiteboard.png'))[0]).toEqual({ source_path: 'photos/whiteboard.png', has_vec: false });

    configureVoyage();
    embedCalls = 0;
    const second = await importImageFile(engine, file, 'photos/whiteboard.png', {});
    expect(second.status).toBe('imported');
    expect(embedCalls).toBe(1);
    expect((await imageRow('photos/whiteboard.png'))[0].has_vec).toBe(true);

    const third = await importImageFile(engine, file, 'photos/whiteboard.png', {});
    expect(third.status).toBe('skipped');
    expect(embedCalls).toBe(1);
  });

  test('a --no-embed re-import of an unchanged image still skips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-noembed-'));
    writeFileSync(join(dir, 'chart.png'), PNG);
    await importImageFile(engine, join(dir, 'chart.png'), 'chart.png', { noEmbed: true });
    const again = await importImageFile(engine, join(dir, 'chart.png'), 'chart.png', { noEmbed: true });
    expect(again.status).toBe('skipped');
  });
});
