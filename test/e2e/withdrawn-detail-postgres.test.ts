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

  test('the object on local refusals only; stdio, HTTP and batch refusals carry none', () => detailOnEverySurface(engine), 60_000);
  test('the most specific subject first, then the newest', () => mostSpecificSubjectFirst(engine), 60_000);
  test('a remote refusal is byte-identical whether the withdrawn rows are hidden, visible or absent', () => hiddenBackingOmitsDetail(engine), 60_000);
  test('a remote failed receipt carries no object in get_write_request or replay', () => receiptKeepsDetail(engine), 60_000);
  test('the single-fact writer applies the same rule; a purge supplies no object', () => singleWriterSameRule(engine), 60_000);
});
