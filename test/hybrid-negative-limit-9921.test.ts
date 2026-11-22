/**
 * #9921: a negative limit or offset reached slice(offset, offset + limit), so limit -3 over a 20-row pool
 * returned 17 rows and a negative offset sliced from the end.
 *
 * 1. Protects: hybrid search reads a non-positive limit as unset (the mode default, as limit 0 already is)
 *    and a negative offset as 0, the same as the search op's offset parsing and clampSearchLimit.
 * 2. Fails when: resolveHybridRequest passes a negative limit or offset through to the final slice.
 * 3. Real seams: hybridSearch on a keyless PGLite brain (the keyword-only arm).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < 20; i++) {
    const slug = `notes/zebrafish-${i}`;
    const text = `zebrafish study number ${i}`;
    await engine.putPage(slug, { type: 'note', title: `Zebrafish ${i}`, compiled_truth: text });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }]);
  }
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

describe('hybridSearch with a negative limit or offset (#9921)', () => {
  test('a negative limit returns the default page, not the pool minus N', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const base = await hybridSearch(engine, 'zebrafish', {});
      const negative = await hybridSearch(engine, 'zebrafish', { limit: -3 });
      expect(base.length).toBeGreaterThan(0);
      expect(negative.map(r => r.slug)).toEqual(base.map(r => r.slug));
    });
  });

  test('search with match keyword reads a negative limit as the default too', async () => {
    const ctx = { engine, config: {}, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as OperationContext;
    const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { results: unknown[] }).results).length;
    const base = await operationsByName['search']!.handler(ctx, { query: 'zebrafish', match: 'keyword', limit: 5 });
    const negative = await operationsByName['search']!.handler(ctx, { query: 'zebrafish', match: 'keyword', limit: -3 });
    expect(rows(base)).toBe(5);
    expect(rows(negative)).toBe(20);
  });

  test('a negative offset reads as offset 0', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const base = await hybridSearch(engine, 'zebrafish', { limit: 5 });
      const negative = await hybridSearch(engine, 'zebrafish', { limit: 5, offset: -2 });
      expect(negative.map(r => r.slug)).toEqual(base.map(r => r.slug));
    });
  });
});
