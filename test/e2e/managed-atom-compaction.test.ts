import { afterAll, beforeAll, describe, test } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { atomCompactionCases, atomCompactionActions, exerciseAtomCompaction } from '../helpers/managed-atom-compaction.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('managed atom receipt compaction PostgreSQL parity', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  }, 120_000);
  afterAll(async () => { await fixture?.close(); resetGateway(); });
  for (const scenario of atomCompactionCases) for (const action of atomCompactionActions) {
    test(`${scenario} ${action} does not repeat extraction`, () => exerciseAtomCompaction(fixture.engine, scenario, action), 60_000);
  }
});
