/**
 * #3985 — `types`-filtered searches must bypass the semantic query cache.
 *
 * `types` is not part of knobsHash, so a type-filtered result set stored in
 * the cache could be served to an unfiltered lookup (and vice versa) — the
 * same contamination class as #3442's date filters. Pins:
 *   1. a types run reports cache 'disabled' (skip on lookup AND store),
 *   2. an unfiltered write is never served to a types read,
 *   3. a types run never stores a row for later unfiltered hits.
 *
 * Serial: mock.module + gateway/global-env mutation (same harness shape as
 * test/hybrid-cache-scope-poison.serial.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

/** Deterministic 1536d unit vector so consults match writes at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

setDefaultTimeout(30_000);

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-types-cache-skip-'));
  process.env.GBRAIN_HOME = tmpHome;

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder.`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM query_cache');
});

describe('#3985 — types-filtered requests skip the semantic cache', () => {
  test('an unfiltered write is never served to a types read (and the types run stores nothing)', async () => {
    // 1. Unfiltered miss-run stores a row containing BOTH pages.
    let missMeta: HybridSearchMeta | undefined;
    const unfiltered = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { missMeta = m; },
    });
    expect(missMeta?.cache?.status).toBe('miss');
    expect(unfiltered.map((r) => r.slug).sort()).toEqual(['alice-foo', 'bob-bar']);
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);

    // 2. Same query WITH a types filter: identical embedding + knobs would
    //    have HIT the stored all-types row pre-fix. Must bypass instead.
    let typesMeta: HybridSearchMeta | undefined;
    const personsOnly = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      types: ['person'],
      onMeta: (m) => { typesMeta = m; },
    });
    expect(typesMeta?.cache?.status).toBe('disabled');
    expect(personsOnly.map((r) => r.slug)).toEqual(['alice-foo']);

    // 3. The types run must not have stored anything either.
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);
  });

  test('a types-first run leaves the cache empty, so a later unfiltered read gets full recall', async () => {
    let typesMeta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'builder', {
      limit: 10,
      types: ['company'],
      onMeta: (m) => { typesMeta = m; },
    });
    expect(typesMeta?.cache?.status).toBe('disabled');
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(0);

    const unfiltered = await hybridSearchCached(engine, 'builder', { limit: 10 });
    expect(unfiltered.map((r) => r.slug).sort()).toEqual(['alice-foo', 'bob-bar']);
  });
});
