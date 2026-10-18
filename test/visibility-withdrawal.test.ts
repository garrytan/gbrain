/**
 * Remote forget refusals and entity cards respect visibility and withdrawal (PGLite).
 * Scenarios: test/helpers/visibility-withdrawal-scenarios.ts; the Postgres twin is
 * test/e2e/visibility-withdrawal-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { cardExcerptHidesWithdrawnRows, hiddenWithdrawalRefusesGenerically, linkedForgetKeepsHiddenCopies,
  unlinkedForgetKeepsHiddenCopies } from './helpers/visibility-withdrawal-scenarios.ts';

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

describe('remote forget refusals and entity cards respect visibility and withdrawal', () => {
  test('an unlinked forget keeps copies the caller cannot read, with one fixed refusal', () => unlinkedForgetKeepsHiddenCopies(engine));
  test('a linked forget keeps copies the caller cannot read', () => linkedForgetKeepsHiddenCopies(engine));
  test('a withdrawal backed only by unreadable rows refuses as an unreadable page does', () => hiddenWithdrawalRefusesGenerically(engine));
  test('the card excerpt carries the withdrawal overlay', () => cardExcerptHidesWithdrawnRows(engine));
});
