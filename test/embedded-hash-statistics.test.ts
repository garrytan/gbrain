import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { BrainEngine } from '../src/core/engine.ts';
import { EMBEDDED_HASH_STATISTICS_SQL, verifyEmbeddedHashStatistics } from '../src/core/search/embedded-hash-statistics.ts';

describe('embedded-hash planner statistics', () => {
  let db: PGlite;
  const engine = {
    executeRaw: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
  } as Pick<BrainEngine, 'executeRaw'>;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE content_chunks(id integer, embedded_text_hash text, chunk_text text);
      INSERT INTO content_chunks SELECT i, md5('chunk ' || i), 'chunk ' || i FROM generate_series(1, 10000) i;`);
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  test('statistics replace the default equality estimate and are idempotent', async () => {
    for (let i = 0; i < 2; i++) {
      await db.exec(EMBEDDED_HASH_STATISTICS_SQL);
      await verifyEmbeddedHashStatistics(engine);
      const result = await db.query<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
        `EXPLAIN (FORMAT JSON) SELECT * FROM content_chunks cc
         WHERE ((cc.embedded_text_hash = md5(cc.chunk_text)) IS TRUE OR cc.embedded_text_hash IS NULL)`,
      );
      expect(result.rows[0]['QUERY PLAN'][0].Plan['Plan Rows']).toBe(10000);
    }
  });

  test('current and legacy NULL hashes pass while stale hashes remain excluded', async () => {
    const result = await db.query<{ id: number }>(`SELECT id FROM (VALUES
      (1, md5('current'), 'current'), (2, NULL, 'legacy'), (3, md5('old'), 'new')
    ) cc(id, embedded_text_hash, chunk_text)
    WHERE ((cc.embedded_text_hash = md5(cc.chunk_text)) IS TRUE OR cc.embedded_text_hash IS NULL)`);
    expect(result.rows.map(row => row.id)).toEqual([1, 2]);
  });

  test('missing objects, wrong definitions and uncollected samples are rejected', async () => {
    await db.exec('DROP STATISTICS content_chunks_embedded_hash_current_stats');
    await expect(verifyEmbeddedHashStatistics(engine)).rejects.toThrow('missing');
    await db.exec(`CREATE STATISTICS content_chunks_embedded_hash_current_stats
      ON ((embedded_text_hash IS NULL)) FROM content_chunks; ANALYZE content_chunks;`);
    await expect(verifyEmbeddedHashStatistics(engine)).rejects.toThrow('wrong definition');
    await db.exec(`DROP STATISTICS content_chunks_embedded_hash_current_stats;
      CREATE STATISTICS content_chunks_embedded_hash_current_stats
      ON ((embedded_text_hash = md5(chunk_text))) FROM content_chunks;`);
    await expect(verifyEmbeddedHashStatistics(engine)).rejects.toThrow('not been collected');
  });

  test('empty-table statistics are valid', async () => {
    await db.exec('TRUNCATE content_chunks');
    await db.exec(EMBEDDED_HASH_STATISTICS_SQL);
    await verifyEmbeddedHashStatistics(engine);
  });
});
