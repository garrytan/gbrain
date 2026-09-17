/** Actual PGLite shutdown ownership, including delayed and failed close. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, releaseLock, PgliteBusyError, type LockHandle } from '../src/core/pglite-lock.ts';
import { PgliteClosingError } from '../src/core/pglite-lifecycle.ts';
import { pgliteCloseTimeoutMs } from '../src/core/background-work.ts';
import { withEnv } from './helpers/with-env.ts';
import { assertPersistenceAccepting, disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';

const roots: string[] = [], engines: PGLiteEngine[] = [];
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function make() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-datastore-lifecycle-')); roots.push(root);
  const dataDir = join(root, 'store'), engine = new PGLiteEngine(); engines.push(engine);
  return { engine, dataDir };
}
async function waitUntil(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await delay(5);
  expect(predicate()).toBe(true);
}
afterEach(async () => {
  for (const engine of engines.splice(0)) { await disposePersistenceConsumer(engine); try { await engine.disconnect(); } catch { /* poisoned fixtures confirm actual close in their own finally */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PGLite datastore lifecycle', () => {
  test('concurrent connects share one open and disconnect is idempotent', async () => {
    const { engine, dataDir } = make();
    await Promise.all([engine.connect({ database_path: dataDir }), engine.connect({ database_path: dataDir })]);
    expect((await engine.executeRaw<{ value: number }>('SELECT 1 AS value'))[0].value).toBe(1);
    let closes = 0;
    const close = engine.db.close;
    engine.db.close = async () => { closes++; await close(); };
    await Promise.all([engine.disconnect(), engine.disconnect()]);
    await engine.disconnect();
    expect(closes).toBe(1);
  });
  test('committed data survives close and a fresh engine reopen', async () => {
    const { engine, dataDir } = make();
    await engine.connect({ database_path: dataDir });
    await engine.executeRaw('CREATE TABLE lifecycle_fixture (value INTEGER)');
    await engine.transactionDirect(async tx => { await tx.executeRaw('INSERT INTO lifecycle_fixture VALUES (17)'); });
    await engine.disconnect();
    const next = new PGLiteEngine(); engines.push(next);
    await next.connect({ database_path: dataDir });
    expect((await next.executeRaw<{ value: number }>('SELECT value FROM lifecycle_fixture'))[0].value).toBe(17);
  });
  test('mandatory resident stop runs before database admission closes', async () => {
    const { engine, dataDir } = make();
    await engine.connect({ database_path: dataDir });
    const stop = deferred(), entered = deferred();
    const unregister = engine.registerBeforeDisconnect(async () => {
      entered.resolve(); await stop.promise;
      await engine.executeRaw('SELECT 1');
    });
    const close = engine.disconnect();
    await entered.promise;
    await expect(engine.connect({ database_path: dataDir })).rejects.toBeInstanceOf(PgliteClosingError);
    await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
    stop.resolve(); await close; unregister();
    await engine.connect({ database_path: dataDir });
    await engine.disconnect(); // removed hook never blocks a later close
  });
  test('already-admitted statements drain before close; captured handles reject new work', async () => {
    const { engine, dataDir } = make();
    await engine.connect({ database_path: dataDir });
    const captured = engine.db, gate = deferred(), entered = deferred();
    const pending = engine.transaction(async tx => {
      entered.resolve(); await gate.promise; await tx.executeRaw('SELECT 1');
    });
    await entered.promise;
    let closed = false;
    const close = captured.close;
    captured.close = async () => { closed = true; await close(); };
    const closing = engine.disconnect();
    await expect(captured.query('SELECT 2')).rejects.toThrow('closing');
    expect(closed).toBe(false);
    gate.resolve();
    await pending;
    await closing;
    expect(closed).toBe(true);
  });
  test('a close deadline retains the kernel lock until the actual close succeeds', async () => {
    await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '1000' }, async () => {
      const { engine, dataDir } = make();
      await engine.connect({ database_path: dataDir });
      startPersistenceConsumer(engine, { engine: 'pglite', database_path: dataDir });
      const lock = (engine as unknown as { _lock: LockHandle })._lock;
      const close = engine.db.close, gate = deferred();
      engine.db.close = async () => { await gate.promise; await close(); };
      const started = performance.now();
      try {
        await expect(engine.disconnect()).rejects.toBeInstanceOf(PgliteClosingError);
        expect(performance.now() - started).toBeLessThan(4000);
        expect(lock.acquired).toBe(true);
        expect(() => assertPersistenceAccepting(engine)).toThrow('closing');
        expect(() => startPersistenceConsumer(engine, { engine: 'pglite', database_path: dataDir })).toThrow('closing');
        await expect(engine.reconnect()).rejects.toBeInstanceOf(PgliteClosingError);
        await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
      } finally { gate.resolve(); await waitUntil(() => !lock.acquired); }
      await engine.connect({ database_path: dataDir });
      expect(() => assertPersistenceAccepting(engine)).not.toThrow();
    });
  }, 15000);
  test('a failed close poisons reconnect and never releases ownership', async () => {
    const { engine, dataDir } = make();
    await engine.connect({ database_path: dataDir });
    startPersistenceConsumer(engine, { engine: 'pglite', database_path: dataDir });
    const lock = (engine as unknown as { _lock: LockHandle })._lock, close = engine.db.close;
    engine.db.close = async () => { throw new Error('injected close failure'); };
    try {
      await expect(engine.disconnect()).rejects.toThrow('injected close failure');
      expect(lock.acquired).toBe(true);
      expect(() => assertPersistenceAccepting(engine)).toThrow('closing');
      expect(() => startPersistenceConsumer(engine, { engine: 'pglite', database_path: dataDir })).toThrow('closing');
      await expect(engine.connect({ database_path: dataDir })).rejects.toBeInstanceOf(PgliteClosingError);
      await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
    } finally {
      // Fixture cleanup confirms the real close. Production recovery requires
      // process termination because an actual failed close offers no such proof.
      await close(); await releaseLock(lock);
    }
  });
  test('a failed mandatory stop retains ownership and never calls close', async () => {
    const { engine, dataDir } = make();
    await engine.connect({ database_path: dataDir });
    const lock = (engine as unknown as { _lock: LockHandle })._lock, close = engine.db.close;
    let closes = 0;
    engine.db.close = async () => { closes++; await close(); };
    engine.registerBeforeDisconnect(async () => { throw new Error('consumer still active'); });
    try {
      await expect(engine.disconnect()).rejects.toThrow('consumer still active');
      expect(closes).toBe(0);
      await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
    } finally { await close(); await releaseLock(lock); }
  });
  test('close timeout budgets clamp overflow and enforce the one-second minimum', async () => {
    await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '1' }, async () => { expect(pgliteCloseTimeoutMs()).toBe(1000); });
    await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '99000000000000' }, async () => { expect(pgliteCloseTimeoutMs()).toBe(2 ** 31 - 1); });
  });
});
