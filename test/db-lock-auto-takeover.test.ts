/**
 * #1780 Gap 3 — automatic same-host dead-pid lock takeover.
 *
 * Two layers:
 *   - classifyHolderLiveness (pure, injectable process.kill seam): the
 *     decision matrix incl. the CRITICAL EPERM-as-ALIVE rule.
 *   - tryAcquireDbLock auto-takeover (PGLite, real process.kill): a held +
 *     not-TTL-expired lock whose same-host holder is provably dead and past
 *     the 60s grace gets reclaimed; alive / cross-host / young holders don't.
 *     A taken-over lock returns a working handle (refresh + release).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hostname } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  tryAcquireDbLock,
  classifyHolderLiveness,
  isHolderDeadLocally,
  HOLDER_TAKEOVER_GRACE_MS,
} from '../src/core/db-lock.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-takeover-%'`);
});

const LOCAL = hostname();
const OLD_MS = HOLDER_TAKEOVER_GRACE_MS + 60_000; // comfortably past the grace window
const ESRCH = () => { const e = new Error('no such process') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; };
const EPERM = () => { const e = new Error('operation not permitted') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; };
const EINVAL = () => { const e = new Error('weird') as NodeJS.ErrnoException; e.code = 'EINVAL'; throw e; };
const aliveKill = () => { /* no throw → alive */ };

describe('classifyHolderLiveness', () => {
  test('same-host + ESRCH + old → dead_eligible', () => {
    expect(classifyHolderLiveness(123, LOCAL, OLD_MS, { processKill: ESRCH })).toBe('dead_eligible');
  });

  test('same-host + ESRCH + young → too_young (PID-reuse guard)', () => {
    expect(classifyHolderLiveness(123, LOCAL, 5_000, { processKill: ESRCH })).toBe('too_young');
  });

  test('same-host + alive → alive', () => {
    expect(classifyHolderLiveness(123, LOCAL, OLD_MS, { processKill: aliveKill })).toBe('alive');
  });

  test('CRITICAL: same-host + EPERM → alive (never steal a live lock)', () => {
    expect(classifyHolderLiveness(123, LOCAL, OLD_MS, { processKill: EPERM })).toBe('alive');
  });

  test('same-host + unknown errno → unknown (conservative)', () => {
    expect(classifyHolderLiveness(123, LOCAL, OLD_MS, { processKill: EINVAL })).toBe('unknown');
  });

  test('cross-host → cross_host (never probe a remote pid)', () => {
    expect(classifyHolderLiveness(123, 'some-other-host', OLD_MS, { processKill: ESRCH })).toBe('cross_host');
  });

  test('isHolderDeadLocally is true only for dead_eligible', () => {
    expect(isHolderDeadLocally(1, LOCAL, OLD_MS, { processKill: ESRCH })).toBe(true);
    expect(isHolderDeadLocally(1, LOCAL, 5_000, { processKill: ESRCH })).toBe(false);
    expect(isHolderDeadLocally(1, LOCAL, OLD_MS, { processKill: EPERM })).toBe(false);
    expect(isHolderDeadLocally(1, 'other', OLD_MS, { processKill: ESRCH })).toBe(false);
  });
});

/** Insert a held, NOT-TTL-expired lock row for the given holder. */
async function seedHeldLock(id: string, holderPid: number, holderHost: string, ageSeconds: number) {
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, NOW() - ($4 || ' seconds')::interval, NOW() + INTERVAL '10 minutes', NOW() - ($4 || ' seconds')::interval)`,
    [id, holderPid, holderHost, String(ageSeconds)],
  );
}

/** A reliably-dead PID on this host: spawn a process, wait for it to exit. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['sh', '-c', 'exit 0']);
  await proc.exited;
  return proc.pid;
}

describe('tryAcquireDbLock auto-takeover', () => {
  test('reclaims a same-host dead-pid lock past the grace window', async () => {
    const pid = await deadPid();
    await seedHeldLock('test-takeover-dead', pid, LOCAL, 120);
    const handle = await tryAcquireDbLock(engine, 'test-takeover-dead', 30);
    expect(handle).not.toBeNull();
    // The reclaimed handle is the normal one: refresh + release work.
    await handle!.refresh();
    await handle!.release();
    // After release, the row is gone → a fresh acquire succeeds immediately.
    const again = await tryAcquireDbLock(engine, 'test-takeover-dead', 30);
    expect(again).not.toBeNull();
    await again!.release();
  });

  test('does NOT reclaim a live same-host holder', async () => {
    // process.pid is alive → no takeover; lock stays held.
    await seedHeldLock('test-takeover-alive', process.pid, LOCAL, 120);
    const handle = await tryAcquireDbLock(engine, 'test-takeover-alive', 30);
    expect(handle).toBeNull();
  });

  test('does NOT reclaim a cross-host holder (TTL-only)', async () => {
    const pid = await deadPid();
    await seedHeldLock('test-takeover-xhost', pid, 'a-different-host', 120);
    const handle = await tryAcquireDbLock(engine, 'test-takeover-xhost', 30);
    expect(handle).toBeNull();
  });

  test('does NOT reclaim a dead-pid lock younger than the grace window', async () => {
    const pid = await deadPid();
    await seedHeldLock('test-takeover-young', pid, LOCAL, 5); // 5s < 60s grace
    const handle = await tryAcquireDbLock(engine, 'test-takeover-young', 30);
    expect(handle).toBeNull();
  });
});
