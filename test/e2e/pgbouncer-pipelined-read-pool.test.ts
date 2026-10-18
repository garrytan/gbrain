/**
 * #6543 (A3): gbrain's read-side pools stop pipelining on a transaction-mode
 * pooler URL (`?prepare=false` or port 6543), which turns pipelining off for
 * every pooled E2E pass, because the PgBouncer lane pins `?prepare=false`.
 * PgBouncer carries pipelined statements correctly (measured: no wrong rows,
 * no cost), so this file keeps pipelined-through-a-pooler coverage: an engine
 * whose URL says `?prepare=false&max_pipeline=100` keeps the driver's
 * pipelining (the user's explicit value wins over A3's default), and
 * statements pipelined on one pooled connection, autocommit and inside a
 * transaction, each read their own rows. A twin without the override pins
 * A3's default (`max_pipeline` 0) through the same pooler.
 *
 * Runs when the CI PgBouncer fixture is configured (GBRAIN_PGBOUNCER_URL +
 * GBRAIN_PGBOUNCER_DIRECT_URL), against a database of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const pooledAdmin = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !(pooled && pooledAdmin)) throw new Error('The pipelined read-pool PgBouncer test requires the configured CI PgBouncer fixture.');
const database = `gbrain_test_pipelined_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const pooledUrl = (query: string) => { const url = new URL(pooled!); url.pathname = `/${database}`; url.search = query; return url.toString(); };

beforeAll(async () => {
  if (!(pooled && pooledAdmin)) return;
  assertSafeE2eDatabaseUrl(pooledAdmin);
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
}, 60_000);

afterAll(async () => {
  if (!(pooled && pooledAdmin)) return;
  const admin = postgres(pooledAdmin, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
});

/** Statements waiting in the pool for a connection: 0 when the one connection took them all (pipelined). */
const queuedInPool = (sql: unknown): number => (sql as { pool: { queued: number } }).pool.queued;

async function withEngine<T>(query: string, run: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const url = pooledUrl(query);
  assertSafeE2eDatabaseUrl(url);
  return withEnv({ PGMAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined, GBRAIN_DISABLE_DIRECT_POOL: '1' }, async () => {
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize: 1 });
    try { return await run(engine.sql); } finally { await engine.disconnect(); }
  });
}

describe.skipIf(!(pooled && pooledAdmin))('#6543 read pool pipelining through transaction-mode PgBouncer', () => {
  test('an explicit ?max_pipeline=100 keeps pipelining on, and pipelined statements each read their own rows (autocommit and in a transaction)', async () => {
    await withEngine('?prepare=false&max_pipeline=100', async sql => {
      expect((sql as unknown as { options: { max_pipeline: number } }).options.max_pipeline).toBe(100);
      // One connection (poolSize 1). With the parameter types known (the first statement described them), 40 statements
      // dispatched at once all go onto that connection, pipelined: none waits in the pool's queue.
      await sql.unsafe('SELECT $1::int AS n', [0]);
      const pending = Array.from({ length: 40 }, (_, i) => sql.unsafe('SELECT $1::int AS n', [i]).execute());
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(queuedInPool(sql)).toBe(0);
      const autocommit = await Promise.all(pending);
      expect(autocommit.map(rows => (rows[0] as unknown as { n: number }).n)).toEqual(Array.from({ length: 40 }, (_, i) => i));
      const inTransaction = await sql.begin(async tx => Promise.all(Array.from({ length: 20 }, (_, i) => tx.unsafe('SELECT $1::text AS who', [`t${i}`]))));
      expect(inTransaction.map(rows => (rows[0] as unknown as { who: string }).who)).toEqual(Array.from({ length: 20 }, (_, i) => `t${i}`));
    });
  }, 60_000);

  test('without the override the same pooled URL reads max_pipeline 0 and still answers every statement', async () => {
    await withEngine('?prepare=false', async sql => {
      expect((sql as unknown as { options: { max_pipeline: number } }).options.max_pipeline).toBe(0);
      await sql.unsafe('SELECT $1::int AS n', [0]);
      const pending = Array.from({ length: 10 }, (_, i) => sql.unsafe('SELECT $1::int AS n', [i]).execute());
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(queuedInPool(sql)).toBeGreaterThan(0);
      const rows = await Promise.all(pending);
      expect(rows.map(r => (r[0] as unknown as { n: number }).n)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    });
  }, 60_000);
});
