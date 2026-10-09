/**
 * GBRA-69: `gbrain extract all --source db` reads and publishes pages in
 * batches. The rows it leaves are pinned by a golden captured with the
 * per-page walk it replaced (master before the change), so batching changes
 * no link, timeline, transition, relationship, wanted-link, stamp or request
 * row. A batch whose transaction fails is replayed page by page and must
 * leave the same rows. Postgres arm: test/e2e/extract-db-batch-equivalence.test.ts.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { expectGolden } from './helpers/golden.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { EXTRACT_ROWS, failEveryBatch, managedRounds, seedExtractFixture, unmanagedRounds } from './helpers/extract-db-batch-fixture.ts';

/** Each unmanaged case starts from a freshly initialized brain, like the golden's capture. */
async function withPglite(run: (engine: BrainEngine) => Promise<void>) {
  const { engine, close } = await isolatedSharedSkillsEngine();
  try { await run(engine); } finally { await close(); }
}

test('unmanaged brain: batched extract leaves the rows the per-page walk left', () => withPglite(async engine => {
  const rounds = await unmanagedRounds(engine);
  expect(rounds.first.exitCode).toBe(0);
  expect(rounds.afterFirst.links.length).toBeGreaterThan(300);
  expectGolden('extract-db-batch/unmanaged', rounds, EXTRACT_ROWS);
}), 180_000);

test('unmanaged brain: a failed batch replays page by page to the same rows', () => withPglite(async engine => {
  failEveryBatch(engine);
  expectGolden('extract-db-batch/unmanaged', await unmanagedRounds(engine), EXTRACT_ROWS);
}), 180_000);

test('managed brain: batched extract leaves the rows the per-page walk left', () => managedBrain(async ({ engine }) => {
  const rounds = await managedRounds(engine);
  expect(rounds.afterFirst.extract_requests.length).toBeGreaterThan(0);
  expectGolden('extract-db-batch/managed', rounds, EXTRACT_ROWS);
}, { setup: ({ engine }) => seedExtractFixture(engine) }), 240_000);

test('managed brain: a failed batch replays page by page to the same rows', () => managedBrain(async ({ engine }) => {
  failEveryBatch(engine);
  expectGolden('extract-db-batch/managed', await managedRounds(engine), EXTRACT_ROWS);
}, { setup: ({ engine }) => seedExtractFixture(engine) }), 240_000);
