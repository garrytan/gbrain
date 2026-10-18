/** Postgres arm of test/import-reads.test.ts (GBRA-75 wave 10). */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { findDuplicatePagesMatchesSingle, importGroupReadsCoalesce, importSnapshotsDropPurgedIncomingRows, importSnapshotsMatchSingleReads } from '../helpers/import-reads-cases.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres managed import batched reads', () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ engine, close } = await isolatedPersistencePostgres(url!)); }, 120_000);
  afterAll(async () => { await close?.(); });
  test('batched import snapshots equal the includeDeleted single reads, deleted, missing and purged pages included', () => importSnapshotsMatchSingleReads(engine));
  test('an incoming file drops page-subject and \'*\' purged rows through the batched snapshot as through the single read', () => importSnapshotsDropPurgedIncomingRows(engine));
  test('findDuplicatePages answers each input as findDuplicatePage does', () => findDuplicatePagesMatchesSingle(engine));
  test('an import group coalesces its members\' reads and falls back to single reads when a batch fails', () => importGroupReadsCoalesce(engine));
});
