/**
 * #6712 PR 4b: a page request a pass leaves open when it stops (`writer_pending`) is the next pass's import, whoever commits it
 * and whenever (sync-pass-carried.ts). The pass row carries the open request ids (`obligations.pending_requests`); the next
 * pass counts each one that committed once, then drops it.
 *
 * Protects (the race behind test/persistence-managed-sync.test.ts 'pending durable sync retries'):
 * - the request commits before the resumed pass's level read: the level sees the page settled, and the pass still reports
 *   it as its import (`first_sync`, added 1);
 * - the request commits after the level read saw it in flight but before the pass waits on it: counted once, not twice;
 * - the pass waits on it and counts it itself: counted once;
 * - every case leaves no carried id behind, and a following pass is up to date.
 *
 * Fault hooks pick the commit point, so no case depends on machine load. PGLite here; Postgres through
 * test/e2e/sync-pass-carried-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { type FaultPoint, installFaultHook } from '../src/core/persistence/fault-points.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  writeFileSync(join(root, 'pending.md'), 'An observation waiting for publication.\n');
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'pending');
};
const requestState = async (engine: BrainEngine) =>
  (await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id='default' AND intent->>'kind'='managed_sync_import'")).map(row => row.state);
const carried = async (engine: BrainEngine) => (await engine.executeRaw<{ carried: unknown }>(
  "SELECT completed_keys->0->'obligations'->'pending_requests' AS carried FROM op_checkpoints WHERE op=$1", [MANAGED_SYNC_PASS_OP]))[0]?.carried ?? null;

/** Leaves the source's one import open past a `writer_pending` stop: the worktree lock is held while the pass waits. */
async function stopPending(engine: BrainEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  const lock = await acquireWorktree((await getWorktreeBinding(engine, 'default'))!);
  expect(lock).not.toBeNull();
  try {
    expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'partial', reason: 'writer_pending', added: 0 });
  } finally { await disposePersistenceConsumer(engine); await lock!.release(); }
  expect(await requestState(engine)).toEqual(['queued']);
}

/** At `point` in round 1 of the next pass: the consumer commits the open import before the pass goes on. */
const commitAt = (engine: BrainEngine, point: FaultPoint) => installFaultHook(async (at, detail) => {
  if (at !== point || detail.round !== 1) return;
  installFaultHook(undefined);
  startPersistenceConsumer(engine, { engine: engine.kind }).wake(true);
  await waitFor(async () => (await requestState(engine))[0] === 'committed', { timeoutMs: 30_000, label: 'carried import committed' });
});

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#6712 PR 4b carried pass requests (${backend})`, () => {
    const cases: Array<[string, FaultPoint | null]> = [
      ['commits before the level read', 'sync:round_start'],
      ['commits after the level read saw it in flight', 'sync:level_read'],
      ['commits while the pass waits on it', null],
    ];
    for (const [label, point] of cases) {
      test(`a prior pass's open import that ${label} is the resumed pass's import, counted once`, () => managedBrain(async ({ engine }) => {
        await stopPending(engine);
        if (point) commitAt(engine, point);
        const resumed = await performManagedSync(engine, OPTS);
        expect(resumed).toMatchObject({ status: 'first_sync', added: 1, modified: 0, filesImported: 1 });
        expect(await requestState(engine)).toEqual(['committed']);
        expect(await carried(engine)).toBeNull();
        expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'up_to_date', added: 0, modified: 0, filesImported: 0 });
      }, { databaseUrl, setup }), 90_000);
    }
  });
}
