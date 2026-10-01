import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { EMBEDDED_HASH_STATISTICS_SQL, verifyEmbeddedHashStatistics } from '../../src/core/search/embedded-hash-statistics.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';

const describeDb = hasDatabase() ? describe : describe.skip;

describeDb('search planner selectivity on PostgreSQL', () => {
  const schema = `search_planner_${randomUUID().replaceAll('-', '')}`;
  let sql: ReturnType<typeof postgres>;
  const engine = {
    executeRaw: async (query: string, params: unknown[] = []) => sql.unsafe(query, params as never[]),
  } as Pick<BrainEngine, 'executeRaw'>;

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    await sql.unsafe(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public;
      CREATE TABLE content_chunks(id integer, embedded_text_hash text, chunk_text text);
      INSERT INTO content_chunks SELECT i, md5('chunk ' || i), 'chunk ' || i FROM generate_series(1, 10000) i;
      CREATE TABLE pages(title text);
      INSERT INTO pages SELECT CASE WHEN i = 1 THEN 'selectivityneedle' ELSE 'ordinary title' END
        FROM generate_series(1, 10000) i;`);
  }, 30_000);
  afterAll(async () => {
    if (!sql) return;
    try { await sql.unsafe(`RESET search_path; DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await sql.end(); }
  });

  test('the unforced planner estimates the measured current-hash population after repeated maintenance', async () => {
    for (let i = 0; i < 2; i++) {
      await sql.unsafe(EMBEDDED_HASH_STATISTICS_SQL);
      await verifyEmbeddedHashStatistics(engine);
      const rows = await sql.unsafe(`EXPLAIN (FORMAT JSON) SELECT * FROM content_chunks cc
        WHERE ((cc.embedded_text_hash = md5(cc.chunk_text)) IS TRUE OR cc.embedded_text_hash IS NULL)`);
      expect(rows[0]['QUERY PLAN'][0].Plan['Plan Rows']).toBe(10000);
    }
  });

  test('the title expression index serves the safe-chunks title predicate without planner forcing', async () => {
    for (let i = 0; i < 2; i++) {
      await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_title_fts_english
        ON pages USING gin (to_tsvector('english', COALESCE(title, '')))`);
    }
    await sql.unsafe('ANALYZE pages');
    const query = `SELECT * FROM pages p WHERE to_tsvector('english', COALESCE(p.title, ''))
      @@ websearch_to_tsquery('english', 'selectivityneedle')`;
    expect(await sql.unsafe(query)).toHaveLength(1);
    const rows = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${query}`);
    expect(JSON.stringify(rows[0]['QUERY PLAN'])).toContain('idx_pages_title_fts_english');
  });
});
