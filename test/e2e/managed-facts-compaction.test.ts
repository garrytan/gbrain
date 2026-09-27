import { afterAll, beforeAll, describe, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { exerciseFactCompaction, factCompactionCases } from '../helpers/managed-facts-compaction-contract.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('compacted fact batch PostgreSQL parity', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => { fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await fixture?.close(); });
  for (const scenario of factCompactionCases) test(scenario, () => exerciseFactCompaction(fixture.engine, scenario), 60_000);
});
