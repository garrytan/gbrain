import { afterAll, beforeAll, describe, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { exerciseManagedEmbedding, managedEmbeddingCases } from '../helpers/managed-facts-embedding-contract.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('managed fact embedding PostgreSQL parity', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => { fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await fixture?.close(); });
  for (const scenario of managedEmbeddingCases) test(scenario, () => exerciseManagedEmbedding(fixture.engine, scenario), 60_000);
});
