// v0.27.1 follow-up: end-to-end smoke for `gbrain query --image <path>`.
//
// Exercises the full op-layer wiring without going through the CLI dispatch:
// seed two image pages with known 1024-dim image vectors, invoke the `query`
// op with a base64'd payload, assert the closer page wins. Mocks
// embedMultimodal so the test runs without a real Voyage key.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations as OPERATIONS } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function fakeImage1024(seed: number): Float32Array {
  const out = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) out[i] = (i + seed) / 1024;
  return out;
}

async function seedImagePage(slug: string, vec: Float32Array) {
  await engine.putPage(slug, {
    type: 'image',
    page_kind: 'image',
    title: slug,
    compiled_truth: '',
    timeline: '',
  });
  await engine.upsertChunks(slug, [
    {
      chunk_index: 0,
      chunk_text: slug,
      chunk_source: 'image_asset',
      embedding_image: vec,
      modality: 'image',
    },
  ]);
}

describe('query op with --image (v0.27.1 follow-up)', () => {
  test('returns image-similarity hits ordered by cosine', async () => {
    // Seed two image pages with distinct vectors.
    const vecA = fakeImage1024(0);
    const vecB = fakeImage1024(500);
    await seedImagePage('photos/a', vecA);
    await seedImagePage('photos/b', vecB);

    // Mock embedMultimodal so the op call doesn't try to hit Voyage.
    // Returns whatever vector the test's "query" prefix encodes — we
    // shadow the gateway by patching the imported binding via mock.module.
    const stubVec = fakeImage1024(500); // closest to 'photos/b'
    mock.module('../src/core/ai/gateway.ts', () => ({
      embedMultimodal: async () => [stubVec],
    }));

    const queryOp = OPERATIONS.find(o => o.name === 'query')!;
    const ctx = { engine, config: null, logger: console, dryRun: false, remote: false } as any;
    const results = await queryOp.handler(ctx, {
      image: Buffer.from('fake image bytes').toString('base64'),
      image_mime: 'image/jpeg',
      limit: 5,
    }) as Array<{ slug: string }>;

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].slug).toBe('photos/b');
  });

  test('refuses when neither query nor image supplied', async () => {
    const queryOp = OPERATIONS.find(o => o.name === 'query')!;
    const ctx = { engine, config: null, logger: console, dryRun: false, remote: false } as any;
    let err: unknown;
    try {
      await queryOp.handler(ctx, { limit: 5 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/query.*or.*image/i);
  });

  test('image branch ignores text-page hits (modality filter)', async () => {
    // Seed a text page AND an image page; query with --image; assert the
    // text page does NOT show up because searchVector with
    // embeddingColumn='embedding_image' applies modality='image' filter.
    await engine.putPage('notes/text', {
      type: 'note', title: 'text', compiled_truth: 'hello text', timeline: '',
    });
    // 1536-dim text embedding (matches the brain's primary embedding column).
    const textVec = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) textVec[i] = i / 1536;
    await engine.upsertChunks('notes/text', [
      {
        chunk_index: 0,
        chunk_text: 'hello text',
        chunk_source: 'compiled_truth',
        embedding: textVec,
        modality: 'text',
      },
    ]);
    const imgVec = fakeImage1024(7);
    await seedImagePage('photos/img', imgVec);

    mock.module('../src/core/ai/gateway.ts', () => ({
      embedMultimodal: async () => [imgVec],
    }));

    const queryOp = OPERATIONS.find(o => o.name === 'query')!;
    const ctx = { engine, config: null, logger: console, dryRun: false, remote: false } as any;
    const results = await queryOp.handler(ctx, {
      image: 'aGVsbG8=', // 'hello'
      image_mime: 'image/png',
      limit: 10,
    }) as Array<{ slug: string }>;

    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('photos/img');
    expect(slugs).not.toContain('notes/text');
  });
});
