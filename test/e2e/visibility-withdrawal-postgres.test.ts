/**
 * Postgres twin of test/visibility-withdrawal.test.ts: remote forget refusals and
 * entity cards respect visibility and withdrawal. One isolated database per scenario.
 */
import { afterEach, beforeEach, describe, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { cardExcerptHidesWithdrawnRows, hiddenWithdrawalRefusesGenerically, linkedForgetKeepsHiddenCopies,
  unlinkedForgetKeepsHiddenCopies } from '../helpers/visibility-withdrawal-scenarios.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;
let close: () => Promise<void>;

d('remote forget refusals and entity cards respect visibility and withdrawal (Postgres)', () => {
  beforeEach(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    configureGateway({ env: {} } as never);
  }, 120_000);
  afterEach(async () => { resetGateway(); await disposePersistenceConsumer(engine); await close(); });

  test('an unlinked forget keeps copies the caller cannot read, with one fixed refusal', () => unlinkedForgetKeepsHiddenCopies(engine), 60_000);
  test('a linked forget keeps copies the caller cannot read', () => linkedForgetKeepsHiddenCopies(engine), 60_000);
  test('a withdrawal backed only by unreadable rows refuses as an unreadable page does', () => hiddenWithdrawalRefusesGenerically(engine), 60_000);
  test('the card excerpt carries the withdrawal overlay', () => cardExcerptHidesWithdrawnRows(engine), 60_000);
});
