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
  awaitPendingTelemetryFlush,
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
    // Simulate a pre-v0.32.3 brain by HIDING the table — a rename preserves
    // the full column shape for the tests that follow. (The prior
    // DROP + initSchema() restore was a silent no-op: the migration ledger
    // already records v57, so initSchema never recreated the table.)
    await engine.executeRaw('ALTER TABLE search_telemetry RENAME TO search_telemetry_hidden');
    try {
      const s = await readSearchStats(engine, { days: 7 });
      expect(s.total_calls).toBe(0);
      expect(s.cache_hit_rate).toBe(0);
      expect(s.empty_results).toEqual({ total: 0, by_cause: {} });
    } finally {
      await engine.executeRaw('ALTER TABLE search_telemetry_hidden RENAME TO search_telemetry');
    }
  });
});

// WP2/T3 — empty-result cause rollup. Rides the reserved
// (date, EMPTY_RESULT_MODE, cause) rows with zero new DDL; readSearchStats
// diverts them out of the call/intent/mode aggregates.
describe('empty_result bucket keyed by cause (WP2/T3)', () => {
  test('vector down + empty response → vector_disabled cause', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ vector_enabled: false }), { results_count: 0 });
    await w.flush();
    const s = await readSearchStats(engine, { days: 7 });
    expect(s.empty_results.total).toBe(1);
    expect(s.empty_results.by_cause).toEqual({ vector_disabled: 1 });
  });

  test('budget dropped everything → budget_dropped_all cause (beats vector_disabled)', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(
      engine,
      makeMeta({
        vector_enabled: false,
        token_budget: { budget: 100, used: 0, kept: 0, dropped: 5 },
      }),
      { results_count: 0 },
    );
    await w.flush();
    const s = await readSearchStats(engine, { days: 7 });
    expect(s.empty_results.by_cause).toEqual({ budget_dropped_all: 1 });
  });

  test('degraded budget_dropped_all stage classifies the same way', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(
      engine,
      makeMeta({ degraded: [{ stage: 'budget_dropped_all' }] }),
      { results_count: 0 },
    );
    await w.flush();
    const s = await readSearchStats(engine, { days: 7 });
    expect(s.empty_results.by_cause).toEqual({ budget_dropped_all: 1 });
  });

  test('healthy pipeline + zero hits → keyword_zero cause', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 0 });
    await w.flush();
    const s = await readSearchStats(engine, { days: 7 });
    expect(s.empty_results.by_cause).toEqual({ keyword_zero: 1 });
  });

  test('empty cache HIT (offset artifact) is NOT counted as an empty-result cause', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta({ cache: { status: 'hit' } }), { results_count: 0 });
    await w.flush();
    const s = await readSearchStats(engine, { days: 7 });
    expect(s.empty_results.total).toBe(0);
  });

  test('reserved rows never skew total_calls or the distributions', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    recordSearchTelemetry(engine, makeMeta({ vector_enabled: false }), { results_count: 0 });
    await w.flush();
    const s = await readSearchStats(engine, { days: 7 });
    // Both calls count as calls (the empty one still ran); the reserved
    // cause row does NOT add a third.
    expect(s.total_calls).toBe(2);
    expect(Object.keys(s.mode_distribution)).toEqual(['balanced']);
    expect(Object.keys(s.intent_distribution)).toEqual(['general']);
    expect(s.empty_results.total).toBe(1);
    expect(s.avg_results).toBeCloseTo(2.5, 5); // 5 / 2 calls — reserved row excluded
  });
});

describe('awaitPendingTelemetryFlush (#4143 drain)', () => {
  test('fast path: nothing pending resolves {unfinished: 0} without touching the DB', async () => {
    const r = await awaitPendingTelemetryFlush(50, 'disconnect');
    expect(r).toEqual({ unfinished: 0 });
  });

  test("exit mode flushes residual buckets — BOTH the normal and the empty_result bucket land", async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    // One normal record + one zero-result record (the empty_result cause
    // bucket #4096 added — the second INSERT that turned the flush into the
    // close()-deadlock trigger).
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    recordSearchTelemetry(engine, makeMeta({ vector_enabled: false }), { results_count: 0 });
    expect(w.hasBuffered()).toBe(true);

    const r = await awaitPendingTelemetryFlush(2000, 'exit');
    expect(r).toEqual({ unfinished: 0 });
    expect(w.hasBuffered()).toBe(false);

    const rows = await engine.executeRaw<{ mode: string; intent: string }>(
      'SELECT mode, intent FROM search_telemetry ORDER BY mode',
    );
    expect(rows.length).toBe(2);
    expect(rows.map((x) => x.mode).sort()).toEqual(['balanced', 'empty_result']);
  });

  test('disconnect mode awaits only the in-flight flush and DROPS residual buckets (lossy by design)', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    recordSearchTelemetry(engine, makeMeta(), { results_count: 5 });
    // Kick a flush so it is in flight, then buffer MORE — the post-swap
    // records that a disconnect-mode drain must NOT try to write.
    const inFlight = w.flush();
    recordSearchTelemetry(engine, makeMeta({ intent: 'entity' }), { results_count: 1 });
    expect(w.hasBuffered()).toBe(true);

    const r = await awaitPendingTelemetryFlush(2000, 'disconnect');
    expect(r).toEqual({ unfinished: 0 });
    await inFlight;
    expect(w.pendingFlush()).toBeNull();
    expect(w.hasBuffered()).toBe(true); // residual stays buffered — dropped with the process

    const rows = await engine.executeRaw<{ intent: string }>('SELECT intent FROM search_telemetry');
    expect(rows.map((x) => x.intent)).toEqual(['general']); // only the in-flight write landed
  });

  test('a drain that exceeds its bound reports unfinished instead of hanging', async () => {
    const w = getTelemetryWriter();
    // A flush that never settles (simulated) — the drain must give up at the bound.
    (w as unknown as { flushInFlight: Promise<void> | null }).flushInFlight = new Promise<void>(() => {});
    const started = Date.now();
    const r = await awaitPendingTelemetryFlush(100, 'disconnect');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toEqual({ unfinished: 1 });
    _resetTelemetryWriterForTest(); // clear the poisoned singleton for later cases
  });
});
