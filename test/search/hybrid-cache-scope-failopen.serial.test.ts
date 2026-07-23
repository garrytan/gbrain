/**
 * Fail-open regression for the typed cache scope key (takeover of #2875).
 *
 * `cacheScopeKey` rejects forged/malformed source ids (typed-key contract,
 * test/cache-scope-key.test.ts). That throw is correct for direct callers,
 * but inside `hybridSearchCached` an invalid scope id must degrade to
 * "skip the semantic cache" — the cache must never break the search hot
 * path. Before the fix, the key was computed inline at the cache-lookup
 * call site (outside any catch), so a forged sourceId that reached the
 * cached path rejected the whole search once a query embedding was
 * available.
 *
 * Serial file: mock.module leaks across files in a shared shard process.
 */
import { afterAll, beforeAll, describe, expect, test, mock } from 'bun:test';

const makeEmbedding = (): Float32Array => {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
};

// Mock the embedding module BEFORE importing hybrid.ts so the cache-lookup
// embed succeeds and the lookup call site is actually reached (the failure
// mode under test only fired once a query embedding existed).
mock.module('../../src/core/embedding.ts', () => ({
  embed: async () => makeEmbedding(),
  embedQuery: async () => makeEmbedding(),
}));

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('failopen/fixture', {
    type: 'note',
    title: 'Fail-open fixture',
    compiled_truth: 'fail open fixture content',
    timeline: '',
    frontmatter: {},
  });
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('hybridSearchCached cache-scope fail-open', () => {
  test('a forged sourceId skips the cache instead of breaking the search', async () => {
    const { hybridSearchCached } = await import('../../src/core/search/hybrid.ts');
    // '__set__:a,b' is a forged legacy set-encoding — cacheScopeKey throws
    // on it. The search itself must still resolve (cache silently skipped).
    const results = await hybridSearchCached(engine, 'fixture', {
      sourceId: '__set__:a,b',
      useCache: true,
      limit: 5,
    });
    expect(Array.isArray(results)).toBe(true);
    // Nothing may have been written into the cache under a forged scope.
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM query_cache`,
    );
    expect(rows[0]?.n ?? 0).toBe(0);
  });
});
