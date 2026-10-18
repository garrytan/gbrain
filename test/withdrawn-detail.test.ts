/**
 * `fact_withdrawn` refusals carry a typed `withdrawn` object (PGLite).
 * Scenarios: test/helpers/withdrawn-detail-scenarios.ts; the Postgres twin is
 * test/e2e/withdrawn-detail-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { detailOnEverySurface, hiddenBackingOmitsDetail, mostSpecificSubjectFirst, receiptKeepsDetail,
  singleWriterSameRule } from './helpers/withdrawn-detail-scenarios.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { resetGateway(); await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
});

describe('fact_withdrawn refusals carry the withdrawal', () => {
  test('one identical object on stdio, HTTP, local and batch refusals', () => detailOnEverySurface(engine));
  test('the most specific subject first, then the newest', () => mostSpecificSubjectFirst(engine));
  test('no object when the caller cannot read the withdrawn rows', () => hiddenBackingOmitsDetail(engine));
  test('a failed receipt keeps the object for get_write_request and replay', () => receiptKeepsDetail(engine));
  test('the single-fact writer applies the same rule; a purge supplies no object', () => singleWriterSameRule(engine));
});
