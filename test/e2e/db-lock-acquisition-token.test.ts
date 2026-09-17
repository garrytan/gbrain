import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { tryAcquireDbLock, inspectLock, deleteLockRow, deleteLockRowExact, deleteLockRowIfStale } from '../../src/core/db-lock.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres acquisition tokens and short control transactions', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: url, poolSize: 3 });
    await engine.initSchema();
  }, 120000);
  afterAll(async () => { await engine?.disconnect(); });

  test('identical NOW timestamps cannot alias two successive acquisitions', async () => {
    await engine.transactionDirect(async tx => {
      const first = (await tryAcquireDbLock(tx, 'fixture-pg-identical-timestamp'))!;
      await first.release();
      const next = (await tryAcquireDbLock(tx, first.id))!;
      expect(first.acquiredAt).toBe(next.acquiredAt);
      expect(first.acquisitionToken).not.toBe(next.acquisitionToken);
      expect(await first.refresh()).toBe(false);
      await first.release();
      expect((await inspectLock(tx, next.id))!.acquisition_token).toBe(next.acquisitionToken);
      await next.release();
    });
  });
  test('all stale cleanup variants preserve a same-PID same-timestamp successor', async () => {
    const first = (await tryAcquireDbLock(engine, 'fixture-pg-cleanup-aba'))!;
    const snapshot = (await inspectLock(engine, first.id))!;
    try {
      await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquisition_token = gen_random_uuid(), last_refreshed_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [first.id]);
      expect((await deleteLockRow(engine, first.id, snapshot.holder_pid, snapshot.acquisition_token)).deleted).toBe(false);
      expect((await deleteLockRowExact(engine, first.id, snapshot.holder_pid, snapshot.acquisition_token)).deleted).toBe(false);
      expect((await deleteLockRowIfStale(engine, first.id, snapshot.holder_pid, 1, snapshot.acquisition_token)).deleted).toBe(false);
      expect(await first.refresh()).toBe(false);
      await first.release();
      expect((await inspectLock(engine, first.id))!.acquisition_token).not.toBe(snapshot.acquisition_token);
    } finally {
      await first.release();
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', [first.id]);
    }
  });
});
