/**
 * GBRA-75 wave 7: a Postgres brain whose search planner statistics are absent
 * (pg_upgrade, a deleted pg_statistic) plans search as nested loops (50-60 s at
 * 5,000 pages). One test, `missingSearchStatistics`, drives the write-pass skip,
 * the search guard, doctor `planner_stats_stale` and `repair planner-stats`.
 * PGLite stands in for Postgres here (the same catalogs), through an engine
 * that reports kind 'postgres'; test/e2e/search-statistics-guard-postgres.test.ts
 * runs the PostgresEngine guard itself.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  ensureSearchStatistics, missingSearchStatistics, PROJECTION_STATISTICS_NAME, PROJECTION_STATISTICS_SQL,
  refreshProjectionStatistics, SEARCH_STATISTICS_COLUMNS,
} from '../src/core/search/projection-statistics.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { plannerStatsRepair } from '../src/core/repair/planner-stats.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

function postgresLike(db: Pick<PGlite, 'query'> & Partial<Pick<PGlite, 'transaction'>>): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
    getConfig: async () => null,
    transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => db.transaction
      ? db.transaction(tx => fn(postgresLike(tx)))
      : fn(postgresLike(db)),
  } as unknown as BrainEngine;
}

const ALL = Object.entries(SEARCH_STATISTICS_COLUMNS).flatMap(([table, columns]) => columns.map(column => `${table}.${column}`));

describe('missing search planner statistics on Postgres', () => {
  let db: PGlite;
  let engine: BrainEngine;
  const dropStatistics = (table: string, column?: string) => db.query(
    `DELETE FROM pg_statistic WHERE starelid = $1::regclass ${column ? `AND staattnum = (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = '${column}')` : ''}`,
    [table]);

  beforeEach(async () => {
    db = new PGlite();
    engine = postgresLike(db);
    await db.exec(`CREATE TABLE pages (id integer PRIMARY KEY, source_id text, type text, slug text, deleted_at timestamptz,
        text_projection_revision uuid, knowledge_revision uuid);
      CREATE TABLE content_chunks (id integer PRIMARY KEY, page_id integer, model text, modality text);
      CREATE TABLE planner_probe_unused (id integer);
      INSERT INTO pages SELECT i, 'src-' || (i % 8), 'note', 'note-' || i, NULL,
        '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001' FROM generate_series(1, 2000) i;
      INSERT INTO content_chunks SELECT i, 1 + i % 2000, 'voyage:voyage-4', 'text' FROM generate_series(1, 6000) i;
      ANALYZE content_chunks;`);
    await db.exec(PROJECTION_STATISTICS_SQL);
    await db.exec('ANALYZE pages');
  }, 30_000);

  afterEach(async () => { await db?.close(); });

  test('collected statistics: nothing is missing; empty tables are never missing', async () => {
    expect(await missingSearchStatistics(engine)).toEqual([]);
    const empty = new PGlite();
    try {
      await empty.exec(`CREATE TABLE pages (id integer, source_id text, type text, slug text, deleted_at timestamptz,
          text_projection_revision uuid, knowledge_revision uuid);
        CREATE TABLE content_chunks (id integer, page_id integer, model text, modality text);`);
      await empty.exec(PROJECTION_STATISTICS_SQL);
      expect(await missingSearchStatistics(postgresLike(empty))).toEqual([]);
    } finally { await empty.close(); }
  });

  test('deleted statistics are reported per column, and the projection statistics with them', async () => {
    await dropStatistics('pages');
    await db.query("DELETE FROM pg_statistic_ext_data WHERE stxoid = (SELECT oid FROM pg_statistic_ext WHERE stxname = $1)", [PROJECTION_STATISTICS_NAME]);
    await dropStatistics('content_chunks');
    expect(await missingSearchStatistics(engine)).toEqual([...ALL, PROJECTION_STATISTICS_NAME]);
  });

  test('a one-page write pass refreshes when any search column lost its statistics, not only deleted_at', async () => {
    // Base skipped this refresh: its test read only pages.deleted_at and content_chunks.model.
    await dropStatistics('pages', 'source_id');
    expect(await missingSearchStatistics(engine)).toEqual(['pages.source_id']);
    expect(await refreshProjectionStatistics(engine, 1)).toBe(true);
    expect(await missingSearchStatistics(engine)).toEqual([]);
  });

  test('the search guard collects absent statistics through the refresh and reports what was missing', async () => {
    await dropStatistics('pages');
    expect(await ensureSearchStatistics(engine)).toEqual(SEARCH_STATISTICS_COLUMNS.pages.map(c => `pages.${c}`));
    expect(await missingSearchStatistics(engine)).toEqual([]);
    expect(await ensureSearchStatistics(engine)).toEqual([]);
    const [unrelated] = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stats WHERE tablename = 'planner_probe_unused'")).rows;
    expect(unrelated!.n).toBe(0);
  });

  test('doctor warns with a runnable fix; repair planner-stats --apply clears it', async () => {
    const entry = DOCTOR_CHECK_REGISTRY.find(e => e.name === 'planner_stats_stale')!;
    const ctx = { engine, progress: { heartbeat() {}, start() {}, tick() {}, finish() {} } } as unknown as DoctorContext;
    const run = async () => ((await entry.run(ctx)) as Check[])[0]!;
    expect((await run()).status).toBe('ok');

    await dropStatistics('pages', 'deleted_at');
    const warn = await run();
    expect(warn.status).toBe('warn');
    expect(warn.details?.missing_search_statistics).toEqual(['pages.deleted_at']);
    expect(warn.fix).toMatchObject({ argv: ['gbrain', 'repair', 'planner-stats', '--apply'], actor: 'agent', consent: [],
      verify: { argv: ['gbrain', 'doctor', '--only', 'planner_stats_stale', '--json'] } });

    const plan = await plannerStatsRepair.plan(engine, { brain_id: 'host', source_ids: [] }, null);
    expect(plan.items.map(i => i.slug)).toEqual(['search-statistics']);
    expect(await plannerStatsRepair.apply({ engine, logger: { info() {}, warn() {}, error() {} } } as never, plan.items[0]!)).toBe(true);
    expect((await run()).status).toBe('ok');
  });
});
