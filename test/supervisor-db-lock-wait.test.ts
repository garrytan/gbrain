/**
 * #2308: supervisor DB-lock acquisition waits out a DEAD holder (e.g. the
 * previous container's supervisor, whose row is cross-host and can only lapse
 * via TTL) instead of one-shot exiting LOCK_HELD inside the TTL window.
 *
 * Pure-seam tests — no DB, no process.exit. The engine argument is never
 * touched because every seam is injected.
 */

import { describe, test, expect } from 'bun:test';
import { hostname } from 'node:os';
import { acquireSupervisorDbLockWithWait } from '../src/core/minions/supervisor.ts';
import type { DbLockHandle, LockSnapshot } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const fakeEngine = {} as BrainEngine;

const handle: DbLockHandle = {
  id: 'gbrain-supervisor:default',
  release: async () => {},
  refresh: async () => {},
};

function snap(over: Partial<LockSnapshot> = {}): LockSnapshot {
  const now = Date.now();
  return {
    id: 'gbrain-supervisor:default',
    holder_pid: 424242,
    holder_host: `dead-container-${hostname()}-not`, // never the local host
    acquired_at: new Date(now - 120_000),
    ttl_expires_at: new Date(now + 180_000), // TTL NOT expired — the bug window
    age_ms: 120_000,
    ttl_expired: false,
    last_refreshed_at: new Date(now - 90_000),
    ms_since_last_refresh: 90_000,
    ...over,
  };
}

describe('acquireSupervisorDbLockWithWait (#2308)', () => {
  test('returns immediately when the first acquire succeeds', async () => {
    let inspects = 0;
    const got = await acquireSupervisorDbLockWithWait(fakeEngine, 'lock', 5, {
      tryAcquire: async () => handle,
      inspect: async () => { inspects++; return null; },
      sleep: async () => {},
    });
    expect(got).toBe(handle);
    expect(inspects).toBe(0);
  });

  test('waits out a dead cross-host holder until the TTL-lapse takeover fires', async () => {
    let attempts = 0;
    let sleeps = 0;
    const dead = snap(); // static heartbeat: never advances
    const got = await acquireSupervisorDbLockWithWait(fakeEngine, 'lock', 5, {
      tryAcquire: async () => (++attempts >= 3 ? handle : null),
      inspect: async () => dead,
      sleep: async () => { sleeps++; },
      retryMs: 1,
    });
    expect(got).toBe(handle);
    expect(attempts).toBe(3);
    expect(sleeps).toBe(2);
  });

  test('fails fast when the holder is a live same-host PID', async () => {
    let sleeps = 0;
    const got = await acquireSupervisorDbLockWithWait(fakeEngine, 'lock', 5, {
      tryAcquire: async () => null,
      inspect: async () => snap({ holder_host: hostname() }),
      // probe succeeds → PID alive
      processKill: () => {},
      sleep: async () => { sleeps++; },
    });
    expect(got).toBeNull();
    expect(sleeps).toBe(0);
  });

  test('fails fast when the heartbeat ADVANCES between polls (live holder elsewhere)', async () => {
    let inspects = 0;
    const base = Date.now();
    const got = await acquireSupervisorDbLockWithWait(fakeEngine, 'lock', 5, {
      tryAcquire: async () => null,
      inspect: async () => {
        inspects++;
        // Heartbeat advances 60s per poll — an actively refreshing holder.
        return snap({ last_refreshed_at: new Date(base + inspects * 60_000) });
      },
      sleep: async () => {},
      retryMs: 1,
    });
    expect(got).toBeNull();
    expect(inspects).toBe(2); // second observation proves liveness
  });

  test('gives up after maxWaitMs when takeover never becomes possible', async () => {
    let clock = 0;
    const dead = snap();
    const got = await acquireSupervisorDbLockWithWait(fakeEngine, 'lock', 5, {
      tryAcquire: async () => null,
      inspect: async () => dead,
      sleep: async () => { clock += 10_000; },
      now: () => clock,
      retryMs: 10_000,
      maxWaitMs: 35_000,
    });
    expect(got).toBeNull();
  });

  test('keeps polling when the row vanishes between inspects', async () => {
    let attempts = 0;
    const got = await acquireSupervisorDbLockWithWait(fakeEngine, 'lock', 5, {
      tryAcquire: async () => (++attempts >= 2 ? handle : null),
      inspect: async () => null, // row already gone
      sleep: async () => {},
      retryMs: 1,
    });
    expect(got).toBe(handle);
  });
});
