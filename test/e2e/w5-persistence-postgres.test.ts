/**
 * Postgres arms of the managed capacity (#5470), effect parking (#5612) and
 * coordinated stale extraction (#5609) scenarios. Each run gets a fresh
 * isolated database from the persistence Postgres helper.
 */
import { describe, test } from 'bun:test';
import {
  capacityWarnsAndRefusalNamesTheKey, compactionSkipsUnfinishedReceipts, failuresDoNotCarryToAnotherTarget, healthyScanAndContentionNeverPark,
  managedStaleSweep, managedStaleSweepKeepsNormalizedTimeline, managedStaleSweepManyPages, scanParksOneTargetAndContinues, singleTargetParksAndRetries, staleExtractionWithheldWhenItCannotRun,
} from '../helpers/w5-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres managed capacity, parking and stale extraction', () => {
  test('a failing Git target parks and retries', () => singleTargetParksAndRetries(url), 180_000);
  test('a Git scan parks one target and continues', () => scanParksOneTargetAndContinues(url), 180_000);
  test('failures do not carry to another target', () => failuresDoNotCarryToAnotherTarget(url), 180_000);
  test('a healthy scan and contention never park', () => healthyScanAndContentionNeverPark(url), 180_000);
  test('configured retention compacts past unfinished receipts', () => compactionSkipsUnfinishedReceipts(url), 240_000);
  test('capacity warning and refusal hint', () => capacityWarnsAndRefusalNamesTheKey(url), 180_000);
  test('managed extract --stale is coordinated', () => managedStaleSweep(url), 180_000);
  test('managed extract --stale derives several pages at once', () => managedStaleSweepManyPages(url), 180_000);
  test('managed extract --stale keeps normalized timeline rows single', () => managedStaleSweepKeepsNormalizedTimeline(url), 180_000);
  test('extract.stale withheld when it cannot run', () => staleExtractionWithheldWhenItCannotRun(url), 180_000);
});
