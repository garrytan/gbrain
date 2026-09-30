/**
 * Engine-sql transaction atomicity on Postgres (refactor wave 1, EO1 / T-G1).
 *
 * Every migrated domain write performed through the transaction clone that
 * then throws is rolled back, and a concurrent pool read during the
 * transaction does not see it. Runs on direct Postgres and PgBouncer
 * (scripts/e2e-backend-matrix.txt); the second block repeats the cases through
 * `transactionDirect()` on an engine whose dual pool is active, so the
 * transaction runs on the direct pool. PGLite arm: test/engine-sql-transaction.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineRollbackCases } from '../helpers/engine-sql-rollback-cases.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const backend = process.env.GBRAIN_TEST_BACKEND ?? 'postgres-direct';
const describeDb = hasDatabase() ? describe : describe.skip;

/**
 * The direct (session) URL of the database under test. On the PgBouncer pass
 * DATABASE_URL is the pooler, so the direct server comes from
 * GBRAIN_PGBOUNCER_DIRECT_URL with the pooled URL's database name.
 */
function directUrlOfTestDatabase(): string {
  const url = process.env.DATABASE_URL!;
  if (backend !== 'pgbouncer') return url;
  const admin = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
  if (!admin) throw new Error('PgBouncer pass needs GBRAIN_PGBOUNCER_DIRECT_URL (direct server of the pooled database)');
  const direct = new URL(admin);
  direct.pathname = new URL(url).pathname;
  return direct.toString();
}

describeDb(`engine-sql write-then-throw rollback [${backend}]`, () => {
  let engine: PostgresEngine;
  let dual: PostgresEngine;
  let savedDirect: string | undefined;

  beforeAll(async () => {
    engine = await setupDB();
    savedDirect = process.env.GBRAIN_DIRECT_DATABASE_URL;
    process.env.GBRAIN_DIRECT_DATABASE_URL = directUrlOfTestDatabase();
    dual = new PostgresEngine();
    await dual.connect({ engine: 'postgres', database_url: process.env.DATABASE_URL!, poolSize: 2 });
  }, 120_000);

  afterAll(async () => {
    if (savedDirect === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
    else process.env.GBRAIN_DIRECT_DATABASE_URL = savedDirect;
    await dual?.disconnect();
    await teardownDB();
  });

  describe('engine.transaction() on the shared pool', () => {
    defineRollbackCases({ getEngine: () => engine, entryPoints: ['transaction', 'transactionDirect'], concurrentPoolRead: true });
  });

  describe('engine.transactionDirect() under an active dual pool', () => {
    test('the dual pool is active, so transactionDirect runs on the direct pool', () => {
      expect(dual.connectionManager?.isDualPoolActive()).toBe(true);
    });
    defineRollbackCases({ getEngine: () => dual, entryPoints: ['transactionDirect'], concurrentPoolRead: true });
  });
});
