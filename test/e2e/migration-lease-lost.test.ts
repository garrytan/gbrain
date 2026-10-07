/**
 * #6028 diagnostic: when the fenced refresh of a held migration lease matches
 * no row but the row still names this process (same pid and host), the
 * runner did not lose the lease to another runner, so it must not say
 * "another apply-migrations is running" naming its own pid. `assertHeld`
 * raises `migration_lease_lost` with which part of the fence no longer
 * matches (no token values), and the runner reports it (exit 1).
 * Run: DATABASE_URL=... bun test test/e2e/migration-lease-lost.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { rmSync } from 'node:fs';
import { hasDatabase, setupDB, teardownDB, getConn } from './helpers.ts';
import { collect, logHas, makeHome, spawnDriver, writeDriver } from '../helpers/apply-migrations-lock-driver.ts';
import {
  acquireMigrationOrchestrationLock,
  MIGRATION_ORCHESTRATION_LOCK_ID,
  MigrationsRunningError,
} from '../../src/core/migration-orchestration-lock.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
const config = () => ({ engine: 'postgres' as const, database_url: process.env.DATABASE_URL! });

async function heldLock() {
  const lock = await acquireMigrationOrchestrationLock(config());
  if (!lock) throw new Error('expected the Postgres migration lease');
  return lock;
}

type LeaseLost = Error & { code: string; details: Record<string, unknown> };

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected assertHeld to throw');
}

describeE2E('migration lease lost under this runner (#6028, Postgres)', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => {
    await getConn().unsafe('DELETE FROM gbrain_cycle_locks WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
  });

  test('own row with a rewritten acquisition token: migration_lease_lost, token mismatch, fence match', async () => {
    const lock = await heldLock();
    try {
      await getConn().unsafe('UPDATE gbrain_cycle_locks SET acquisition_token = gen_random_uuid() WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
      const lost = await caught(lock.assertHeld()) as LeaseLost;
      expect(lost.code).toBe('migration_lease_lost');
      expect(lost.details).toMatchObject({ holder_pid: process.pid, holder_host: hostname(), token_match: false, fence_match: true });
      expect(lost.message).not.toContain('another apply-migrations is running');
      expect(JSON.stringify(lost.details)).not.toContain(lock.leaseToken!);
    } finally {
      await lock.release();
    }
  });

  test('own row with a moved acquisition time: migration_lease_lost, fence mismatch, token match', async () => {
    const lock = await heldLock();
    try {
      await getConn().unsafe(`UPDATE gbrain_cycle_locks SET acquired_at = acquired_at - interval '1 second' WHERE id = $1`, [MIGRATION_ORCHESTRATION_LOCK_ID]);
      const lost = await caught(lock.assertHeld()) as LeaseLost;
      expect(lost.code).toBe('migration_lease_lost');
      expect(lost.details).toMatchObject({ token_match: true, fence_match: false });
    } finally {
      await lock.release();
    }
  });

  test('a row that names another holder still refuses as migrations_running', async () => {
    const lock = await heldLock();
    try {
      await getConn().unsafe(`UPDATE gbrain_cycle_locks SET holder_pid = 4242, holder_host = 'host-b', acquisition_token = gen_random_uuid() WHERE id = $1`, [MIGRATION_ORCHESTRATION_LOCK_ID]);
      const error = await caught(lock.assertHeld());
      expect(error).toBeInstanceOf(MigrationsRunningError);
      expect((error as Error).message).toContain('host host-b, pid 4242');
    } finally {
      await lock.release();
      await getConn().unsafe('DELETE FROM gbrain_cycle_locks WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
    }
  });

  test('the runner reports migration_lease_lost (exit 1) and stops before the next migration', async () => {
    const home = makeHome({ engine: 'postgres', database_url: process.env.DATABASE_URL! });
    try {
      const run = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false, rotateOwnToken: true })));
      expect(run.code, run.stderr + run.stdout).toBe(1);
      expect(run.stderr).toContain('Error [migration_lease_lost]');
      expect(run.stderr).not.toContain('another apply-migrations is running');
      expect(logHas(home, 'start')).toBe(false);
    } finally {
      await getConn().unsafe('DELETE FROM gbrain_cycle_locks WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
