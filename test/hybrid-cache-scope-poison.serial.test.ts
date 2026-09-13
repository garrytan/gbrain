/**
 * Corrective-release containment: stored semantic responses are never consulted
 * or written by the production wrapper, even with a provider, enabled config,
 * caller opt-in and an existing cache row containing private data.
 * Direct SemanticQueryCache storage/lookup tests remain independently active.
 * Serial because embedding and gateway configuration are process-global.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import type { HybridSearchMeta, SearchResult } from '../src/core/types.ts';

/** Deterministic 1536d unit vector — identical for every call, so the
 * second consult matches the first write at cosine 1.0. */
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
const { importFromContent } = await import('../src/core/import-file.ts');
const { SemanticQueryCache, semanticResultCacheAvailable } = await import('../src/core/search/query-cache.ts');

// Cold-start PGLite schema setup (beforeAll) can exceed bun's 5s default
// hook budget on a fresh checkout; same bump pattern as
// test/scripts/check-engine-dynamic-import.test.ts.
setDefaultTimeout(30_000);

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  // Hermetic config home so the developer's real ~/.gbrain/config.json
  // can't leak an embedding_model that flips the cache consult to
  // 'disabled' via isCacheSafe.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cache-scope-poison-'));
  process.env.GBRAIN_HOME = tmpHome;

  // Pin the gateway to a 1536d provider BEFORE initSchema so the
  // query_cache.embedding column is sized for the mock vectors. The fake
  // key is never used — embedQuery is mocked above.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('search.cache.enabled', 'true');

  // Real imports create keyword-findable pages with completed indexes for
  // every source/privacy scope exercised below.
  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder.`;
    const imported = await importFromContent(
      engine, slug, `---\ntitle: ${title}\ntype: ${type}\n---\n\n${truth}`,
      { noEmbed: true, sourceId: 'default' },
    );
    expect(imported.status).toBe('imported');
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
  // Each test builds its own cache state from empty.
  await engine.executeRaw('DELETE FROM query_cache');
});

describe('semantic response containment', () => {
  test('the effective availability gate is disabled', () => {
    expect(semanticResultCacheAvailable()).toBe(false);
  });

  test('neither configuration nor per-call cache preferences can override containment', async () => {
    const lookup = spyOn(SemanticQueryCache.prototype, 'lookup');
    const store = spyOn(SemanticQueryCache.prototype, 'store');
    try {
      for (const enabled of ['false', 'true']) {
        await engine.setConfig('search.cache.enabled', enabled);
        for (const useCache of [undefined, false, true]) {
          let meta: HybridSearchMeta | undefined;
          const results = await hybridSearchCached(engine, 'builder', { useCache, onMeta: value => { meta = value; } });
          expect(results.length).toBeGreaterThan(0);
          expect(meta?.cache?.status).toBe('disabled');
        }
      }
      await awaitPendingSearchCacheWrites();
      expect(lookup).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(await engine.executeRaw('SELECT id FROM query_cache')).toEqual([]);
    } finally {
      lookup.mockRestore();
      store.mockRestore();
    }
  });

  const scopes = [
    { label: 'unscoped', opts: {} },
    { label: 'scalar source', opts: { sourceId: 'default' } },
    { label: 'federated sources', opts: { sourceIds: ['default'] } },
    { label: 'private-excluding source', opts: { sourceId: 'default', excludePrivate: true } },
  ];
  for (const { label, opts } of scopes) {
    test(`${label}: enabled config and caller opt-in cannot read or rewrite legacy cache data`, async () => {
      const fresh = await hybridSearchCached(engine, 'builder', { ...opts, useCache: true, limit: 10 });
      expect(fresh.length).toBeGreaterThan(0);
      const privateRow: SearchResult = { ...fresh[0], title: 'CACHED_PRIVATE_TITLE', chunk_text: 'CACHED_PRIVATE_TEXT' };
      const cache = new SemanticQueryCache(engine, { enabled: true });
      await cache.store('builder', fixedEmbedding(), [privateRow], {
        vector_enabled: true, detail_resolved: null, expansion_applied: false, retrieved_count: 1,
        legacy_private_detail: 'CACHED_PRIVATE_METADATA',
      } as HybridSearchMeta, { sourceId: 'default', knobsHash: 'legacy-policy' });
      // Positive control: this is a readable cache row, not a vacuous empty cache.
      const legacy = await cache.lookup(fixedEmbedding(), { sourceId: 'default', knobsHash: 'legacy-policy', queryText: 'builder' });
      expect(legacy.hit).toBe(true);
      expect(legacy.results?.[0].chunk_text).toBe('CACHED_PRIVATE_TEXT');
      const before = await engine.executeRaw('SELECT id, results, meta, hit_count, created_at FROM query_cache');
      expect(before).toHaveLength(1);

      const lookup = spyOn(SemanticQueryCache.prototype, 'lookup');
      const store = spyOn(SemanticQueryCache.prototype, 'store');
      try {
        let meta: HybridSearchMeta | undefined;
        const results = await hybridSearchCached(engine, 'builder', {
          ...opts, useCache: true, limit: 10, onMeta: value => { meta = value; },
        });
        await awaitPendingSearchCacheWrites();
        expect(results.length).toBeGreaterThan(0);
        expect(results.map(row => row.slug).sort()).toEqual(fresh.map(row => row.slug).sort());
        expect(JSON.stringify({ results, meta })).not.toContain('CACHED_PRIVATE');
        expect(meta?.cache?.status).toBe('disabled');
        expect(lookup).not.toHaveBeenCalled();
        expect(store).not.toHaveBeenCalled();
        expect(await engine.executeRaw('SELECT id, results, meta, hit_count, created_at FROM query_cache')).toEqual(before);
      } finally {
        lookup.mockRestore();
        store.mockRestore();
      }
    });
  }

  test('repeated paginated reads stay fresh and never write a sliced cache entry', async () => {
    const search = async (offset: number) => {
      let meta: HybridSearchMeta | undefined;
      const rows = await hybridSearchCached(engine, 'builder', {
        sourceId: 'default', offset, limit: 1, useCache: true, onMeta: value => { meta = value; },
      });
      expect(meta?.cache?.status).toBe('disabled');
      expect(rows).toHaveLength(1);
      return rows;
    };
    const first = await search(0);
    const second = await search(1);
    expect(first[0].slug).not.toBe(second[0].slug);
    expect((await search(0))[0].slug).toBe(first[0].slug);
    await awaitPendingSearchCacheWrites();
    expect(await engine.executeRaw('SELECT id FROM query_cache')).toEqual([]);
  });
});
