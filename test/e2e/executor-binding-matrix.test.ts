/**
 * E5 executor binding matrix on real Postgres (refactor wave 1, EO20).
 *
 * The same case table as test/executor-binding-matrix.test.ts (PGLite), run
 * through `engine.executeRaw` against DATABASE_URL. scripts/run-e2e.sh runs
 * this file once per Postgres backend listed in scripts/e2e-backend-matrix.txt:
 * direct Postgres, then PgBouncer transaction mode with GBRAIN_TEST_BACKEND=pgbouncer
 * and GBRAIN_PREPARE=false, asserting equal executed-test counts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolvePrepare } from '../../src/core/db.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineExecutorBindingMatrix, engineSqlExecutor, type BindingBackend } from '../helpers/executor-binding-matrix.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const backend = (process.env.GBRAIN_TEST_BACKEND ?? 'postgres-direct') as BindingBackend;
if (backend !== 'postgres-direct' && backend !== 'pgbouncer') {
  throw new Error(`GBRAIN_TEST_BACKEND must be postgres-direct or pgbouncer, got ${backend}`);
}
const describeDb = hasDatabase() ? describe : describe.skip;

describeDb(`executor binding matrix on ${backend}`, () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = await setupDB();
  }, 120_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('the backend prepare mode is explicit: PgBouncer disables prepared statements, direct Postgres does not', () => {
    const prepare = resolvePrepare(process.env.DATABASE_URL!);
    if (backend === 'pgbouncer') expect(prepare).toBe(false);
    else expect(prepare).not.toBe(false);
  });

  defineExecutorBindingMatrix({ backend, getEngine: () => engine });
  defineExecutorBindingMatrix({ backend, getEngine: () => engine, makeExecutor: engineSqlExecutor, executorName: 'engine-sql' });
});
