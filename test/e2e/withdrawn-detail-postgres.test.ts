/**
 * Postgres twin of test/withdrawn-detail.test.ts: `fact_withdrawn` refusals carry
 * a typed `withdrawn` object. One isolated database per scenario.
 */
import { afterEach, beforeEach, describe, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { detailOnEverySurface, hiddenBackingOmitsDetail, mostSpecificSubjectFirst, receiptKeepsDetail,
  singleWriterSameRule } from '../helpers/withdrawn-detail-scenarios.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;
let close: () => Promise<void>;

d('fact_withdrawn refusals carry the withdrawal (Postgres)', () => {
  beforeEach(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    configureGateway({ env: {} } as never);
  }, 120_000);
  afterEach(async () => { resetGateway(); await disposePersistenceConsumer(engine); await close(); });

  test('one identical object on stdio, HTTP, local and batch refusals', () => detailOnEverySurface(engine), 60_000);
  test('the most specific subject first, then the newest', () => mostSpecificSubjectFirst(engine), 60_000);
  test('no object when the caller cannot read the withdrawn rows', () => hiddenBackingOmitsDetail(engine), 60_000);
  test('a failed receipt keeps the object for get_write_request and replay', () => receiptKeepsDetail(engine), 60_000);
  test('the single-fact writer applies the same rule; a purge supplies no object', () => singleWriterSameRule(engine), 60_000);
});
