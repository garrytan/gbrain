/**
 * DB-lock PID probe — #480 rewritten for v0.38's lock refactor.
 *
 * `gbrain_cycle_locks` is a 30-minute TTL row shared by the cycle lock,
 * performSync's writer lock, and the migrate lock (all via tryAcquireDbLock).
 * Before this fix the only takeover path was `ttl_expires_at < NOW()`. After a
 * SIGKILL / OOM / power-off the holder PID is dead but the row still has up to
 * 30 minutes of life, so every acquirer skipped with the lock held. A real
 * brain lost 14 hours of sync to this.
 *
 * Fix: when the UPSERT finds a live (non-expired) row, probe the holder PID
 * via process.kill(pid, 0) when the host matches. Dead same-host holder →
 * take over now. Different host → trust the TTL (can't probe remotely).
 *
 * Originally landed in src/core/cycle.ts (PR #480); v0.38 moved the DB lock
 * into src/core/db-lock.ts, so the probe moves with it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hostname } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  tryAcquireDbLock,
  isPidAliveLocal,
  decideLockAcquisition,
} from '../src/core/db-lock.ts';

describe('decideLockAcquisition (pure)', () => {
  const here = hostname();

  test('different host → skip (cannot probe; trust TTL)', () => {
    expect(
      decideLockAcquisition({
        holderPid: 99999,
        holderHost: 'some-other-machine.local',
        currentHost: here,
        isPidAlive: () => false, // even a "dead" probe is untrusted across hosts
      }),
    ).toBe('skip');
  });

  test('same host + alive PID → skip (live holder)', () => {
    expect(
      decideLockAcquisition({
        holderPid: 1234,
        holderHost: here,
        currentHost: here,
        isPidAlive: (pid) => {
          expect(pid).toBe(1234);
          return true;
        },
      }),
    ).toBe('skip');
  });

  test('same host + dead PID → acquire (zombie row)', () => {
    expect(
      decideLockAcquisition({
        holderPid: 1234,
        holderHost: here,
        currentHost: here,
        isPidAlive: () => false,
      }),
    ).toBe('acquire');
  });
});

describe('isPidAliveLocal (real probe)', () => {
  test('current process is alive', () => {
    expect(isPidAliveLocal(process.pid)).toBe(true);
  });

  test('pid 1 (init/launchd) is alive via EPERM', () => {
    // We can't signal init, so kill(1,0) throws EPERM → treated as alive.
    expect(isPidAliveLocal(1)).toBe(true);
  });

  test('an impossible pid is dead', () => {
    expect(isPidAliveLocal(2147483646)).toBe(false);
  });

  test('pid 0 and negative are dead (never signal the process group)', () => {
    expect(isPidAliveLocal(0)).toBe(false);
    expect(isPidAliveLocal(-1)).toBe(false);
  });
});

describe('tryAcquireDbLock takeover (PGLite)', () => {
  let engine: PGLiteEngine;
  const here = hostname();
  const LOCK = 'gbrain-cycle';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  });

  async function seedHolder(pid: number, host: string) {
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 minutes')`,
      [LOCK, pid, host],
    );
  }

  async function holderPid(): Promise<number | null> {
    const rows = await engine.executeRaw<{ holder_pid: number }>(
      `SELECT holder_pid FROM gbrain_cycle_locks WHERE id = $1`,
      [LOCK],
    );
    return rows[0] ? Number(rows[0].holder_pid) : null;
  }

  test('fresh row → acquires', async () => {
    const handle = await tryAcquireDbLock(engine, LOCK, 30);
    expect(handle).not.toBeNull();
    expect(await holderPid()).toBe(process.pid);
    await handle!.release();
  });

  test('live same-host holder → null (no takeover)', async () => {
    await seedHolder(1, here); // pid 1 is alive via EPERM
    const handle = await tryAcquireDbLock(engine, LOCK, 30);
    expect(handle).toBeNull();
    expect(await holderPid()).toBe(1); // untouched
  });

  test('dead same-host holder → takes over (#480 core fix)', async () => {
    await seedHolder(2147483646, here); // impossible pid, fresh TTL
    const handle = await tryAcquireDbLock(engine, LOCK, 30);
    expect(handle).not.toBeNull();
    expect(await holderPid()).toBe(process.pid); // reclaimed
    await handle!.release();
  });

  test('dead holder on a different host → null (trust TTL, cannot probe)', async () => {
    await seedHolder(2147483646, 'other-machine.example');
    const handle = await tryAcquireDbLock(engine, LOCK, 30);
    expect(handle).toBeNull();
    expect(await holderPid()).toBe(2147483646); // untouched
  });
});
