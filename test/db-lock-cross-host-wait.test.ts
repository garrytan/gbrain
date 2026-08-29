/**
 * #2308 — bounded wait for a dead CROSS-HOST lock holder.
 *
 * A holder that died on another host leaves a row whose TTL is still live;
 * tryAcquireDbLock correctly refuses to steal it (cross_host classification,
 * process.kill is meaningless remotely) — so one-shot callers exited
 * LOCK_HELD even though the lock frees itself within TTL + steal-grace.
 * waitForDbLockTakeover polls the normal acquire up to that bound, bailing
 * fast when the holder's heartbeat advances (genuinely alive).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  tryAcquireDbLock,
  waitForDbLockTakeover,
} from '../src/core/db-lock.ts';
import { resolveSupervisorLockWaitSeconds } from '../src/core/minions/supervisor.ts';
import { withEnv } from './helpers/with-env.ts';

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
}, 60_000);

afterAll(async () => {
  await eng.disconnect();
});

beforeEach(async () => {
  await eng.executeRaw('DELETE FROM gbrain_cycle_locks', []);
});

const LOCK_ID = 'cross-host-wait-test';

/** Seed a cross-host holder row. ttlMs/refreshAgoMs are relative to NOW(). */
async function seedHolder(opts: { ttlMs: number; refreshAgoMs: number; pid?: number }) {
  await eng.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, 'other-host-zzz', NOW() - INTERVAL '10 minutes',
             NOW() + ($3 || ' milliseconds')::interval,
             NOW() - ($4 || ' milliseconds')::interval)`,
    [LOCK_ID, opts.pid ?? 99999, String(opts.ttlMs), String(opts.refreshAgoMs)],
  );
}

describe('waitForDbLockTakeover (#2308)', () => {
  test('precondition: dead cross-host holder with live TTL blocks the one-shot acquire', async () => {
    await seedHolder({ ttlMs: 60_000, refreshAgoMs: 10 * 60_000 });
    expect(await tryAcquireDbLock(eng, LOCK_ID, 1)).toBeNull();
  });

  test('dead holder: acquired once the TTL lapses (within the bound)', async () => {
    // TTL lapses in ~1.2s; last refresh is 10min ago (past the 60s grace for
    // a 1-min TTL) — the normal upsert takes over on the first post-lapse poll.
    await seedHolder({ ttlMs: 1_200, refreshAgoMs: 10 * 60_000 });
    const handle = await waitForDbLockTakeover(eng, LOCK_ID, 1, {
      pollMs: 200,
      maxWaitMs: 15_000,
    });
    expect(handle).not.toBeNull();
    // the row now names US
    const rows = await eng.executeRaw<{ holder_pid: number }>(
      'SELECT holder_pid FROM gbrain_cycle_locks WHERE id = $1',
      [LOCK_ID],
    );
    expect(Number(rows[0].holder_pid)).toBe(process.pid);
    await handle!.release();
  }, 30_000);

  test('refreshing holder: heartbeat advance bails to null fast', async () => {
    await seedHolder({ ttlMs: 5 * 60_000, refreshAgoMs: 0 });
    const started = Date.now();
    let bumped = false;
    const handle = await waitForDbLockTakeover(eng, LOCK_ID, 1, {
      pollMs: 100,
      maxWaitMs: 30_000,
      sleep: async (ms) => {
        // Simulate the remote holder's heartbeat firing between our polls.
        if (!bumped) {
          bumped = true;
          await eng.executeRaw(
            `UPDATE gbrain_cycle_locks SET last_refreshed_at = NOW() + INTERVAL '1 second' WHERE id = $1`,
            [LOCK_ID],
          );
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    expect(handle).toBeNull();
    // bailed on the heartbeat, nowhere near the 30s bound
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test('bound honored: unreapable holder returns null at maxWaitMs', async () => {
    await seedHolder({ ttlMs: 10 * 60_000, refreshAgoMs: 0 });
    const started = Date.now();
    const handle = await waitForDbLockTakeover(eng, LOCK_ID, 1, {
      pollMs: 150,
      maxWaitMs: 900,
    });
    expect(handle).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  test('holder replaced by a different (pid,host) while waiting → null (they are alive)', async () => {
    await seedHolder({ ttlMs: 5 * 60_000, refreshAgoMs: 0, pid: 11111 });
    let swapped = false;
    const handle = await waitForDbLockTakeover(eng, LOCK_ID, 1, {
      pollMs: 100,
      maxWaitMs: 30_000,
      sleep: async (ms) => {
        if (!swapped) {
          swapped = true;
          await eng.executeRaw(
            `UPDATE gbrain_cycle_locks SET holder_pid = 22222 WHERE id = $1`,
            [LOCK_ID],
          );
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    expect(handle).toBeNull();
  }, 30_000);
});

describe('resolveSupervisorLockWaitSeconds — env hatch', () => {
  const KEY = 'GBRAIN_SUPERVISOR_LOCK_WAIT_SECONDS';

  test('unset → -1 (derived TTL+grace bound)', async () => {
    await withEnv({ [KEY]: undefined }, () => {
      expect(resolveSupervisorLockWaitSeconds()).toBe(-1);
    });
  });

  test('0 disables the wait', async () => {
    await withEnv({ [KEY]: '0' }, () => {
      expect(resolveSupervisorLockWaitSeconds()).toBe(0);
    });
  });

  test('positive integer is the hard bound; junk falls back to derived', async () => {
    await withEnv({ [KEY]: '90' }, () => {
      expect(resolveSupervisorLockWaitSeconds()).toBe(90);
    });
    await withEnv({ [KEY]: 'nonsense' }, () => {
      expect(resolveSupervisorLockWaitSeconds()).toBe(-1);
    });
  });
});
