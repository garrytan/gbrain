/**
 * v223 + v224 on PGLite: a fresh install has the sync watermark index and
 * page_retrievals; an upgraded brain swaps v222's watermark index, copies
 * every pages.last_retrieved_at into page_retrievals (a re-run keeps the newer
 * value), drops the column's unused index and keeps the column. The Postgres
 * twin is test/e2e/serve-loop-migrations-postgres.test.ts.
 */
import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assertFreshServeLoopSchema, assertUpgradedServeLoopSchema } from './helpers/serve-loop-migrations.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('a fresh PGLite install has the sync watermark index and page_retrievals, without the superseded indexes', async () => {
  await assertFreshServeLoopSchema(engine);
}, 30_000);

test('an upgraded PGLite brain gets both migrations, keeps every timestamp, and a re-run changes nothing', async () => {
  await assertUpgradedServeLoopSchema(engine);
}, 60_000);
