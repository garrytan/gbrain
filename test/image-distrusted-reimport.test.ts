/**
 * An image whose OCR held a protected fence keeps `chunker_version < 0` after
 * a body write removes that fence (bodyWriteChunkVersion): the stored text no
 * longer carries the marker, but the pixels, and so the visual embedding, are
 * unchanged. Re-importing that unchanged image must not certify it from today's
 * edited body. Before this fix, a re-import with OCR disabled or out of budget
 * (the `embed --stale --images` sweep, `sync --full`) blanked the body,
 * stamped the safe-chunk fence and made the image rank in a remote caller's
 * `search_by_image`. The importer now requires a successful fresh OCR pass for
 * an unchanged distrusted image and otherwise leaves it unsealed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile, _resetOcrRunBudgetForTests } from '../src/core/import-file.ts';
import { embedStaleImages } from '../src/core/embed-stale-images.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PROTECTED_OCR = '<!--- gbrain:takes:begin -->\nSYNTHETIC_PRIVATE_IMAGE_CANARY\n<!--- gbrain:takes:end -->';
const VISUAL = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const backends = testBackends();
const origFetch = globalThis.fetch;
let ocrText = PROTECTED_OCR;
let ocrCalls = 0;
const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];

beforeAll(() => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ embedding: VISUAL, index: 0 }], model: 'voyage-multimodal-3', usage: { total_tokens: 10 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  configureGateway({
    expansion_model: 'anthropic:claude-sonnet-5-5', embedding_model: 'voyage:voyage-multimodal-3',
    embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1024,
    env: { ANTHROPIC_API_KEY: 'synthetic-test-key', VOYAGE_API_KEY: 'synthetic-test-key' },
  });
  __setGenerateTextTransportForTests((async () => {
    ocrCalls++;
    return { text: ocrText, usage: { inputTokens: 10, outputTokens: 10 } };
  }) as never);
});

afterAll(async () => {
  for (const close of closers) await close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  globalThis.fetch = origFetch;
  __setGenerateTextTransportForTests(null);
  resetGateway();
  _resetOcrRunBudgetForTests();
});

async function freshEngine(backend: string): Promise<BrainEngine> {
  if (backend === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    closers.push(pg.close);
    return pg.engine;
  }
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  closers.push(() => engine.disconnect());
  return engine;
}

async function remoteImageHits(engine: BrainEngine): Promise<string[]> {
  await engine.setConfig('search.image_query.daily_budget_usd_per_client', '5');
  const results = await operationsByName.search_by_image.handler(
    { engine, remote: true, auth: { token: 't', clientId: 'remote-client', scopes: ['read'] } } as never,
    { image_data: PNG.toString('base64') },
  ) as Array<{ slug: string }>;
  return results.map(r => r.slug);
}

/** A protected-OCR image whose body was later edited clean, as an operator or agent write would leave it. */
async function distrustedImage(engine: BrainEngine): Promise<{ file: string; slug: string }> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-image-distrust-'));
  roots.push(root);
  const slug = 'images/provenance-example.png';
  mkdirSync(join(root, 'images'), { recursive: true });
  const file = join(root, slug);
  writeFileSync(file, PNG);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [root, 'default']);
  ocrText = PROTECTED_OCR;
  _resetOcrRunBudgetForTests();
  await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
    expect((await importImageFile(engine, file, slug)).status).toBe('imported');
  });
  expect(await remoteImageHits(engine)).not.toContain(slug);
  const page = (await engine.getPage(slug))!;
  await engine.putPage(slug, { ...page, page_kind: 'image', compiled_truth: 'Public caption.' });
  const [row] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE slug = $1', [slug]);
  expect(row!.chunker_version).toBe(-1);
  return { file, slug };
}

async function sealState(engine: BrainEngine, slug: string) {
  const [row] = await engine.executeRaw<{ chunker_version: number; compiled_truth: string; sealed: boolean | null }>(
    'SELECT chunker_version, compiled_truth, text_projection_revision = knowledge_revision AS sealed FROM pages WHERE slug = $1', [slug]);
  return row!;
}

for (const backend of backends) {
  describe(`unchanged distrusted image re-import (${backend})`, () => {
    for (const mode of ['ocr-disabled', 'ocr-budget-exhausted'] as const) {
      test(`stays unsealed and out of remote image search when OCR is ${mode === 'ocr-disabled' ? 'disabled' : 'out of budget'}`, async () => {
        const engine = await freshEngine(backend);
        const { file, slug } = await distrustedImage(engine);
        const ocrBefore = ocrCalls;
        await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: mode === 'ocr-disabled' ? 'false' : 'true' }, async () => {
          if (mode === 'ocr-budget-exhausted') _resetOcrRunBudgetForTests({ images: 200 });
          const direct = await importImageFile(engine, file, slug);
          expect(direct.status).toBe('skipped');
          expect(direct.error).toContain('fresh OCR');
          const sweep = await embedStaleImages(engine, { dryRun: false });
          expect(sweep.rebuilt).toBe(0);
        });
        expect(ocrCalls).toBe(ocrBefore);
        expect(await sealState(engine, slug)).toMatchObject({ chunker_version: -1, compiled_truth: 'Public caption.' });
        expect(await remoteImageHits(engine)).not.toContain(slug);
      }, 120_000);
    }

    test('a successful fresh OCR pass attests the image again', async () => {
      const engine = await freshEngine(backend);
      const { file, slug } = await distrustedImage(engine);
      ocrText = 'Clean caption text.';
      _resetOcrRunBudgetForTests();
      await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
        expect((await importImageFile(engine, file, slug)).status).toBe('imported');
      });
      expect(await sealState(engine, slug)).toMatchObject({ compiled_truth: 'Clean caption text.', sealed: true });
      expect(await remoteImageHits(engine)).toContain(slug);
    }, 120_000);
  });
}
