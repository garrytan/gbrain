/**
 * v223 + v224 on Postgres: the sync watermark index (built CONCURRENTLY, v222's
 * index dropped CONCURRENTLY) and page_retrievals (timestamps copied, the
 * column's index dropped CONCURRENTLY) on a fresh install and on an upgraded
 * brain. PGLite twin: test/serve-loop-migrations.test.ts.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { assertFreshServeLoopSchema, assertUpgradedServeLoopSchema } from '../helpers/serve-loop-migrations.ts';

let engine: PostgresEngine;
let close: () => Promise<void>;

describe.skipIf(!hasDatabase())('sync watermark index and page_retrievals (Postgres)', () => {
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
  }, 120_000);
  afterAll(async () => { await close?.(); });

  test('a fresh install has the sync watermark index and page_retrievals, without the superseded indexes', async () => {
    await assertFreshServeLoopSchema(engine);
  }, 30_000);

  test('an upgraded brain gets both migrations, keeps every timestamp, and a re-run changes nothing', async () => {
    await assertUpgradedServeLoopSchema(engine);
  }, 60_000);
});
