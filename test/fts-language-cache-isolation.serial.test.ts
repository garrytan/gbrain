/**
 * Production-wrapper regression coverage with semantic response caching disabled.
 * Fresh reads must retain filtering, metadata and telemetry guarantees; legacy
 * cache implementation behavior is covered by the direct cache-class suites.
 * Serial because embedding and gateway configuration are process-global.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector — identical for every call, so a cache
 * consult matches a prior write at cosine 1.0 whenever the knobs hash
 * agrees. That isolates the assertion to the key, not the similarity gate. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Mock BEFORE importing hybrid.ts (spread keeps every other export live).
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

// Import AFTER mocking.
const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { resetFtsLanguageCache } = await import('../src/core/fts-language.ts');

type Meta = import('../src/core/types.ts').HybridSearchMeta;

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;
const savedFtsLanguage = process.env.GBRAIN_FTS_LANGUAGE;

/** Pin the process FTS language (undefined = unset → the 'english' default).
 * getFtsLanguage() memoizes, so the cache is reset on every change. */
function setFtsLanguage(language: string | undefined): void {
  if (language === undefined) delete process.env.GBRAIN_FTS_LANGUAGE;
  else process.env.GBRAIN_FTS_LANGUAGE = language;
  resetFtsLanguageCache();
}

/** One cached search; returns the results plus the published cache status. */
async function search(query: string): Promise<{
  results: Awaited<ReturnType<typeof hybridSearchCached>>;
  status: NonNullable<Meta['cache']>['status'] | undefined;
}> {
  let meta: Meta | undefined;
  const results = await hybridSearchCached(engine, query, {
    limit: 10,
    onMeta: (m) => { meta = m; },
  });
  await awaitPendingSearchCacheWrites();
  return { results, status: meta?.cache?.status };
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-fts-cache-key-'));
  process.env.GBRAIN_HOME = tmpHome;

  setFtsLanguage(undefined);

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
    ['carol-baz', 'Carol Baz', 'note'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder. ${'x'.repeat(400)}`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  if (savedFtsLanguage === undefined) delete process.env.GBRAIN_FTS_LANGUAGE;
  else process.env.GBRAIN_FTS_LANGUAGE = savedFtsLanguage;
  resetFtsLanguageCache();
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('fresh retrieval across an FTS language switch', () => {
  test('switching language immediately changes fresh results and switching back restores recall', async () => {
    setFtsLanguage(undefined);
    const englishRun = await search('builders');
    expect(englishRun.status).toBe('disabled');
    expect(englishRun.results.length).toBeGreaterThan(0);

    const englishRepeat = await search('builders');
    expect(englishRepeat.status).toBe('disabled');
    expect(englishRepeat.results.length).toBe(englishRun.results.length);

    setFtsLanguage('simple');
    const switched = await search('builders');

    expect(switched.status).toBe('disabled');
    expect(switched.results.length).toBeLessThan(englishRun.results.length);

    setFtsLanguage(undefined);
    const back = await search('builders');
    expect(back.status).toBe('disabled');
    expect(back.results.map((r) => r.slug)).toEqual(englishRun.results.map((r) => r.slug));
  });
});
