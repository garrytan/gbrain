/**
 * v0.32.3 search-lite telemetry rollup writer tests.
 *
 * Pins the architecture decisions from D2 + [CDX-17] + [CDX-18]:
 *   - In-memory bucket flushed periodically (NOT per-call DB write)
 *   - Sums + counts, NEVER pre-averaged columns
 *   - Date-bucketed cache hit/miss derivable over --days N window
 *   - ON CONFLICT DO UPDATE adds raw values (concurrent flushes accumulate)
 *   - Per-bucket isolation: one bad row doesn't lose the others
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  recordSearchTelemetry,
  readSearchStats,
  getTelemetryWriter,
  _resetTelemetryWriterForTest,
} from '../src/core/search/telemetry.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

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
  _resetTelemetryWriterForTest();
  await engine.executeRaw('DELETE FROM search_telemetry');
});

const makeMeta = (overrides: Partial<HybridSearchMeta> = {}): HybridSearchMeta => ({
  vector_enabled: true,
  detail_resolved: null,
  expansion_applied: false,
  intent: 'general',
  mode: 'balanced',
  ...overrides,
});

describe('recordSearchTelemetry — in-memory bucket', () => {
  test('first record creates a bucket; record() never blocks the caller', () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    expect(w.bucketCountForTest()).toBe(0);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    expect(w.bucketCountForTest()).toBe(1);
  });

  test('same (date, mode, intent) accumulates into one bucket', () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 7 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 3 });
    expect(w.bucketCountForTest()).toBe(1);
    const today = new Date().toISOString().slice(0, 10);
    const b = w.bucketForTest(today, 'balanced', 'general');
    expect(b?.count).toBe(3);
    expect(b?.sum_results).toBe(15); // 5 + 7 + 3
  });

  test('different modes / intents create distinct buckets', () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ mode: 'conservative', intent: 'entity' }), { results_count: 2 });
    recordSearchTelemetry(engine, makeMeta({ mode: 'tokenmax', intent: 'temporal' }), { results_count: 9 });
    recordSearchTelemetry(engine, makeMeta({ mode: 'balanced', intent: 'event' }), { results_count: 4 });
    expect(w.bucketCountForTest()).toBe(3);
  });

  test('cache_hit / cache_miss counters fire from meta.cache.status', () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }));
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }));
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'miss' } }));
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'disabled' } }));
    const today = new Date().toISOString().slice(0, 10);
    const b = w.bucketForTest(today, 'balanced', 'general')!;
    expect(b.cache_hit).toBe(2);
    expect(b.cache_miss).toBe(1);
    expect(b.count).toBe(4);
  });

  test('sum_budget_dropped accumulates from meta.token_budget.dropped', () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ token_budget: { budget: 4000, used: 3800, kept: 8, dropped: 12 } }));
    recordSearchTelemetry(engine, makeMeta({ token_budget: { budget: 4000, used: 4000, kept: 10, dropped: 7 } }));
    const today = new Date().toISOString().slice(0, 10);
    const b = w.bucketForTest(today, 'balanced', 'general')!;
    expect(b.sum_budget_dropped).toBe(19); // 12 + 7
  });

  test('missing mode / intent fall back to "unset" — telemetry is non-blocking', () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, { vector_enabled: true, detail_resolved: null, expansion_applied: false });
    const today = new Date().toISOString().slice(0, 10);
    expect(w.bucketForTest(today, 'unset', 'unset')).not.toBeNull();
  });
});

describe('flush() writes to search_telemetry', () => {
  test('flush drains the bucket map atomically', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 7 });
    expect(w.bucketCountForTest()).toBe(1);
    await w.flush();
    expect(w.bucketCountForTest()).toBe(0);

    const rows = await engine.executeRaw<{ count: number; sum_results: number }>(
      'SELECT count, sum_results FROM search_telemetry',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].sum_results).toBe(12);
  });

  test('ON CONFLICT DO UPDATE adds raw values (concurrent-flush semantics)', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);

    // First flush: 3 calls under balanced/general.
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    await w.flush();

    // Second flush: 2 more calls under same (date, mode, intent).
    recordSearchTelemetry(engine, makeMeta(), { results_count: 10 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 10 });
    await w.flush();

    const rows = await engine.executeRaw<{ count: number; sum_results: number }>(
      'SELECT count, sum_results FROM search_telemetry',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(5); // 3 + 2
    expect(rows[0].sum_results).toBe(35); // (5+5+5) + (10+10)
  });

  test('flush is no-op when bucket map is empty', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    await w.flush(); // no records, no rows
    const rows = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM search_telemetry');
    expect(rows[0].n).toBe(0);
  });

  test('concurrent flush() calls coalesce (flushInFlight reuse)', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 1 });
    // Two simultaneous flush() awaits → both observe the same underlying drain.
    const [a, b] = await Promise.all([w.flush(), w.flush()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    const rows = await engine.executeRaw<{ count: number }>('SELECT count FROM search_telemetry');
    expect(rows[0].count).toBe(1); // not doubled
  });
});

describe('readSearchStats — read-time derived averages', () => {
  test('empty table → all-zero stats', async () => {
    const s = await readSearchStats(engine, { days: 7 });
    expect(s.total_calls).toBe(0);
    expect(s.cache_hit_rate).toBe(0);
    expect(s.avg_results).toBe(0);
  });

  test('one bucket flushed → stats derive averages from sums/counts', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 10 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 20 });
    recordSearchTelemetry(engine, makeMeta(), { results_count: 30 });
    await w.flush();

    const s = await readSearchStats(engine, { days: 7 });
    expect(s.total_calls).toBe(3);
    expect(s.avg_results).toBe(20); // (10 + 20 + 30) / 3 = 20
  });

  test('cache_hit_rate computed from hits + misses (excludes disabled)', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }));
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }));
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }));
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'miss' } }));
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'disabled' } }));
    await w.flush();

    const s = await readSearchStats(engine, { days: 7 });
    expect(s.cache_hits).toBe(3);
    expect(s.cache_misses).toBe(1);
    expect(s.cache_hit_rate).toBeCloseTo(0.75, 5); // 3 / (3 + 1) = 0.75
  });

  test('intent_distribution and mode_distribution surface counts', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ mode: 'conservative', intent: 'entity' }));
    recordSearchTelemetry(engine, makeMeta({ mode: 'conservative', intent: 'entity' }));
    recordSearchTelemetry(engine, makeMeta({ mode: 'tokenmax', intent: 'temporal' }));
    await w.flush();

    const s = await readSearchStats(engine, { days: 7 });
    expect(s.intent_distribution.entity).toBe(2);
    expect(s.intent_distribution.temporal).toBe(1);
    expect(s.mode_distribution.conservative).toBe(2);
    expect(s.mode_distribution.tokenmax).toBe(1);
  });

  test('days window clamps to [1, 365]', async () => {
    const a = await readSearchStats(engine, { days: 0 });
    expect(a.window_days).toBe(1);
    const b = await readSearchStats(engine, { days: 9999 });
    expect(b.window_days).toBe(365);
    const c = await readSearchStats(engine, {});
    expect(c.window_days).toBe(7); // default
  });

  test('missing search_telemetry table → empty stats (graceful)', async () => {
    // Drop the table to simulate a pre-v0.32.3 brain.
    await engine.executeRaw('DROP TABLE IF EXISTS search_telemetry');
    const s = await readSearchStats(engine, { days: 7 });
    expect(s.total_calls).toBe(0);
    expect(s.cache_hit_rate).toBe(0);
    // Restore for subsequent tests in this describe block.
    await engine.initSchema();
  });
});
