/**
 * Read-path audit #20: semantic result caching is disabled
 * (semanticResultCacheAvailable() === false), but hybridSearchCached still
 * loaded the merged config, the cache config and the intent-pattern state to
 * build a cache key nothing reads. With the cache unavailable the wrapper
 * must cost no engine round-trips beyond the bare search it runs.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { hybridSearch, hybridSearchCached } from '../../src/core/search/hybrid.ts';
import { semanticResultCacheAvailable } from '../../src/core/search/query-cache.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/a', { type: 'note', title: 'Note A', compiled_truth: 'widget alpha' } as any);
  const snap = (await readProjectionSnapshot(engine, 'notes/a', 'default', { allowUnsealed: true }))!;
  await installPageProjection(engine, snap, [{
    chunk_index: 0, chunk_text: 'widget alpha', chunk_source: 'compiled_truth', embedding: basisEmbedding(3, 1536), token_count: 5,
  }] as any, { seal: true });
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

function counting(e: BrainEngine): { proxy: BrainEngine; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const proxy = new Proxy(e, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls[String(prop)] = (calls[String(prop)] ?? 0) + 1;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { proxy, calls };
}

describe('hybridSearchCached with the semantic cache unavailable', () => {
  test('costs no engine calls beyond the bare search', async () => {
    expect(semanticResultCacheAvailable()).toBe(false);
    const opts = { reranker: { enabled: false, topNIn: 0, topNOut: null } as any, queryEmbedFn: () => basisEmbedding(3, 1536) };
    const bare = counting(engine as unknown as BrainEngine);
    const wrapped = counting(engine as unknown as BrainEngine);
    const a = await hybridSearch(bare.proxy, 'widget', opts);
    const b = await hybridSearchCached(wrapped.proxy, 'widget', opts);
    expect(b.map(r => r.slug)).toEqual(a.map(r => r.slug));
    expect(wrapped.calls).toEqual(bare.calls);
  }, 60_000);
});
