/**
 * T7 — rank-1 score drift telemetry. Records search calls with rank-1 scores,
 * flushes, and reads back the aggregate (avg + buckets) from search_telemetry.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { getTelemetryWriter, readSearchStats, recordSearchTelemetry, _resetTelemetryWriterForTest } from '../../src/core/search/telemetry.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { _resetTelemetryWriterForTest(); await engine.disconnect(); });
beforeEach(async () => {
  _resetTelemetryWriterForTest();
  await engine.executeRaw('DELETE FROM search_telemetry');
});

const meta: HybridSearchMeta = { mode: 'balanced', intent: 'general' } as HybridSearchMeta;

describe('rank-1 score telemetry', () => {
  test('records mean + bucket distribution and reads them back', async () => {
    recordSearchTelemetry(engine, meta, { results_count: 5, rank1_score: 0.95 }); // high
    recordSearchTelemetry(engine, meta, { results_count: 3, rank1_score: 0.70 }); // solid
    recordSearchTelemetry(engine, meta, { results_count: 1, rank1_score: 0.40 }); // lt_solid
    await getTelemetryWriter().flush();

    const stats = await readSearchStats(engine, { days: 1 });
    expect(stats.rank1_count).toBe(3);
    expect(stats.avg_rank1_score).toBeCloseTo((0.95 + 0.70 + 0.40) / 3, 5);
    expect(stats.rank1_distribution).toEqual({ lt_solid: 1, solid: 1, high: 1 });
  });

  test('queries with no result (no rank1_score) do not pollute the average', async () => {
    recordSearchTelemetry(engine, meta, { results_count: 0 }); // no rank1
    recordSearchTelemetry(engine, meta, { results_count: 2, rank1_score: 0.88 });
    await getTelemetryWriter().flush();

    const stats = await readSearchStats(engine, { days: 1 });
    expect(stats.total_calls).toBe(2);
    expect(stats.rank1_count).toBe(1); // only the one with a result
    expect(stats.avg_rank1_score).toBeCloseTo(0.88, 5);
    expect(stats.rank1_distribution.high).toBe(1);
  });

  test('empty window → null avg, zero buckets (no NaN)', async () => {
    const stats = await readSearchStats(engine, { days: 1 });
    expect(stats.avg_rank1_score).toBeNull();
    expect(stats.rank1_count).toBe(0);
    expect(stats.rank1_distribution).toEqual({ lt_solid: 0, solid: 0, high: 0 });
  });
});
