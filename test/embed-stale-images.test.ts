/**
 * `gbrain embed --stale --images` rebuilds image pages whose index is
 * incomplete (no visual vector, or no OCR text while OCR is enabled) from
 * their source files, without `sync --full`. Complete images are not
 * candidates and cost no provider call; a vanished source file is reported.
 *
 * PGLite in-memory; the Voyage provider is a fetch stub ($0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { embedStaleImages } from '../src/core/embed-stale-images.ts';
import { runSources } from '../src/commands/sources.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { runEmbed } from '../src/commands/embed.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let engine: PGLiteEngine;
let embedCalls = 0;
let dir: string;
const origFetch = globalThis.fetch;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'img-sweep-'));
  mkdirSync(join(dir, 'photos'));
  await runSources(engine, ['add', 'img', '--path', dir, '--no-federated', '--force']);
}, 60_000);

beforeEach(() => {
  embedCalls = 0;
  globalThis.fetch = (async () => {
    embedCalls++;
    return new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }], model: 'voyage-multimodal-3',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  configureGateway({
    embedding_model: 'voyage:voyage-multimodal-3',
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    embedding_dimensions: 1024,
    env: { VOYAGE_API_KEY: 'test-key' },
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const hasVector = async (slug: string) => (await engine.executeRaw<{ has_vec: boolean }>(
  `SELECT c.embedding_image IS NOT NULL AS has_vec FROM pages p JOIN content_chunks c ON c.page_id = p.id
    WHERE p.source_id = 'img' AND p.slug = $1`, [slug]))[0]?.has_vec;

describe('embed --stale --images', () => {
  test('rebuilds a vectorless image from its file, then finds nothing to do', async () => {
    writeFileSync(join(dir, 'photos/whiteboard.png'), PNG);
    await importImageFile(engine, join(dir, 'photos/whiteboard.png'), 'photos/whiteboard.png', { noEmbed: true, sourceId: 'img' });
    expect(await hasVector('photos/whiteboard.png')).toBe(false);

    const preview = await embedStaleImages(engine, { sourceId: 'img', dryRun: true });
    expect(preview.candidates).toBe(1);
    expect(embedCalls).toBe(0);

    const swept = await embedStaleImages(engine, { sourceId: 'img', dryRun: false });
    expect(swept).toMatchObject({ candidates: 1, rebuilt: 1, missingFile: 0, failures: 0 });
    expect(embedCalls).toBe(1);
    expect(await hasVector('photos/whiteboard.png')).toBe(true);

    embedCalls = 0;
    expect((await embedStaleImages(engine, { sourceId: 'img', dryRun: false })).candidates).toBe(0);
    expect(embedCalls).toBe(0);
  }, 60_000);

  test('an image missing OCR text is a candidate only while OCR is enabled', async () => {
    writeFileSync(join(dir, 'photos/receipt.png'), PNG);
    await importImageFile(engine, join(dir, 'photos/receipt.png'), 'photos/receipt.png', { sourceId: 'img' });
    expect(await hasVector('photos/receipt.png')).toBe(true);
    expect((await embedStaleImages(engine, { sourceId: 'img', dryRun: true })).candidates).toBe(0);
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      expect((await embedStaleImages(engine, { sourceId: 'img', dryRun: true })).candidates).toBe(2);
    });
  }, 60_000);

  test('a vanished source file is reported, not silently skipped', async () => {
    writeFileSync(join(dir, 'photos/gone.png'), PNG);
    await importImageFile(engine, join(dir, 'photos/gone.png'), 'photos/gone.png', { noEmbed: true, sourceId: 'img' });
    rmSync(join(dir, 'photos/gone.png'));
    const swept = await embedStaleImages(engine, { sourceId: 'img', dryRun: false });
    expect(swept).toMatchObject({ candidates: 1, rebuilt: 0, missingFile: 1 });
  }, 60_000);

  test('the CLI runs the sweep scoped to --source', async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
        await runEmbed(engine, ['--stale', '--images', '--source', 'img', '--dry-run', '--json']);
      });
    } finally { console.log = origLog; }
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ candidates: 1, rebuilt: 0 });
  }, 60_000);
});
