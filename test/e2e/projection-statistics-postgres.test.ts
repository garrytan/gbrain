import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { currentTextProjectionFilter } from '../../src/core/search/safe-chunks.ts';
import { PROJECTION_STATISTICS_SQL, verifyProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';

const describeDb = hasDatabase() ? describe : describe.skip;

describeDb('projection planner statistics with PostgreSQL runtime roles', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `projection_stats_${suffix}`;
  const owner = `projection_owner_${suffix}`;
  const reader = `projection_reader_${suffix}`;
  let sql: ReturnType<typeof postgres>;
  const engine = {
    executeRaw: async (query: string, params: unknown[] = []) => sql.unsafe(query, params as never[]),
  } as unknown as Pick<BrainEngine, 'executeRaw'>;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL!;
    assertSafeE2eDatabaseUrl(url);
    sql = postgres(url, { max: 1 });
    await sql.unsafe(`CREATE ROLE ${owner}; CREATE ROLE ${reader}; CREATE SCHEMA ${schema} AUTHORIZATION ${owner};
      SET search_path TO ${schema}, public;
      CREATE TABLE pages(id integer PRIMARY KEY, source_id text, text_projection_revision uuid, knowledge_revision uuid);
      ALTER TABLE pages OWNER TO ${owner};
      INSERT INTO pages SELECT i, CASE WHEN i <= 1000 THEN 'visible' ELSE 'other' END,
        '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001'
        FROM generate_series(1, 10000) i;
      SET ROLE ${owner};
      ${PROJECTION_STATISTICS_SQL}
      RESET ROLE;
      GRANT USAGE ON SCHEMA ${schema} TO ${reader};
      GRANT SELECT ON pages TO ${reader};`);
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    try {
      await sql.unsafe(`RESET ROLE; RESET search_path; DROP SCHEMA IF EXISTS ${schema} CASCADE;
        DROP ROLE IF EXISTS ${reader}; DROP ROLE IF EXISTS ${owner}`);
    } finally { await sql.end(); }
  }, 30_000);

  test('table-owner maintenance verifies sampled expression statistics', async () => {
    await sql.unsafe(`SET ROLE ${owner}`);
    try { await verifyProjectionStatistics(engine); }
    finally { await sql.unsafe('RESET ROLE'); }
  });

  test('the normal planner uses the measured estimate for a non-owner reader', async () => {
    await sql.unsafe(`SET ROLE ${reader}`);
    try {
      const result = await sql.unsafe(`EXPLAIN (FORMAT JSON) SELECT * FROM pages p WHERE ${currentTextProjectionFilter('p')}`);
      expect(result[0]['QUERY PLAN'][0].Plan['Plan Rows']).toBe(10000);
    } finally { await sql.unsafe('RESET ROLE'); }
  });

  test('forced row security keeps scoped reads correct without claiming hidden statistics are absent', async () => {
    await sql.unsafe(`ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
      ALTER TABLE pages FORCE ROW LEVEL SECURITY;
      CREATE POLICY visible_pages ON pages USING (source_id = 'visible')`);
    try {
      for (const role of [reader, owner]) {
        await sql.unsafe(`SET ROLE ${role}`);
        try {
          const rows = await sql.unsafe(`SELECT count(*)::int AS count FROM pages p WHERE ${currentTextProjectionFilter('p')}`);
          expect(rows[0].count).toBe(1000);
          await expect(verifyProjectionStatistics(engine)).rejects.toThrow('row-security policy');
        } finally { await sql.unsafe('RESET ROLE'); }
      }
      await verifyProjectionStatistics(engine);
    } finally {
      await sql.unsafe('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
    }
  });
});
