import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { deleteLockRow, deleteLockRowExact, deleteLockRowIfStale, inspectLock,
  LockStolenError, tryAcquireDbLock, withRefreshingLock } from '../src/core/db-lock.ts';

let engine: PGLiteEngine;
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

describe('database lease concurrency', () => {
  test('two acquisitions with identical database timestamps still have different identities', async () => {
    await engine.transactionDirect(async tx => {
      const first = (await tryAcquireDbLock(tx, 'fixture-same-timestamp'))!;
      await first.release();
      const second = (await tryAcquireDbLock(tx, 'fixture-same-timestamp'))!;
      expect(first.acquiredAt).toBe(second.acquiredAt); // PostgreSQL NOW is transaction-stable
      expect(first.acquisitionToken).not.toBe(second.acquisitionToken);
      expect(await first.refresh()).toBe(false);
      await first.release();
      expect((await inspectLock(tx, first.id))!.acquisition_token).toBe(second.acquisitionToken);
      await second.release();
    });
  });
  test('every cleanup path preserves a successor with the same PID and timestamp', async () => {
    const handle = (await tryAcquireDbLock(engine, 'fixture-cleanup-aba'))!;
    const snapshot = (await inspectLock(engine, handle.id))!;
    await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquisition_token = gen_random_uuid(), last_refreshed_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [handle.id]);
    expect((await deleteLockRow(engine, handle.id, snapshot.holder_pid, snapshot.acquisition_token)).deleted).toBe(false);
    expect((await deleteLockRowExact(engine, handle.id, snapshot.holder_pid, snapshot.acquisition_token)).deleted).toBe(false);
    expect((await deleteLockRowIfStale(engine, handle.id, snapshot.holder_pid, 1, snapshot.acquisition_token)).deleted).toBe(false);
    await handle.release();
    expect((await inspectLock(engine, handle.id))!.acquisition_token).not.toBe(snapshot.acquisition_token);
    await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', [handle.id]);
  });
  test('a timed-out refresh stays single-flight and drains before release; late loss cannot return success', async () => {
    const db = engine.db, query = db.query, entered = deferred(), releaseRefresh = deferred();
    let refreshes = 0, returned = false;
    db.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE gbrain_cycle_locks') && sql.includes('RETURNING id')) {
        refreshes++; entered.resolve(); await releaseRefresh.promise;
      }
      return query(sql, params);
    }) as typeof db.query;
    const operation = withRefreshingLock(engine, 'fixture-late-refresh', async () => {
      await entered.promise;
      return 'must not succeed';
    }, { ttlMinutes: 0.02, refreshIntervalMs: 10, heartbeatTimeoutMs: 20 });
    const verdict = operation.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    void verdict.then(() => { returned = true; });
    try {
      await entered.promise; await delay(60);
      expect(refreshes).toBe(1);
      expect(returned).toBe(false);
      // The work body has returned, but the real renewal has not settled.
      expect(await inspectLock(engine, 'fixture-late-refresh')).not.toBeNull();
      await query(`UPDATE gbrain_cycle_locks SET acquisition_token = gen_random_uuid() WHERE id = $1`, ['fixture-late-refresh']);
      releaseRefresh.resolve();
      expect((await verdict).error).toBeInstanceOf(LockStolenError);
      expect(await inspectLock(engine, 'fixture-late-refresh')).not.toBeNull();
    } finally {
      releaseRefresh.resolve(); await verdict; db.query = query;
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', ['fixture-late-refresh']);
    }
  });
  test('renewal expiry always aborts work even without an optional loss observer', async () => {
    const db = engine.db, query = db.query;
    db.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE gbrain_cycle_locks') && sql.includes('RETURNING id')) throw new Error('injected renewal outage');
      return query(sql, params);
    }) as typeof db.query;
    let signal: AbortSignal | undefined;
    try {
      await expect(withRefreshingLock(engine, 'fixture-renewal-expiry', async workSignal => {
        signal = workSignal;
        await new Promise<void>(resolve => workSignal.addEventListener('abort', () => resolve(), { once: true }));
        return 'ignored cancellation';
      }, { ttlMinutes: 0.005, refreshIntervalMs: 80 })).rejects.toBeInstanceOf(LockStolenError);
      expect(signal!.aborted).toBe(true);
      expect(await inspectLock(engine, 'fixture-renewal-expiry')).toBeNull();
    } finally { db.query = query; }
  });
  test('synchronous event-loop starvation cannot hide expiry when work returns', async () => {
    await expect(withRefreshingLock(engine, 'fixture-starved-work', async () => {
      const deadline = performance.now() + 50;
      while (performance.now() < deadline) { /* deliberately starve timers */ }
      return 'must not report success';
    }, { ttlMinutes: 0.0005 })).rejects.toBeInstanceOf(LockStolenError);
    expect(await inspectLock(engine, 'fixture-starved-work')).toBeNull();
  });
});
