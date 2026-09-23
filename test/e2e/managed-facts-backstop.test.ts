import { afterAll, beforeAll, describe, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { factContractCases, exerciseManagedFacts } from '../helpers/managed-facts-contract.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('managed facts PostgreSQL caller parity', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => { configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }); fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await fixture?.close(); resetGateway(); });
  for (const scenario of factContractCases) test(scenario, () => exerciseManagedFacts(fixture.engine, scenario), 60_000);
});
