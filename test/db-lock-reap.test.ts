/**
 * #1972 — host-scoped reaper for dead-holder sync/cycle locks.
 *
 * Covers:
 *   - reapDeadHolderLocks: namespace scope (sync/cycle only, NOT election/etc),
 *     same-host dead-PID reaped regardless of TTL, live/cross-host/within-grace
 *     kept. Uses the injectable process.kill seam so it's deterministic.
 *   - deleteLockRowExact: snapshot-matched delete (the TOCTOU defense) — a
 *     non-matching acquired_at is a no-op, the matching one deletes.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hostname } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  reapDeadHolderLocks,
  deleteLockRowExact,
  inspectLock,
  HOLDER_TAKEOVER_GRACE_MS,
  type HolderLivenessOpts,
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
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks`);
});

const LOCAL = hostname();
const OLD_S = Math.ceil(HOLDER_TAKEOVER_GRACE_MS / 1000) + 60; // comfortably past grace
const YOUNG_S = 5;

/** Insert a lock row with a given age + namespace. ttlFuture controls whether
 *  the row is TTL-expired (to prove the reaper reaps dead holders regardless). */
async function seedLock(
  id: string,
  holderPid: number,
  holderHost: string,
  ageSeconds: number,
  ttlFuture = true,
) {
  const ttl = ttlFuture ? `NOW() + INTERVAL '10 minutes'` : `NOW() - INTERVAL '1 minute'`;
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, NOW() - ($4 || ' seconds')::interval, ${ttl}, NOW() - ($4 || ' seconds')::interval)`,
    [id, holderPid, holderHost, String(ageSeconds)],
  );
}

/** process.kill seam: every pid is dead (ESRCH) except those in `live`. */
function killSeam(live: Set<number>): HolderLivenessOpts {
  return {
    localHost: LOCAL,
    processKill: (pid: number) => {
      if (live.has(pid)) return; // alive
      const e = new Error('no such process') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    },
  };
}

async function lockIds(): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM gbrain_cycle_locks ORDER BY id`);
  return rows.map(r => r.id);
}

describe('reapDeadHolderLocks', () => {
  test('reaps same-host dead-PID sync + cycle locks (regardless of TTL)', async () => {
    await seedLock('gbrain-sync:src-a', 900001, LOCAL, OLD_S, /*ttlFuture*/ true);  // dead, TTL NOT expired
    await seedLock('gbrain-cycle', 900002, LOCAL, OLD_S, false);                     // dead, TTL expired
    await seedLock('gbrain-cycle:src-b', 900003, LOCAL, OLD_S, true);                // dead, TTL NOT expired

    const { reaped, reapedIds } = await reapDeadHolderLocks(engine, killSeam(new Set()));
    expect(reaped).toBe(3);
    expect(reapedIds.sort()).toEqual(['gbrain-cycle', 'gbrain-cycle:src-b', 'gbrain-sync:src-a']);
    expect(await lockIds()).toEqual([]);
  });

  test('keeps a live same-host holder', async () => {
    await seedLock('gbrain-sync:src-live', process.pid, LOCAL, OLD_S);
    const { reaped } = await reapDeadHolderLocks(engine, killSeam(new Set([process.pid])));
    expect(reaped).toBe(0);
    expect(await lockIds()).toEqual(['gbrain-sync:src-live']);
  });

  test('keeps a dead holder still within the PID-reuse grace window', async () => {
    await seedLock('gbrain-sync:src-young', 900010, LOCAL, YOUNG_S);
    const { reaped } = await reapDeadHolderLocks(engine, killSeam(new Set()));
    expect(reaped).toBe(0);
    expect(await lockIds()).toEqual(['gbrain-sync:src-young']);
  });

  test('keeps a cross-host holder (cannot probe a remote PID)', async () => {
    await seedLock('gbrain-sync:src-xhost', 900011, 'a-different-host', OLD_S);
    const { reaped } = await reapDeadHolderLocks(engine, killSeam(new Set()));
    expect(reaped).toBe(0);
    expect(await lockIds()).toEqual(['gbrain-sync:src-xhost']);
  });

  test('NEVER reaps a non-sync/cycle namespace, even with a dead PID (blast radius)', async () => {
    await seedLock('gbrain-election:leader', 900020, LOCAL, OLD_S);
    await seedLock('some-other-lock', 900021, LOCAL, OLD_S);
    const { reaped } = await reapDeadHolderLocks(engine, killSeam(new Set()));
    expect(reaped).toBe(0);
    expect(await lockIds()).toEqual(['gbrain-election:leader', 'some-other-lock']);
  });

  test('empty table → {reaped:0}', async () => {
    const r = await reapDeadHolderLocks(engine, killSeam(new Set()));
    expect(r).toEqual({ reaped: 0, reapedIds: [] });
  });

  test('mixed set: reaps only the eligible rows', async () => {
    await seedLock('gbrain-sync:dead', 900030, LOCAL, OLD_S);          // reap
    await seedLock('gbrain-sync:live', process.pid, LOCAL, OLD_S);     // keep (live)
    await seedLock('gbrain-cycle:xhost', 900031, 'other', OLD_S);      // keep (cross-host)
    await seedLock('gbrain-election:x', 900032, LOCAL, OLD_S);         // keep (namespace)
    const { reaped, reapedIds } = await reapDeadHolderLocks(engine, killSeam(new Set([process.pid])));
    expect(reaped).toBe(1);
    expect(reapedIds).toEqual(['gbrain-sync:dead']);
    expect(await lockIds()).toEqual(['gbrain-cycle:xhost', 'gbrain-election:x', 'gbrain-sync:live']);
  });
});

describe('deleteLockRowExact (snapshot-matched, TOCTOU defense)', () => {
  test('no-op when acquired_at does not match; deletes when it does', async () => {
    await seedLock('gbrain-sync:exact', 900040, LOCAL, OLD_S);
    const snap = await inspectLock(engine, 'gbrain-sync:exact');
    expect(snap).not.toBeNull();

    // Simulate a reused-PID takeover: same id + pid, but a different (newer)
    // acquired_at than the one the reaper snapshotted → must NOT delete.
    const wrong = new Date(snap!.acquired_at.getTime() + 3_600_000);
    const miss = await deleteLockRowExact(engine, 'gbrain-sync:exact', 900040, wrong);
    expect(miss.deleted).toBe(false);
    expect(await lockIds()).toEqual(['gbrain-sync:exact']);

    // The matching snapshot deletes.
    const hit = await deleteLockRowExact(engine, 'gbrain-sync:exact', 900040, snap!.acquired_at);
    expect(hit.deleted).toBe(true);
    expect(await lockIds()).toEqual([]);
  });

  test('no-op when holder_pid does not match', async () => {
    await seedLock('gbrain-sync:pidguard', 900050, LOCAL, OLD_S);
    const snap = await inspectLock(engine, 'gbrain-sync:pidguard');
    const res = await deleteLockRowExact(engine, 'gbrain-sync:pidguard', 111111, snap!.acquired_at);
    expect(res.deleted).toBe(false);
    expect(await lockIds()).toEqual(['gbrain-sync:pidguard']);
  });
});
