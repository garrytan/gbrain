/**
 * #1849: queue-scoped DB supervisor singleton.
 *
 * The pidfile guard is mutually exclusive only per pidfile PATH; the DB lock
 * makes the (database, queue) pair the mutex domain so two supervisors with
 * different $HOME / --pid-file can't both run on one queue. These tests pin:
 *   - the lock id keys on DB identity + queue (T2)
 *   - a second acquire of the same (db, queue) lock is refused (the singleton)
 *   - different queues don't collide
 *   - refresh-failure past the threshold fails SAFE (exits non-zero) (F1A)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { MinionSupervisor, ExitCodes, supervisorLockId, classifySupervisorSingleton } from '../src/core/minions/supervisor.ts';
import type { DbLockHandle } from '../src/core/db-lock.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-supervisor:%'`);
});

describe('#1849 supervisorLockId', () => {
  test('keys on DB identity AND queue', () => {
    expect(supervisorLockId('default', 'postgres://x')).toBe('gbrain-supervisor:postgres://x:default');
    expect(supervisorLockId('shell', 'postgres://x')).toBe('gbrain-supervisor:postgres://x:shell');
    // Different DB identity → different lock even for the same queue.
    expect(supervisorLockId('default', 'postgres://a'))
      .not.toBe(supervisorLockId('default', 'postgres://b'));
  });
});

describe('#1849 classifySupervisorSingleton (doctor)', () => {
  test('no live lock → no_lock', () => {
    expect(classifySupervisorSingleton({
      lockLive: false, lockHolderHost: 'h', lockHolderPid: 1, localHost: 'h', localPid: 1,
    })).toBe('no_lock');
  });

  test('live lock held by the local (host,pid) → single', () => {
    expect(classifySupervisorSingleton({
      lockLive: true, lockHolderHost: 'box', lockHolderPid: 42, localHost: 'box', localPid: 42,
    })).toBe('single');
  });

  test('live lock held by a DIFFERENT pid → mismatch (rogue second supervisor)', () => {
    expect(classifySupervisorSingleton({
      lockLive: true, lockHolderHost: 'box', lockHolderPid: 99, localHost: 'box', localPid: 42,
    })).toBe('mismatch');
  });

  test('same pid but DIFFERENT host → mismatch (bare pid is meaningless cross-host)', () => {
    expect(classifySupervisorSingleton({
      lockLive: true, lockHolderHost: 'other', lockHolderPid: 42, localHost: 'box', localPid: 42,
    })).toBe('mismatch');
  });

  test('live lock but no local pidfile → mismatch', () => {
    expect(classifySupervisorSingleton({
      lockLive: true, lockHolderHost: 'box', lockHolderPid: 42, localHost: 'box', localPid: null,
    })).toBe('mismatch');
  });
});

describe('#1849 DB lock is the real singleton', () => {
  test('second acquire of the same (db, queue) lock is refused', async () => {
    const id = supervisorLockId('default', 'pglite:test');
    const first = await tryAcquireDbLock(engine, id, 5);
    expect(first).not.toBeNull();
    // A second supervisor (different pidfile, same db+queue) gets null → exit 2.
    const second = await tryAcquireDbLock(engine, id, 5);
    expect(second).toBeNull();
    // After release, a fresh supervisor can take over.
    await first!.release();
    const third = await tryAcquireDbLock(engine, id, 5);
    expect(third).not.toBeNull();
    await third!.release();
  });

  test('different queues on the same DB do not collide', async () => {
    const a = await tryAcquireDbLock(engine, supervisorLockId('default', 'pglite:test'), 5);
    const b = await tryAcquireDbLock(engine, supervisorLockId('shell', 'pglite:test'), 5);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });
});

describe('#1849 refresh-failure fails safe (F1A)', () => {
  test('exits LOCK_LOST after the failure threshold; tolerates a single blip', async () => {
    const sup = new MinionSupervisor(engine, { cliPath: '/bin/sh', healthInterval: 0, json: true });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`exit:${_code}`); // stop execution like the real exit would
    }) as never);

    let refreshCalls = 0;
    const failingLock: DbLockHandle = {
      id: 'x',
      refresh: async () => { refreshCalls++; throw new Error('pooler down'); },
      release: async () => {},
    };
    sup._setDbLockForTests(failingLock);

    try {
      // First two failures: tolerated (counter climbs, no exit).
      await sup._refreshDbLockForTests();
      await sup._refreshDbLockForTests();
      expect(exitSpy).not.toHaveBeenCalled();
      // Third failure crosses the threshold → shutdown → process.exit(LOCK_LOST).
      try { await sup._refreshDbLockForTests(); } catch { /* exit stub throws */ }
      expect(exitSpy).toHaveBeenCalledWith(ExitCodes.LOCK_LOST);
      expect(refreshCalls).toBe(3);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('a successful refresh resets the failure counter', async () => {
    const sup = new MinionSupervisor(engine, { cliPath: '/bin/sh', healthInterval: 0, json: true });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`exit:${_code}`);
    }) as never);

    let mode: 'fail' | 'ok' = 'fail';
    const flakyLock: DbLockHandle = {
      id: 'x',
      refresh: async () => { if (mode === 'fail') throw new Error('blip'); },
      release: async () => {},
    };
    sup._setDbLockForTests(flakyLock);

    try {
      await sup._refreshDbLockForTests(); // fail 1
      await sup._refreshDbLockForTests(); // fail 2
      mode = 'ok';
      await sup._refreshDbLockForTests(); // success → reset
      mode = 'fail';
      await sup._refreshDbLockForTests(); // fail 1 again
      await sup._refreshDbLockForTests(); // fail 2
      // Counter was reset, so we are NOT past threshold yet.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
