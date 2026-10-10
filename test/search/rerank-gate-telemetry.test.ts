/**
 * W3 — rerank gate counters in search_telemetry (reserved rows) and the
 * `rerank_gate` section of `search stats` / `search_stats`.
 *
 * Protects: the gate's eligible, graded, would-skip, provider-call and
 * per-reason counts survive a flush and accumulate across writer processes
 * (two writers flushing the same day add up), ineligible searches are counted
 * by why and not as graded, cache hits add nothing, and the reserved rows
 * never inflate total_calls or the mode/intent distributions.
 * Fails when: the writer drops the counters, the reader folds reserved rows
 * into the search totals, or would_skip_rate is computed over the wrong base.
 * Seams: `_resetTelemetryWriterForTest` stands in for a second process;
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  _resetTelemetryWriterForTest,
  getTelemetryWriter,
  readSearchStats,
  recordSearchTelemetry,
} from '../../src/core/search/telemetry.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

type Gate = NonNullable<HybridSearchMeta['rerank_gate']>;
const meta = (rerank_gate?: Gate, extra: Partial<HybridSearchMeta> = {}): HybridSearchMeta => ({
  vector_enabled: true, detail_resolved: null, expansion_applied: false, intent: 'general', mode: 'balanced',
  ...(rerank_gate ? { rerank_gate } : {}), ...extra,
});
const strongVector: Gate = { mode: 'shadow', eligible: true, grade: 'strong', reason: 'high_vector_match', top_cosine: 0.93, gap: 0.2, candidates: 12, would_skip: true, provider_called: true };
const gapMiss: Gate = { mode: 'shadow', eligible: true, grade: 'not_strong', reason: 'gap_below_min', top_cosine: 0.9, gap: 0.01, candidates: 12, would_skip: false, provider_called: true };
const titleOnly: Gate = { mode: 'shadow', eligible: true, grade: 'strong', reason: 'exact_lookup', candidates: 3, would_skip: false, skip_blocked: 'shadow_only_reason', provider_called: true };
const noKey: Gate = { ...strongVector, provider_called: false };
const off: Gate = { mode: 'shadow', eligible: false, ineligible_reason: 'reranker_off', candidates: 4, would_skip: false, provider_called: false };
const gatedSkip: Gate = { ...strongVector, mode: 'on', skipped: true, provider_called: false };

async function flushFrom(engine: BrainEngine, metas: HybridSearchMeta[]): Promise<void> {
  _resetTelemetryWriterForTest();
  for (const m of metas) recordSearchTelemetry(engine, m, { results_count: 3 });
  await getTelemetryWriter().flush();
}

for (const backend of testBackends()) {
  describe(`${backend}: rerank gate telemetry`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => {};
    beforeAll(async () => {
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      }
    }, 120_000);
    afterAll(async () => { _resetTelemetryWriterForTest(); await close(); });
    beforeEach(async () => { _resetTelemetryWriterForTest(); await engine.executeRaw('DELETE FROM search_telemetry'); });

    test('two writers accumulate gate counters; search totals count searches only', async () => {
      await flushFrom(engine, [meta(strongVector), meta(gapMiss), meta(titleOnly), meta()]);
      await flushFrom(engine, [meta(strongVector), meta(noKey), meta(off)]);
      const stats = await readSearchStats(engine, { days: 1 });
      expect(stats.total_calls).toBe(7);
      expect(stats.mode_distribution).toEqual({ balanced: 7 });
      expect(stats.intent_distribution).toEqual({ general: 7 });
      expect(stats.rerank_gate).toEqual({
        eligible: 5,
        graded: 5,
        would_skip: 3,
        would_skip_rate: 3 / 5,
        skipped: 0,
        provider_calls: 4,
        by_reason: { high_vector_match: 3, gap_below_min: 1, exact_lookup: 1 },
        ineligible: { reranker_off: 1 },
      });
    });

    test('cache hits replay a stored decision and add no gate counts', async () => {
      await flushFrom(engine, [meta(strongVector, { cache: { status: 'hit', similarity: 0.99 } })]);
      const stats = await readSearchStats(engine, { days: 1 });
      expect(stats.total_calls).toBe(1);
      expect(stats.rerank_gate.graded).toBe(0);
    });

    test('a gate-off window reads an empty section', async () => {
      await flushFrom(engine, [meta(), meta()]);
      const stats = await readSearchStats(engine, { days: 1 });
      expect(stats.rerank_gate).toEqual({ eligible: 0, graded: 0, would_skip: 0, would_skip_rate: 0, skipped: 0, provider_calls: 0, by_reason: {}, ineligible: {} });
    });

    test('gate on: a skip counts as would_skip and skipped with no provider call', async () => {
      await flushFrom(engine, [meta(gatedSkip), meta(gatedSkip), meta({ ...gapMiss, mode: 'on' })]);
      const stats = await readSearchStats(engine, { days: 1 });
      expect(stats.total_calls).toBe(3);
      expect(stats.rerank_gate).toMatchObject({ graded: 3, would_skip: 2, skipped: 2, provider_calls: 1 });
    });
  });
}
