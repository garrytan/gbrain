/**
 * Postgres arm of test/extract-db-batch-equivalence.test.ts (GBRA-69): the
 * batched `extract all --source db` walk, and its page-by-page replay, leave
 * the rows the per-page walk left (the same golden as PGLite).
 */
import { describe, test } from 'bun:test';
import { expectGolden } from '../helpers/golden.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { EXTRACT_ROWS, failEveryBatch, managedRounds, seedExtractFixture, unmanagedRounds } from '../helpers/extract-db-batch-fixture.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres batched extract all --source db', () => {
  for (const replay of [false, true]) {
    test(`unmanaged brain${replay ? ', every batch replayed' : ''}: the rows the per-page walk left`, async () => {
      const { engine, close } = await isolatedPersistencePostgres(url!);
      try {
        if (replay) failEveryBatch(engine);
        expectGolden('extract-db-batch/unmanaged', await unmanagedRounds(engine), EXTRACT_ROWS);
      } finally { await close(); }
    }, 240_000);
    test(`managed brain${replay ? ', every batch replayed' : ''}: the rows the per-page walk left`, () => managedBrain(async ({ engine }) => {
      if (replay) failEveryBatch(engine);
      expectGolden('extract-db-batch/managed', await managedRounds(engine), EXTRACT_ROWS);
    }, { databaseUrl: url, setup: ({ engine }) => seedExtractFixture(engine) }), 240_000);
  }
});
