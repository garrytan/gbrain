/**
 * Vendored driver (vendor/postgres): a prepared statement the server rejects as stale ("cached plan must not
 * change result type") is re-run by the driver. When a describe-first statement was sent after it on the same
 * connection, that statement writes its Bind/Execute only once the server answers its Describe, so a retry
 * written at once landed between the two halves and every later response was read for the wrong query: rows
 * built with another statement's columns, or a DataRow read before any column list (a TypeError). The retry
 * now waits for that statement.
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('vendored driver: a stale-plan retry and a describe-first statement on one connection', () => {
  test('each query reads its own rows across 100 retries pipelined behind describe-first statements', async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const wide = `driver_retry_wide_${suffix}`, narrow = `driver_retry_narrow_${suffix}`;
    try {
      await sql.unsafe(`CREATE TABLE ${wide} (a int); CREATE TABLE ${narrow} (slug text, k text);
        INSERT INTO ${wide} VALUES (1); INSERT INTO ${narrow} VALUES ('seed', 'x')`);
      for (let i = 0; i < 100; i++) {
        await sql.unsafe(`SELECT * FROM ${wide} WHERE a = $1`, [1], { prepare: true });
        await sql.unsafe(`ALTER TABLE ${wide} ADD COLUMN c${i} int`);
        const [stale, first, second] = await Promise.all([
          sql.unsafe(`SELECT * FROM ${wide} WHERE a = $1`, [1], { prepare: true }),
          sql.unsafe(`SELECT slug FROM ${narrow} WHERE k = $1 AND ${i} >= 0`, ['x'], { prepare: true }),
          sql.unsafe(`SELECT slug FROM ${narrow} WHERE k = $1 AND ${i} >= 0`, ['x'], { prepare: true }),
        ]);
        expect(Object.keys(stale[0]!)).toHaveLength(i + 2);
        expect(first.map(row => row.slug)).toEqual(['seed']);
        expect(first.map(row => Object.keys(row))).toEqual([['slug']]);
        expect(second.map(row => row.slug)).toEqual(['seed']);
        expect(second.map(row => Object.keys(row))).toEqual([['slug']]);
      }
    } finally {
      await sql.unsafe(`DROP TABLE IF EXISTS ${wide}; DROP TABLE IF EXISTS ${narrow}`).catch(() => {});
      await sql.end();
    }
  }, 120_000);
});
