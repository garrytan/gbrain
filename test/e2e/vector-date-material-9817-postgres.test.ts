/**
 * GST-4006 / #9817 on Postgres: `searchVector` reads the brain's chunk estimate (pg_class reltuples, cached) only for a
 * date-bounded search, and its pooled attempts turn materialization off only when that estimate reaches
 * DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS. enable_sort stays with the index walk (#10507).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as vectorSettings from '../../src/core/search/vector-settings.ts';
import { BRAIN_CHUNK_ESTIMATE_SQL, DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS } from '../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { column, seedVectorWalkFixture, vec } from '../helpers/vector-index-walk-fixture.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('#9817 date-bound materialization on Postgres', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await seedVectorWalkFixture(engine);
  }, 120_000);
  afterAll(async () => { await close?.(); });

  /** The settings every vector attempt of one search applied, with the brain estimate the engine read. */
  const attempts = async (opts: SearchOpts, chunks: number) => {
    const applied: Array<Record<string, string>> = [];
    let estimates = 0;
    const original = vectorSettings.vectorScanSettings;
    const settings = spyOn(vectorSettings, 'vectorScanSettings').mockImplementation((...args) => { const value = original(...args); applied.push(value); return value; });
    const engineWithEstimate = engine as unknown as { brainChunkEstimate: () => number | undefined };
    const saved = engineWithEstimate.brainChunkEstimate;
    engineWithEstimate.brainChunkEstimate = () => { estimates++; return chunks; };
    try { await engine.searchVector(vec(11), { limit: 20, embeddingColumn: column, ...opts }); }
    finally { settings.mockRestore(); engineWithEstimate.brainChunkEstimate = saved; }
    return { applied, estimates };
  };

  test('the estimate is the catalog row count, never a count of the table', async () => {
    expect(BRAIN_CHUNK_ESTIMATE_SQL).not.toMatch(/count\(/i);
    await engine.executeRaw('ANALYZE content_chunks');
    const [row] = await engine.executeRaw<{ chunks: number }>(BRAIN_CHUNK_ESTIMATE_SQL);
    const [real] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks');
    expect(Number(row!.chunks)).toBe(Number(real!.n));
  });

  test('a date bound at or above the threshold turns materialization off on every pooled attempt and leaves sorting alone', async () => {
    for (const opts of [{ afterDate: '2000-01-01' }, { afterDate: '2000-01-01', type: 'note' }] as SearchOpts[]) {
      const { applied, estimates } = await attempts(opts, DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS);
      expect(estimates).toBe(1);
      expect(applied.length).toBeGreaterThan(0);
      for (const settings of applied) {
        expect(settings.enable_material).toBe('off');
        expect(settings.enable_sort).toBeUndefined();
      }
    }
  }, 60_000);

  test('below the threshold, or with no date bound, the attempts keep the planner\'s plan; only a date bound reads the estimate', async () => {
    const below = await attempts({ afterDate: '2000-01-01' }, DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS - 1);
    expect(below.estimates).toBe(1);
    for (const settings of below.applied) expect(settings.enable_material).toBeUndefined();
    const typed = await attempts({ type: 'note' }, DATE_FILTER_MATERIAL_OFF_MIN_CHUNKS * 4);
    expect(typed.estimates).toBe(0);
    for (const settings of typed.applied) { expect(settings.enable_material).toBeUndefined(); expect(settings.enable_sort).toBeUndefined(); }
  }, 60_000);

  test('a dated search refreshes the estimate in the background on the pool, never inside the caller\'s transaction', async () => {
    const refreshes: Array<boolean> = [];
    const engineWithEstimate = engine as unknown as { brainChunkEstimate: (refresh?: () => Promise<unknown>) => number | undefined };
    const saved = engineWithEstimate.brainChunkEstimate;
    engineWithEstimate.brainChunkEstimate = refresh => { refreshes.push(refresh !== undefined); return undefined; };
    try {
      await engine.searchVector(vec(11), { limit: 5, embeddingColumn: column, afterDate: '2000-01-01' });
      await engine.transaction(async tx => {
        await tx.searchVector(vec(11), { limit: 5, embeddingColumn: column, afterDate: '2000-01-01' });
        expect(await tx.executeRaw<{ ok: number }>('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
      });
    } finally { engineWithEstimate.brainChunkEstimate = saved; }
    expect(refreshes).toEqual([true, false]);
  }, 60_000);
});
