import { afterAll, beforeAll, beforeEach, describe } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { deepResearchContract } from '../helpers/deep-research-contract.ts';

const databaseUrl = process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Postgres deep research matrix', () => {
  let engine: PostgresEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
  }, 90_000);
  beforeEach(async () => {
    await engine.executeRaw('TRUNCATE pages CASCADE');
    await engine.executeRaw('DELETE FROM slug_aliases');
  });
  afterAll(async () => { await close?.(); }, 30_000);
  deepResearchContract(() => engine);
});
