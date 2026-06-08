/**
 * #1794 — heartbeat-aware lock takeover + direct-pool refresh.
 *
 * The lock-thrash fix: a holder that refreshed within the steal-grace window is
 * NOT stolen even if its TTL lapsed (starved-but-alive), while a holder that
 * stopped refreshing past the grace IS stolen. These tests isolate the ON
 * CONFLICT grace logic by holding with `process.pid` (alive) so the dead-pid
 * auto-takeover path can't fire — a successful steal therefore proves the
 * grace/last_refreshed_at predicate did it.
 *
 * Plus the commit-8 causal-mechanism check: setImmediate yields let a
 * setInterval tick fire during a busy loop (the reason the import loop's
 * maybeYield keeps the refresh heartbeat alive).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hostname } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  tryAcquireDbLock,
  resolveStealGraceSeconds,
  DEFAULT_STEAL_GRACE_SECONDS,
} from '../src/core/db-lock.ts';
import { withEnv } from './helpers/with-env.ts';

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
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-hb-%'`);
});

const LOCAL = hostname();

/**
 * Seed a TTL-EXPIRED lock held by an ALIVE pid (process.pid), with a chosen
 * last_refreshed_at age (or NULL). Alive holder → dead-pid auto-takeover can't
 * fire, so the only reclaim path is the ON CONFLICT grace predicate.
 */
async function seedExpiredLock(id: string, refreshedSecondsAgo: number | null): Promise<void> {
  if (refreshedSecondsAgo === null) {
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '5 minutes', NULL)`,
      [id, process.pid, LOCAL],
    );
  } else {
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '5 minutes', NOW() - ($4 || ' seconds')::interval)`,
      [id, process.pid, LOCAL, String(refreshedSecondsAgo)],
    );
  }
}

async function refreshedAge(id: string): Promise<Date | null> {
  const rows = await engine.executeRaw<{ last_refreshed_at: string | null }>(
    `SELECT last_refreshed_at FROM gbrain_cycle_locks WHERE id = $1`,
    [id],
  );
  const v = rows[0]?.last_refreshed_at ?? null;
  return v ? new Date(v) : null;
}

describe('resolveStealGraceSeconds', () => {
  test('derives ~2 refresh ticks from the TTL (30min → 600s)', () => {
    // refresh ~ttl/6 = 5min = 300s; *2 = 600s.
    expect(resolveStealGraceSeconds(30)).toBe(DEFAULT_STEAL_GRACE_SECONDS);
    expect(resolveStealGraceSeconds(30)).toBe(600);
  });

  test('floors at 60s for tiny TTLs', () => {
    expect(resolveStealGraceSeconds(1)).toBe(60);
  });

  test('env override wins', async () => {
    await withEnv({ GBRAIN_LOCK_STEAL_GRACE_SECONDS: '123' }, async () => {
      expect(resolveStealGraceSeconds(30)).toBe(123);
    });
  });

  test('bad env override falls back to derived', async () => {
    await withEnv({ GBRAIN_LOCK_STEAL_GRACE_SECONDS: 'nope' }, async () => {
      expect(resolveStealGraceSeconds(30)).toBe(600);
    });
  });
});

describe('heartbeat-aware takeover (ON CONFLICT grace predicate)', () => {
  test('FRESH holder is NOT stolen even with an expired TTL', async () => {
    // ttl expired 5min ago, but refreshed 1s ago → inside the 600s grace.
    await seedExpiredLock('test-hb-fresh', 1);
    const handle = await tryAcquireDbLock(engine, 'test-hb-fresh', 30);
    expect(handle).toBeNull();
  });

  test('STALE-refresh holder IS stolen (refresh older than the grace)', async () => {
    // ttl expired AND last refresh 20min ago (> 600s grace) → stealable, even
    // though the holder pid is alive (proves the grace path, not auto-takeover).
    await seedExpiredLock('test-hb-stale', 1200);
    const handle = await tryAcquireDbLock(engine, 'test-hb-stale', 30);
    expect(handle).not.toBeNull();
    await handle!.release();
  });

  test('NULL last_refreshed_at (pre-v98 row) IS stolen on TTL expiry', async () => {
    await seedExpiredLock('test-hb-null', null);
    const handle = await tryAcquireDbLock(engine, 'test-hb-null', 30);
    expect(handle).not.toBeNull();
    await handle!.release();
  });

  test('a reclaimed handle refresh() bumps last_refreshed_at (direct pool path)', async () => {
    await seedExpiredLock('test-hb-bump', 1200);
    const handle = await tryAcquireDbLock(engine, 'test-hb-bump', 30);
    expect(handle).not.toBeNull();
    const before = await refreshedAge('test-hb-bump');
    // Small real delay so NOW() advances measurably between acquire and refresh.
    await new Promise((r) => setTimeout(r, 20));
    await handle!.refresh();
    const after = await refreshedAge('test-hb-bump');
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    await handle!.release();
  });
});

describe('event-loop yield keeps timers alive (commit 8 mechanism)', () => {
  test('setTimeout(0) yields let a setInterval heartbeat fire during a busy loop', async () => {
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 2);
    try {
      // Mirror the import loop's maybeYield: setTimeout(0) enters the timers
      // phase, so the setInterval heartbeat can fire mid-loop. (A setImmediate
      // loop starves the timers phase in Bun — the reason maybeYield uses
      // setTimeout, not setImmediate.) Bound by wall-clock so the 2ms interval
      // has real time to fire.
      const start = Date.now();
      while (Date.now() - start < 40) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    } finally {
      clearInterval(iv);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
