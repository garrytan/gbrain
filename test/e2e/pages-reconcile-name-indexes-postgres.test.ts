import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { PAGES_RECONCILE_NAME_INDEXES, v219 } from '../../src/core/schema-migrations/v219-pages-reconcile-name-indexes.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

// #6222/#6254 (fix wave 12, W1.3): v219 builds the reconcile file-claim name
// indexes CONCURRENTLY on Postgres, one statement per call (a multi-statement
// call runs in an implicit transaction, which CONCURRENTLY refuses), drops an
// INVALID leftover and rebuilds it, resumes after a failed second build, and
// runs through a transaction-mode PgBouncer when the CI fixture provides one.

const NAMES = PAGES_RECONCILE_NAME_INDEXES.map(index => index.name);
let engine: PostgresEngine;
let close: () => Promise<void>;

beforeAll(async () => {
  const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
  engine = pg.engine; close = pg.close;
}, 120_000);
afterAll(async () => { await close?.(); });

const states = async () => (await engine.executeRaw<{ name: string; state: string }>(
  `SELECT n.name, CASE WHEN i.indexrelid IS NULL THEN 'missing' WHEN i.indisvalid THEN 'valid' ELSE 'invalid' END AS state
     FROM unnest($1::text[]) WITH ORDINALITY AS n(name, ord) LEFT JOIN pg_index i ON i.indexrelid = to_regclass(n.name) ORDER BY n.ord`, [NAMES]))
  .map(row => row.state);

/** Runs v219 with every reserved-connection statement recorded; `fail` throws instead of running the matching statement. */
async function runV219(fail?: (sql: string) => boolean): Promise<string[]> {
  const statements: string[] = [];
  const reserve = engine.withReservedConnection.bind(engine);
  engine.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(conn => fn({
    executeRaw: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (fail?.(sql)) throw new Error('synthetic interrupted index build');
      return conn.executeRaw(sql, params);
    },
  }))) as PostgresEngine['withReservedConnection'];
  try { await v219.handler!(engine); } finally { engine.withReservedConnection = reserve; }
  return statements;
}

test('initSchema leaves both name indexes valid', async () => {
  expect(await states()).toEqual(['valid', 'valid']);
});

test('v219 builds each index CONCURRENTLY in its own call, with no session SET', async () => {
  for (const name of NAMES) await engine.executeRaw(`DROP INDEX IF EXISTS ${name}`);
  const statements = await runV219();
  expect(statements.map(sql => sql.trim().split(/\s+/).slice(0, 8).join(' '))).toEqual(
    NAMES.map(name => `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON`));
  expect(statements.filter(sql => /^(SET|RESET)\b/i.test(sql.trim()))).toEqual([]);
  expect(await states()).toEqual(['valid', 'valid']);
});

test('an INVALID leftover is dropped and rebuilt; a valid index is left alone', async () => {
  await engine.executeRaw(`UPDATE pg_index SET indisvalid=false WHERE indexrelid='${NAMES[1]}'::regclass`);
  expect(await states()).toEqual(['valid', 'invalid']);
  const statements = await runV219();
  expect(statements.map(sql => sql.trim().split(/\s+/)[6])).toEqual([NAMES[1]]);
  expect(await states()).toEqual(['valid', 'valid']);
});

test('a failed second build leaves the first index valid, and a rerun finishes the second', async () => {
  for (const name of NAMES) await engine.executeRaw(`DROP INDEX IF EXISTS ${name}`);
  await expect(runV219(sql => sql.includes(NAMES[1]!))).rejects.toThrow('synthetic interrupted index build');
  expect(await states()).toEqual(['valid', 'missing']);
  await runV219();
  expect(await states()).toEqual(['valid', 'valid']);
});

const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const pooledAdmin = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !(pooled && pooledAdmin)) throw new Error('v219 pooler coverage requires the configured CI PgBouncer fixture.');
test.skipIf(!pooled || !pooledAdmin)('a fresh schema through a transaction-mode PgBouncer builds both indexes valid', async () => {
  assertSafeE2eDatabaseUrl(pooledAdmin!);
  const name = `gbrain_test_v219_pool_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(pooledAdmin!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(pooled!); url.pathname = `/${name}`;
  const viaPool = new PostgresEngine();
  try {
    await viaPool.connect({ database_url: url.toString(), poolSize: 2 });
    await viaPool.initSchema();
    for (const index of NAMES) await viaPool.executeRaw(`DROP INDEX IF EXISTS ${index}`);
    await v219.handler!(viaPool);
    const rows = await viaPool.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = ANY(ARRAY[to_regclass($1), to_regclass($2)])', NAMES);
    expect(rows.map(row => row.valid)).toEqual([true, true]);
  } finally {
    await viaPool.disconnect();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
  }
}, 180_000);
