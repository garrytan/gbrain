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
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock, inspectLock, isLockHolderLive } from '../src/core/db-lock.ts';
import { MinionSupervisor, ExitCodes, supervisorLockId, classifySupervisorSingleton, SUPERVISOR_LOCK_TTL_MIN } from '../src/core/minions/supervisor.ts';
import type { DbLockHandle, LockSnapshot } from '../src/core/db-lock.ts';

// Build a LockSnapshot fixture for the isLockHolderLive matrix. Only ttl_expired
// and ms_since_last_refresh are consulted; the rest are filled for shape.
function snap(over: Partial<LockSnapshot>): LockSnapshot {
  return {
    id: 'gbrain-supervisor:default',
    holder_pid: 4242,
    holder_host: 'box',
    acquired_at: new Date(),
    ttl_expires_at: new Date(),
    age_ms: 1000,
    ttl_expired: false,
    last_refreshed_at: new Date(),
    ms_since_last_refresh: 0,
    ...over,
  };
}

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
  test('keys on queue ONLY (DB scoping is physical — the lock row lives in the DB)', () => {
    expect(supervisorLockId('default')).toBe('gbrain-supervisor:default');
    expect(supervisorLockId('shell')).toBe('gbrain-supervisor:shell');
    // Different queues → different locks.
    expect(supervisorLockId('default')).not.toBe(supervisorLockId('shell'));
    // Regression (the bug this fixes): the id must NOT depend on how the same
    // physical DB was addressed. Two supervisors on one DB via different URLs
    // must compute the SAME id so they collide on the one shared locks table.
    // The function takes no DB-identity arg precisely so it can't diverge.
    expect(supervisorLockId.length).toBe(1);
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
    const id = supervisorLockId('default');
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
    const a = await tryAcquireDbLock(engine, supervisorLockId('default'), 5);
    const b = await tryAcquireDbLock(engine, supervisorLockId('shell'), 5);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });
});

describe('#1849 LOCK_HELD path does not strand the pidfile', () => {
  test('the pidfile-cleanup exit listener is installed BEFORE the DB-lock acquire', async () => {
    // Supervisor A already holds the queue lock.
    const holderA = await tryAcquireDbLock(engine, supervisorLockId('default'), 5);
    expect(holderA).not.toBeNull();

    const pidFile = join(tmpdir(), `gbrain-sup-stranded-${process.pid}-${Math.random().toString(36).slice(2)}.pid`);
    const sup = new MinionSupervisor(engine, { cliPath: '/bin/sh', healthInterval: 0, json: true, pidFile });

    // Capture the 'exit' listener start() registers (if any) and stop execution
    // at the first process.exit (the LOCK_HELD path) the way the real exit would.
    let exitListener: ((...a: unknown[]) => void) | null = null;
    const onSpy = spyOn(process, 'on').mockImplementation(((event: string, cb: (...a: unknown[]) => void) => {
      if (event === 'exit') exitListener = cb;
      return process;
    }) as never);
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      try { await sup.start(); } catch { /* exit stub throws at LOCK_HELD */ }

      expect(exitSpy).toHaveBeenCalledWith(ExitCodes.LOCK_HELD);
      // The bug: the exit listener was registered AFTER the DB-lock exit, so
      // start() threw before reaching it and the pidfile this process created
      // is stranded. The fix installs it first → it's captured here.
      expect(exitListener).not.toBeNull();
      // And it actually cleans up the pidfile we created (contents match our pid).
      expect(existsSync(pidFile)).toBe(true);
      exitListener!();
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      onSpy.mockRestore();
      exitSpy.mockRestore();
      if (existsSync(pidFile)) unlinkSync(pidFile);
      await holderA!.release();
    }
  });

});

describe('#2227 isLockHolderLive — PID-reuse-safe supervisor liveness', () => {
  test('fresh TTL → live (the normal running case)', () => {
    expect(isLockHolderLive(snap({ ttl_expired: false }), SUPERVISOR_LOCK_TTL_MIN)).toBe(true);
  });

  test('expired TTL but refreshed within the steal grace → live (starved-but-alive #1794)', () => {
    // ttl lapsed but the holder heartbeat is recent → it is alive, just starved.
    expect(isLockHolderLive(snap({ ttl_expired: true, ms_since_last_refresh: 5_000 }), SUPERVISOR_LOCK_TTL_MIN)).toBe(true);
  });

  test('expired TTL and stale heartbeat → dead (a gone supervisor stops refreshing)', () => {
    expect(isLockHolderLive(snap({ ttl_expired: true, ms_since_last_refresh: 36_000_000 }), SUPERVISOR_LOCK_TTL_MIN)).toBe(false);
  });

  test('expired TTL and no heartbeat column → dead', () => {
    expect(isLockHolderLive(snap({ ttl_expired: true, ms_since_last_refresh: null }), SUPERVISOR_LOCK_TTL_MIN)).toBe(false);
  });

  test('liveness NEVER consults process.kill (PID reuse cannot false-positive)', () => {
    // A row whose holder_pid happens to be a live, unrelated process (PID reuse)
    // but whose lock is stale must read as NOT live — proving freshness, not the
    // PID probe, is the signal. holder_pid=1 (init, always alive) + expired/stale.
    expect(isLockHolderLive(snap({ holder_pid: 1, ttl_expired: true, ms_since_last_refresh: 36_000_000 }), SUPERVISOR_LOCK_TTL_MIN)).toBe(false);
  });
});

describe('#2227 status detects a live supervisor via the DB lock (split-$HOME)', () => {
  test('a live queue lock with no local pidfile reads as running via inspectLock', async () => {
    // Simulate the keeper holding the queue lock under a different $HOME: there
    // is a live lock row but the local pidfile path is empty.
    const holder = await tryAcquireDbLock(engine, supervisorLockId('default'), SUPERVISOR_LOCK_TTL_MIN);
    expect(holder).not.toBeNull();
    const live = await inspectLock(engine, supervisorLockId('default'));
    expect(live).not.toBeNull();
    expect(isLockHolderLive(live!, SUPERVISOR_LOCK_TTL_MIN)).toBe(true);
    await holder!.release();
    // After release the row is gone → not running.
    const gone = await inspectLock(engine, supervisorLockId('default'));
    expect(gone).toBeNull();
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
