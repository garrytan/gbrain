/**
 * A negative limit/offset must not reach slice(offset, offset + limit):
 * limit -3 over a 20-row pool returned 17 rows. It falls back to the mode
 * default instead, same as limit 0 / undefined.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

let engine: PGLiteEngine;
const TYPES = ['person', 'company', 'note'] as const;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < 20; i++) {
    const slug = `zf-${i}`;
    const text = `zebrafish study number ${i}`;
    await engine.putPage(slug, { type: TYPES[i % 3], title: `Zf ${i}`, compiled_truth: text });
    await installFixtureChunks(engine, slug, [
      { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' },
    ]);
  }
}, 120_000);

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* ignore */ }
});

describe('hybridSearch negative limit/offset', () => {
  test('negative limit behaves like the default, not pool minus N', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const base = await hybridSearch(engine, 'zebrafish', {});
      const neg = await hybridSearch(engine, 'zebrafish', { limit: -3 });
      expect(neg.length).toBe(base.length);
      expect(neg.length).toBeGreaterThan(0);
    });
  });

  test('negative offset behaves like offset 0', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const base = await hybridSearch(engine, 'zebrafish', { limit: 5 });
      const neg = await hybridSearch(engine, 'zebrafish', { limit: 5, offset: -2 });
      expect(neg.map((r) => r.slug)).toEqual(base.map((r) => r.slug));
    });
  });
});
