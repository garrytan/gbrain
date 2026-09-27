import { afterAll, beforeAll, describe, test } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { retryStates, retryEdits, exerciseAtomRetryFence, exerciseAtomRetrySourceIsolation, atomWriteThroughValues, atomOwnerStates, exerciseAtomWriteThroughPolicy, atomDisabledAuthorityCases, exerciseAtomDisabledAuthority } from '../helpers/managed-atom-regressions.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('managed atom retry and storage policy PostgreSQL parity', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  }, 120_000);
  afterAll(async () => { await fixture?.close(); resetGateway(); });
  test('retry fault stays scoped while an older source retry drains', async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    try { await exerciseAtomRetrySourceIsolation(isolated.engine); }
    finally { await isolated.close(); }
  }, 120_000);
  for (const state of retryStates) for (const edit of retryEdits) {
    test(`retry ${state} preserves reviewed target ${edit}`, () => exerciseAtomRetryFence(fixture.engine, state, edit), 60_000);
  }
  for (const value of atomWriteThroughValues) for (const owner of atomOwnerStates) {
    test(`write-through ${value} with ${owner} owner`, () => exerciseAtomWriteThroughPolicy(fixture.engine, value, owner), 60_000);
  }
  for (const scenario of atomDisabledAuthorityCases) {
    test(`database-only extraction retains ${scenario} fence`, () => exerciseAtomDisabledAuthority(fixture.engine, scenario), 60_000);
  }
});
