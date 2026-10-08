/**
 * #6278 (v220) on Postgres: the `preparation_attempts` column on a fresh
 * install and on an upgraded brain holding queued, running, failed and
 * compacted requests. PGLite twin: test/persistence-preparation-attempts-migration.test.ts.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { assertFreshPreparationAttemptsColumn, assertUpgradedPreparationAttemptsColumn } from '../helpers/preparation-attempts-migration.ts';

let engine: PostgresEngine;
let close: () => Promise<void>;

describe.skipIf(!hasDatabase())('persistence_requests.preparation_attempts (Postgres)', () => {
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
  }, 120_000);
  afterAll(async () => { await close?.(); });

  test('a fresh install has the column with its default and check', async () => {
    await assertFreshPreparationAttemptsColumn(engine);
  }, 30_000);

  test('an upgraded brain gains the column with 0 on every existing request', async () => {
    await assertUpgradedPreparationAttemptsColumn(engine);
  }, 60_000);
});
