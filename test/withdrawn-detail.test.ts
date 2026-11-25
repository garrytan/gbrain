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
import { detailOnEverySurface, hiddenBackingOmitsDetail, mostSpecificSubjectFirst, receiptKeepsDetail, storedDetailStaysLocal,
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
  test('the object on local refusals only; stdio, HTTP and batch refusals carry none', () => detailOnEverySurface(engine));
  test('the most specific subject first, then the newest', () => mostSpecificSubjectFirst(engine));
  test('a remote refusal is byte-identical whether the withdrawn rows are hidden, visible or absent', () => hiddenBackingOmitsDetail(engine));
  test('a remote failed receipt carries no object in get_write_request or replay', () => receiptKeepsDetail(engine));
  test('a stored withdrawal detail reaches a trusted local reader only', () => storedDetailStaysLocal(engine));
  test('the single-fact writer applies the same rule; a purge supplies no object', () => singleWriterSameRule(engine));
});
