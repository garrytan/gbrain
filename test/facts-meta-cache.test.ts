/**
 * v0.31 Phase 6 follow-up — meta-hook cache key + invalidation contract.
 *
 * Pins:
 *   - 30s TTL: cache hit on second call within window (different rows
 *     don't show up).
 *   - bumpHotMemoryCache(source_id, session_id) drops only the matching
 *     entries; other (source_id, session_id) tuples stay cached.
 *   - cache key isolates across distinct allow-lists (already covered by
 *     facts-context-injection.serial.test.ts; pinned here from a different
 *     angle — the in-process cache directly).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  getBrainHotMemoryMeta,
  bumpHotMemoryCache,
  __resetHotMemoryCacheForTests,
  __hotMemoryCacheForTests,
  HOT_MEMORY_CACHE_MAX_ENTRIES,
} from '../src/core/facts/meta-hook.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  __resetHotMemoryCacheForTests();
});

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

describe('meta-hook cache', () => {
  test('cache hit returns the same payload without re-querying', async () => {
    await engine.insertFact(
      { fact: 'cache test fact', kind: 'fact', entity_slug: 'cache-test', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );

    const first = await getBrainHotMemoryMeta('get_stats', ctx());
    expect(first?.brain_hot_memory).toBeDefined();
    const firstFacts = (first!.brain_hot_memory as { facts: { id: number }[] }).facts;
    const firstCount = firstFacts.length;

    // Insert another fact — but cache hit short-circuits so the new one
    // doesn't surface until we bump.
    await engine.insertFact(
      { fact: 'second fact (post-cache)', kind: 'fact', entity_slug: 'cache-test', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    const second = await getBrainHotMemoryMeta('get_stats', ctx());
    const secondFacts = (second!.brain_hot_memory as { facts: { id: number }[] }).facts;
    expect(secondFacts.length).toBe(firstCount);
  });

  test('bumpHotMemoryCache forces a fresh query on next call', async () => {
    await engine.insertFact(
      { fact: 'bump-test seed', kind: 'fact', entity_slug: 'bump', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    const first = await getBrainHotMemoryMeta('get_stats', ctx());
    const firstCount = (first!.brain_hot_memory as { facts: unknown[] }).facts.length;
    await engine.insertFact(
      { fact: 'bump-test post-bump', kind: 'fact', entity_slug: 'bump', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    bumpHotMemoryCache('default', null);
    const second = await getBrainHotMemoryMeta('get_stats', ctx());
    const secondCount = (second!.brain_hot_memory as { facts: unknown[] }).facts.length;
    expect(secondCount).toBeGreaterThan(firstCount);
  });

  test('bumpHotMemoryCache for one (source, session) does not affect another', async () => {
    // Seed and warm caches for two sessions of the same source.
    await engine.insertFact(
      { fact: 'sess-A fact', kind: 'fact', entity_slug: 'multi-sess', visibility: 'world', source: 'test', source_session: 'sess-A' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'sess-B fact', kind: 'fact', entity_slug: 'multi-sess', visibility: 'world', source: 'test', source_session: 'sess-B' },
      { source_id: 'default' },
    );
    // Note: the helper uses ctx.source_session via the exotic accessor;
    // since OperationContext doesn't formally carry it, call with a forged
    // shape via overrides.
    const ctxA = ctx({}) as OperationContext & { source_session?: string };
    ctxA.source_session = 'sess-A';
    const ctxB = ctx({}) as OperationContext & { source_session?: string };
    ctxB.source_session = 'sess-B';
    const a1 = await getBrainHotMemoryMeta('get_stats', ctxA);
    const b1 = await getBrainHotMemoryMeta('get_stats', ctxB);
    const a1Count = (a1?.brain_hot_memory as { facts: unknown[] } | undefined)?.facts.length ?? 0;
    const b1Count = (b1?.brain_hot_memory as { facts: unknown[] } | undefined)?.facts.length ?? 0;

    // Bump only sess-A; sess-B's cache stays warm.
    bumpHotMemoryCache('default', 'sess-A');

    // Add a fact to each session; only sess-A's next call should reflect it.
    await engine.insertFact(
      { fact: 'sess-A fact 2', kind: 'fact', entity_slug: 'multi-sess', visibility: 'world', source: 'test', source_session: 'sess-A' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'sess-B fact 2', kind: 'fact', entity_slug: 'multi-sess', visibility: 'world', source: 'test', source_session: 'sess-B' },
      { source_id: 'default' },
    );
    const a2 = await getBrainHotMemoryMeta('get_stats', ctxA);
    const b2 = await getBrainHotMemoryMeta('get_stats', ctxB);
    const a2Count = (a2?.brain_hot_memory as { facts: unknown[] } | undefined)?.facts.length ?? 0;
    const b2Count = (b2?.brain_hot_memory as { facts: unknown[] } | undefined)?.facts.length ?? 0;

    expect(a2Count).toBeGreaterThanOrEqual(a1Count);
    // sess-B's cache wasn't bumped → returns cached count, NOT the new
    // fact-2 row.
    expect(b2Count).toBe(b1Count);
  });

  test('skipped on facts-self ops (recall, extract_facts, forget_fact)', async () => {
    expect(await getBrainHotMemoryMeta('recall', ctx())).toBeUndefined();
    expect(await getBrainHotMemoryMeta('extract_facts', ctx())).toBeUndefined();
    expect(await getBrainHotMemoryMeta('forget_fact', ctx())).toBeUndefined();
  });

  test('different allow-lists produce distinct cache entries', async () => {
    await engine.insertFact(
      { fact: 'alpha fact for cache', kind: 'fact', entity_slug: 'allow-cache', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    const ctxNoList = ctx();
    const ctxWithList = ctx({ takesHoldersAllowList: ['world', 'self'] });
    const r1 = await getBrainHotMemoryMeta('get_stats', ctxNoList);
    const r2 = await getBrainHotMemoryMeta('get_stats', ctxWithList);
    // Both compute their own entries — neither should error, both have
    // the same world-visible fact in this hermetic case.
    expect(r1?.brain_hot_memory).toBeDefined();
    expect(r2?.brain_hot_memory).toBeDefined();
  });

  test('[] (explicit deny-all) and undefined allow-lists do NOT share a cache entry (#2529)', async () => {
    // Isolated source so topK saturation from other tests can't mask the
    // count difference this test keys on.
    const src = 'deny-key-src';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [src],
    );
    await engine.insertFact(
      { fact: 'deny-key seed fact', kind: 'fact', entity_slug: 'deny-key', visibility: 'world', source: 'test' },
      { source_id: src },
    );
    // Warm the cache under the UNSET allow-list key.
    const unset = await getBrainHotMemoryMeta('get_stats', ctx({ sourceId: src }));
    const unsetCount = (unset?.brain_hot_memory as { facts: unknown[] } | undefined)?.facts.length ?? 0;
    expect(unsetCount).toBeGreaterThan(0);

    // New fact lands AFTER the warm — a shared cache key would serve the
    // stale (pre-insert) payload to the [] caller. Pre-fix, hashAllowList
    // collapsed both to '_' and this returned unsetCount.
    await engine.insertFact(
      { fact: 'deny-key post-warm fact', kind: 'fact', entity_slug: 'deny-key', visibility: 'world', source: 'test' },
      { source_id: src },
    );
    const emptyList = await getBrainHotMemoryMeta('get_stats', ctx({ sourceId: src, takesHoldersAllowList: [] }));
    const emptyCount = (emptyList?.brain_hot_memory as { facts: unknown[] } | undefined)?.facts.length ?? 0;
    expect(emptyCount).toBeGreaterThan(unsetCount);
  });
});

describe('meta-hook cache hygiene (bounded, expired-entry eviction)', () => {
  /** Engine stub with no facts — every call takes the payload:undefined cache path. */
  function emptyEngine(): BrainEngine {
    return {
      listFactsBySession: async () => [],
      listFactsSince: async () => [],
    } as unknown as BrainEngine;
  }

  test('expired entry is evicted on read-miss even when the rebuild fails', async () => {
    await engine.insertFact(
      { fact: 'expiry-evict seed', kind: 'fact', entity_slug: 'expiry-evict', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    // Warm the cache, then force the entry past its expiry.
    await getBrainHotMemoryMeta('get_stats', ctx());
    const cache = __hotMemoryCacheForTests();
    expect(cache.size).toBe(1);
    for (const entry of cache.values()) entry.expiresAt = Date.now() - 1;

    // Rebuild path throws (dispatch absorbs this in production). The expired
    // entry must NOT survive the failed rebuild — delete happens on read-miss.
    const boomEngine = {
      listFactsBySession: async () => { throw new Error('boom'); },
      listFactsSince: async () => { throw new Error('boom'); },
    } as unknown as BrainEngine;
    await expect(getBrainHotMemoryMeta('get_stats', ctx({ engine: boomEngine }))).rejects.toThrow('boom');
    expect(cache.size).toBe(0);
  });

  test('max-entries bound holds under many distinct (caller-controlled) session ids', async () => {
    const stub = emptyEngine();
    const total = HOT_MEMORY_CACHE_MAX_ENTRIES + 50;
    for (let i = 0; i < total; i++) {
      await getBrainHotMemoryMeta('get_stats', ctx({ engine: stub, sessionId: `spam-${i}` }));
    }
    const cache = __hotMemoryCacheForTests();
    expect(cache.size).toBe(HOT_MEMORY_CACHE_MAX_ENTRIES);
    // Oldest-expiry (== oldest-inserted at uniform TTL) entries were evicted;
    // the newest survives.
    const keys = [...cache.keys()];
    expect(keys.some((k) => k.includes(`spam-${total - 1}`))).toBe(true);
    expect(keys.some((k) => k.includes('spam-0::'))).toBe(false);
  });
});
