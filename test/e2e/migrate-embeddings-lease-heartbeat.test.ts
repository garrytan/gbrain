/**
 * #6587: the embedding migration's long transactions (the retained-vector
 * census, ~88 s on a large remote brain) held the lease rows FOR SHARE from
 * the start, so the 15 s heartbeat's refresh UPDATE blocked, was cancelled at
 * its timeout and the migration aborted as lease-lost. Real Postgres: the row
 * lock semantics are the bug. Timings are scaled (census = pg_sleep(4),
 * refresh timeout 1.5 s instead of 30 s).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../../src/core/db-lock.ts';
import { assertMigrationLeases, withMigrationLeaseTransaction, type MigrationLeaseAssert } from '../../src/core/embedding-migration-budget.ts';

const skip = !hasDatabase();
beforeAll(async () => { if (!skip) await setupDB(); }, 120_000);
afterAll(async () => { if (!skip) await teardownDB(); });

const owned = (lock: DbLockHandle): MigrationLeaseAssert => async (tx, lease) => {
  if (tx) await assertMigrationLeases(tx, [lock], lease);
};
async function refreshDuring(census: Promise<unknown>, lock: DbLockHandle): Promise<unknown> {
  await new Promise(r => setTimeout(r, 300));
  let refreshed: unknown;
  try { refreshed = await lock.refresh({ signal: AbortSignal.timeout(1500) }); } catch (e) { refreshed = `threw: ${(e as Error).message}`; }
  await census.catch(() => {});
  return refreshed;
}

describe.skipIf(skip)('migration lease transactions (#6587)', () => {
  test('the heartbeat refreshes the lease while a long census transaction runs', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-census', 60))!;
    try {
      const census = withMigrationLeaseTransaction(engine, owned(lock), tx => tx.executeRaw('SELECT pg_sleep(4)'));
      expect(await refreshDuring(census, lock)).toBe(true);
      await census;
    } finally { await lock.release(); }
  }, 30_000);

  test('forced probe: holding the lease rows FOR SHARE across the census (the old shape) blocks the heartbeat', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-old-shape', 60))!;
    try {
      const census = engine.transaction(async tx => {
        await assertMigrationLeases(tx, [lock]);
        await tx.executeRaw('SELECT pg_sleep(4)');
      });
      expect(String(await refreshDuring(census, lock))).toContain('threw');
    } finally { await lock.release(); }
  }, 30_000);

  test('a lease stolen during the work rolls the transaction back', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-stolen', 60))!;
    try {
      await expect(withMigrationLeaseTransaction(engine, owned(lock), async tx => {
        await tx.executeRaw(`INSERT INTO config(key,value) VALUES('w17.6587.marker','written') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
        await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1`, [lock.id]);
      })).rejects.toThrow('Migration lease lost');
      expect(await engine.executeRaw(`SELECT value FROM config WHERE key=$1`, ['w17.6587.marker'])).toEqual([]);
    } finally {
      await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id=$1`, [lock.id]);
    }
  }, 30_000);

  test('a deadlock victim reruns side-effect-free work; mutating work is not retried', async () => {
    const engine = getEngine();
    const lock = (await tryAcquireDbLock(engine, 'w17-6587-deadlock', 60))!;
    try {
      const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
      let attempts = 0;
      const result = await withMigrationLeaseTransaction(engine, owned(lock), async () => {
        if (++attempts === 1) throw deadlock();
        return 'census-ok';
      }, { deadlockRetries: 3 });
      expect({ result, attempts }).toEqual({ result: 'census-ok', attempts: 2 });
      let mutating = 0;
      await expect(withMigrationLeaseTransaction(engine, owned(lock), async () => { mutating++; throw deadlock(); })).rejects.toThrow('deadlock detected');
      expect(mutating).toBe(1);
    } finally { await lock.release(); }
  }, 30_000);
});
