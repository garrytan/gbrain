// #4356 Problem 2 regression: the `query` op's image-similarity branch used
// to hard-default `limit` to 20 regardless of the active search mode — the
// only search arm in this op that didn't honor conservative/balanced/
// tokenmax's searchLimit (10/25/50). This pins the fix: the image branch now
// resolves the same mode-derived searchLimit as the text path, through the
// same resolution chain (loadSearchModeConfig + resolveSearchMode), and
// respects the same remote trust gate as `resolvePerCallMode` (a remote
// caller's `mode` param must never escalate cost/result-count).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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

afterEach(() => {
  mock.restore();
});

function fakeImage1024(seed: number): Float32Array {
  const out = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) out[i] = (i + seed) / 1024;
  return out;
}

async function seedImagePages(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const slug = `photos/img-${i}`;
    await engine.putPage(slug, {
      type: 'image', page_kind: 'image', title: slug, compiled_truth: '', timeline: '',
    });
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: slug,
        chunk_source: 'image_asset',
        // Small seed spread so every page is a plausible near-neighbor —
        // the point of these tests is counting how many come back, not
        // ranking correctness (covered by query-image-flag.serial.test.ts).
        embedding_image: fakeImage1024(i * 0.01),
        modality: 'image',
      },
    ]);
  }
}

const queryOp = OPERATIONS.find(o => o.name === 'query')!;

async function runImageQuery(opts: { limit?: number; mode?: string; remote?: boolean }) {
  mock.module('../src/core/ai/gateway.ts', () => ({
    embedMultimodal: async () => [fakeImage1024(0)],
  }));
  const ctx = {
    engine, config: null, logger: console, dryRun: false, remote: opts.remote ?? false,
  } as any;
  const params: Record<string, unknown> = {
    image: Buffer.from('fake image bytes').toString('base64'),
    image_mime: 'image/jpeg',
  };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.mode !== undefined) params.mode = opts.mode;
  return queryOp.handler(ctx, params) as Promise<Array<{ slug: string }>>;
}

describe('query op image branch — mode-derived limit (#4356 Problem 2)', () => {
  test('limit omitted, conservative mode → 10 results', async () => {
    await seedImagePages(15);
    await engine.setConfig('search.mode', 'conservative');
    const results = await runImageQuery({});
    expect(results.length).toBe(10);
  });

  test('limit omitted, balanced mode → 25 results', async () => {
    await seedImagePages(30);
    await engine.setConfig('search.mode', 'balanced');
    const results = await runImageQuery({});
    expect(results.length).toBe(25);
  });

  test('limit omitted, tokenmax mode → 50 results', async () => {
    await seedImagePages(60);
    await engine.setConfig('search.mode', 'tokenmax');
    const results = await runImageQuery({});
    expect(results.length).toBe(50);
  });

  test('no mode configured → balanced fallback (25), not the old flat 20', async () => {
    await seedImagePages(30);
    const results = await runImageQuery({});
    expect(results.length).toBe(25);
  });

  test('search.searchLimit config override is honored', async () => {
    await seedImagePages(20);
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.searchLimit', '15');
    const results = await runImageQuery({});
    expect(results.length).toBe(15);
  });

  test('explicit limit param wins over the resolved mode', async () => {
    await seedImagePages(20);
    await engine.setConfig('search.mode', 'tokenmax');
    const results = await runImageQuery({ limit: 3 });
    expect(results.length).toBe(3);
  });

  test('explicit limit=0 is treated as unset (falls back to resolved mode), matching the text path convention', async () => {
    await seedImagePages(15);
    await engine.setConfig('search.mode', 'conservative');
    const results = await runImageQuery({ limit: 0 });
    expect(results.length).toBe(10);
  });

  test('trusted local caller can select a per-call mode', async () => {
    await seedImagePages(15);
    await engine.setConfig('search.mode', 'balanced');
    const results = await runImageQuery({ mode: 'conservative', remote: false });
    expect(results.length).toBe(10);
  });

  test("remote caller's mode param is ignored for the mode-derived default (uses server-configured mode)", async () => {
    await seedImagePages(60);
    await engine.setConfig('search.mode', 'conservative');
    // A remote caller asking for tokenmax's mode-derived default must be
    // silently ignored — the server-configured mode (conservative=10) wins,
    // not tokenmax's 50. This is the `resolvePerCallMode` trust gate that
    // the text path already relies on; it governs the DEFAULT only — an
    // explicit `limit` still overrides it for any caller, same as every
    // other limit surface in this op (see the explicit-limit-wins test
    // above), so this is not a hard per-call result-count ceiling.
    const results = await runImageQuery({ mode: 'tokenmax', remote: true });
    expect(results.length).toBe(10);
  });
});
