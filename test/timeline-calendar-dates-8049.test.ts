/** #8049: reject invalid timeline dates before SQL can poison a caller's transaction. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) describe(`timeline calendar dates #8049 (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'pglite') {
      const local = new PGLiteEngine();
      await local.connect({}); await local.initSchema(); engine = local;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
    await engine.putPage('notes/calendar', { title: 'Calendar', type: 'note', compiled_truth: 'Calendar fixture.', timeline: '', frontmatter: {} });
  }, 120_000);
  afterAll(async () => { if (closePostgres) await closePostgres(); else await engine.disconnect(); });

  test('single and mixed batch refusals leave the transaction usable and insert no prefix', async () => {
    for (const date of ['2026-02-30', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '2026-1-01']) {
      await engine.transaction(async tx => {
        await expect(tx.addTimelineEntry('notes/calendar', { date, summary: 'Invalid date.' })).rejects.toMatchObject({ code: 'invalid_params' });
        await expect(tx.addTimelineEntriesBatch([
          { slug: 'notes/calendar', date: '2024-02-29', source: 'test', summary: 'Must not insert a prefix.' },
          { slug: 'notes/calendar', date, source: 'test', summary: 'Invalid date.' },
        ])).rejects.toMatchObject({ code: 'invalid_params' });
        expect(await tx.getTimeline('notes/calendar', { sourceId: 'default' })).toEqual([]);
      });
    }
  });

  test('valid leap, early historical and year-end dates retain exact days and deduplication', async () => {
    for (const date of ['0001-01-01', '0096-02-29', '2000-02-29', '2024-02-29', '2026-12-31']) {
      const entry = { date, source: 'test', summary: `Valid day ${date}.` };
      expect(await engine.addTimelineEntry('notes/calendar', entry)).toBe(true);
      expect(await engine.addTimelineEntriesBatch([{ slug: 'notes/calendar', ...entry }])).toBe(0);
    }
    const rows = await engine.executeRaw<{ date: string }>(`SELECT date::text AS date FROM timeline_entries ORDER BY date`);
    expect(rows.map(row => row.date)).toEqual(['0001-01-01', '0096-02-29', '2000-02-29', '2024-02-29', '2026-12-31']);
  });
});
