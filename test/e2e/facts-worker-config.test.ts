import { afterAll, beforeAll, describe, test } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { exerciseFactsWorkerConfig } from '../helpers/facts-worker-config-contract.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('Postgres facts worker configuration', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => { configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }); fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await fixture?.close(); resetGateway(); });
  test('a fresh worker consumer cannot spend on chunk embeddings when selected config disables them', () => exerciseFactsWorkerConfig(fixture.engine), 60_000);
});
