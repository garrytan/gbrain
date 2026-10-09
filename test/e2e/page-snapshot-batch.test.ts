/** Postgres arm of test/page-snapshot-batch.test.ts (GBRA-69). */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { pageSnapshotBatchMatchesPerPageReads, pageSnapshotBatchRespectsByteBudget } from '../helpers/page-snapshot-batch-cases.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres readPageSnapshotsBatch', () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ engine, close } = await isolatedPersistencePostgres(url!)); }, 120_000);
  afterAll(async () => { await close?.(); });
  test('batched snapshots equal the per-page reads, missing and deleted refs included', () => pageSnapshotBatchMatchesPerPageReads(engine));
  test('a batch covers the longest prefix that fits the byte budget, never less than one ref', () => pageSnapshotBatchRespectsByteBudget(engine));
});
