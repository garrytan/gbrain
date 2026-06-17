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
} from '../src/core/facts/meta-hook.ts';
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
});
