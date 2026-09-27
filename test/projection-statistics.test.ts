import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { currentTextProjectionFilter } from '../src/core/search/safe-chunks.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PROJECTION_STATISTICS_SQL, refreshProjectionStatistics, verifyProjectionStatistics } from '../src/core/search/projection-statistics.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

function fixtureEngine(db: Pick<PGlite, 'query'> & Partial<Pick<PGlite, 'transaction'>>): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
    transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => db.transaction
      ? db.transaction(tx => fn(fixtureEngine(tx)))
      : fn(fixtureEngine(db)),
  } as unknown as BrainEngine;
}

describe('current projection planner estimates', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE pages (
      id integer PRIMARY KEY,
      text_projection_revision uuid,
      knowledge_revision uuid
    );
    INSERT INTO pages
      SELECT i, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001'
      FROM generate_series(1, 10000) i;
    CREATE STATISTICS pages_text_projection_current_stats
      ON ((text_projection_revision = knowledge_revision)) FROM pages;
    ANALYZE pages(text_projection_revision, knowledge_revision);`);
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  test('the shared read predicate uses the measured current-page population', async () => {
    const result = await db.query<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
      `EXPLAIN (FORMAT JSON) SELECT * FROM pages p WHERE ${currentTextProjectionFilter('p')}`,
    );
    expect(result.rows[0]['QUERY PLAN'][0].Plan['Plan Rows']).toBe(10000);
  });

  test('NULL and stale revisions remain excluded', async () => {
    const result = await db.query<{ id: number }>(`SELECT id FROM (VALUES
      (1, '00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000001'::uuid),
      (2, '00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid),
      (3, NULL::uuid, '00000000-0000-0000-0000-000000000001'::uuid),
      (4, '00000000-0000-0000-0000-000000000001'::uuid, NULL::uuid),
      (5, NULL::uuid, NULL::uuid)
    ) p(id, text_projection_revision, knowledge_revision)
    WHERE ${currentTextProjectionFilter('p')}`);
    expect(result.rows.map(row => row.id)).toEqual([1]);
  });

  test('statistics follow large readiness changes instead of a fixed selectivity guess', async () => {
    const engine = fixtureEngine(db);
    for (const count of [1000, 100, 20, 0, 10000]) {
      await db.query(`UPDATE pages SET text_projection_revision =
        CASE WHEN id <= $1 THEN knowledge_revision ELSE NULL END`, [count]);
      expect(await refreshProjectionStatistics(engine)).toBe(true);
      const result = await db.query<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
        `EXPLAIN (FORMAT JSON) SELECT * FROM pages p WHERE ${currentTextProjectionFilter('p')}`,
      );
      expect(result.rows[0]['QUERY PLAN'][0].Plan['Plan Rows']).toBe(Math.max(count, 1));
    }
  });
});

describe('projection statistics migration postconditions', () => {
  test('empty initialization and later population both collect valid statistics', async () => {
    const db = new PGlite();
    try {
      const engine = fixtureEngine(db);
      await db.exec('CREATE TABLE pages(text_projection_revision uuid, knowledge_revision uuid)');
      await db.exec(PROJECTION_STATISTICS_SQL);
      await verifyProjectionStatistics(engine);
      await db.exec(PROJECTION_STATISTICS_SQL);
      await verifyProjectionStatistics(engine);
      await db.exec(`INSERT INTO pages SELECT NULL, '00000000-0000-0000-0000-000000000001'::uuid
        FROM generate_series(1, 1000)`);
      expect(await refreshProjectionStatistics(engine)).toBe(true);
      await verifyProjectionStatistics(engine);
    } finally { await db.close(); }
  }, 30_000);

  test('an object with the expected name but wrong expression is not certified', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE pages(text_projection_revision uuid, knowledge_revision uuid);
        CREATE STATISTICS pages_text_projection_current_stats ON ((knowledge_revision IS NULL)) FROM pages;
        ANALYZE pages;`);
      await expect(verifyProjectionStatistics(fixtureEngine(db))).rejects.toThrow('wrong definition');
    } finally { await db.close(); }
  }, 30_000);

  test('missing expression samples on a populated table are not certified', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE pages(text_projection_revision uuid, knowledge_revision uuid);
        INSERT INTO pages VALUES (NULL, '00000000-0000-0000-0000-000000000001');
        ANALYZE pages;
        CREATE STATISTICS pages_text_projection_current_stats
          ON ((text_projection_revision = knowledge_revision)) FROM pages;`);
      await expect(verifyProjectionStatistics(fixtureEngine(db))).rejects.toThrow('not been collected');
    } finally { await db.close(); }
  }, 30_000);

});

describe('projection migration ledger verification', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => { await engine?.disconnect(); });

  test('a failed final postcondition never advances the schema version', async () => {
    await engine.executeRaw('DROP STATISTICS pages_text_projection_current_stats');
    await engine.executeRaw('CREATE STATISTICS pages_text_projection_current_stats ON ((knowledge_revision IS NULL)) FROM pages');
    await engine.setConfig('version', '159');
    await expect(runMigrations(engine)).rejects.toThrow('wrong definition');
    expect(await engine.getConfig('version')).toBe('159');
    await engine.executeRaw('DROP STATISTICS pages_text_projection_current_stats');
    await runMigrations(engine);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    await verifyProjectionStatistics(engine);
  }, 60_000);
});
