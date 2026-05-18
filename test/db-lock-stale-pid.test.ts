/**
 * test/db-lock-stale-pid.test.ts — Verify acquirePostgresLock + tryAcquireDbLock
 * evict rows whose holder PID is provably dead on the local host.
 *
 * Without this, a SIGKILL'd `gbrain dream` (or any aborted lock holder) leaves
 * a row whose TTL is up to 30 minutes in the future. Every subsequent
 * acquirer reads that row, sees "live holder" via the TTL gate, and bails —
 * even though the holder is on this host and demonstrably gone. The fix:
 * before the TTL-bounded upsert, do a same-host PID probe via signal-0 and
 * evict rows whose holder returned ESRCH.
 *
 * The probe is intentionally narrow:
 *   - Only same-host rows are evicted (we have no way to probe remote PIDs).
 *   - Only ESRCH counts as "dead"; EPERM (unsignalable but alive) does not.
 *   - The current process's own PID is left alone (the upsert handles
 *     re-acquire of our own previous row).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hostname } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/**
 * Seed a stale row directly so the test doesn't depend on a real
 * SIGKILL'd holder. PID 999999 is high enough that it should never collide
 * with a live process on a normal Linux/macOS dev box.
 */
async function seedStaleRow(
  lockId: string,
  opts: { pid?: number; host?: string; ttlMinutesFromNow?: number } = {},
) {
  const pid = opts.pid ?? 999999;
  const host = opts.host ?? hostname();
  const ttl = opts.ttlMinutesFromNow ?? 30;
  await engine.db.query(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
     VALUES ($1, $2, $3, NOW(), NOW() + ($4 || ' minutes')::interval)`,
    [lockId, pid, host, String(ttl)],
  );
}

async function readLockRow(lockId: string) {
  const { rows } = await engine.db.query(
    `SELECT holder_pid, holder_host FROM gbrain_cycle_locks WHERE id = $1`,
    [lockId],
  );
  return rows as Array<{ holder_pid: number; holder_host: string }>;
}

describe('tryAcquireDbLock — stale dead-PID eviction', () => {
  test('evicts a row whose holder PID is dead on this host (future TTL)', async () => {
    await seedStaleRow('gbrain-sync', { pid: 999999, ttlMinutesFromNow: 30 });

    const handle = await tryAcquireDbLock(engine, 'gbrain-sync', 30);
    expect(handle).not.toBeNull();
    expect(handle!.id).toBe('gbrain-sync');

    // The row was rewritten with our pid, not the dead one.
    const rows = await readLockRow('gbrain-sync');
    expect(rows).toHaveLength(1);
    expect(rows[0].holder_pid).toBe(process.pid);
    expect(rows[0].holder_host).toBe(hostname());

    await handle!.release();
  });

  test('leaves rows from a different host alone (PID probe skipped)', async () => {
    // A dead-looking PID on another host MUST NOT be evicted by us — we
    // cannot probe remote process tables, so TTL is the only safe signal.
    await seedStaleRow('gbrain-sync', {
      pid: 999999,
      host: 'some-other-host.example',
      ttlMinutesFromNow: 30,
    });

    const handle = await tryAcquireDbLock(engine, 'gbrain-sync', 30);
    // Live (cross-host) holder per TTL → acquire returns null
    expect(handle).toBeNull();

    // Row preserved untouched
    const rows = await readLockRow('gbrain-sync');
    expect(rows).toHaveLength(1);
    expect(rows[0].holder_pid).toBe(999999);
    expect(rows[0].holder_host).toBe('some-other-host.example');
  });

  test('leaves a live same-host holder alone', async () => {
    // `process.pid` is alive by definition (it's us). Seed a row with a
    // *different* same-host pid that we know is alive — PID 1 (init) is
    // always alive and replies to signal-0 with EPERM (not ESRCH), so it
    // must NOT be evicted.
    await seedStaleRow('gbrain-sync', { pid: 1, ttlMinutesFromNow: 30 });

    const handle = await tryAcquireDbLock(engine, 'gbrain-sync', 30);
    expect(handle).toBeNull();

    const rows = await readLockRow('gbrain-sync');
    expect(rows).toHaveLength(1);
    expect(rows[0].holder_pid).toBe(1);
  });

  test('TTL-expired path still wins when PID probe is inconclusive', async () => {
    // Cross-host holder with expired TTL: the PID probe is skipped (different
    // host), but the TTL-bounded upsert below evicts it via the WHERE clause.
    // Backdate via negative interval so ttl_expires_at < NOW().
    await seedStaleRow('gbrain-sync', {
      pid: 999999,
      host: 'some-other-host.example',
      ttlMinutesFromNow: -5,
    });

    const handle = await tryAcquireDbLock(engine, 'gbrain-sync', 30);
    expect(handle).not.toBeNull();

    const rows = await readLockRow('gbrain-sync');
    expect(rows[0].holder_pid).toBe(process.pid);
    expect(rows[0].holder_host).toBe(hostname());

    await handle!.release();
  });

  test('no existing row: clean INSERT path unaffected', async () => {
    const handle = await tryAcquireDbLock(engine, 'gbrain-sync', 30);
    expect(handle).not.toBeNull();

    const rows = await readLockRow('gbrain-sync');
    expect(rows[0].holder_pid).toBe(process.pid);

    await handle!.release();
  });

  test('does not evict our own current PID', async () => {
    // Seed a row with our own pid (simulating a re-acquire from same proc).
    // The probe MUST skip same-pid rows; the upsert below either no-ops
    // (TTL still live) or refreshes (TTL expired). Either way the row
    // doesn't get DELETE'd by the new staleness path.
    await seedStaleRow('gbrain-sync', { pid: process.pid, ttlMinutesFromNow: 30 });

    const handle = await tryAcquireDbLock(engine, 'gbrain-sync', 30);
    // TTL still live → upsert WHERE fails → live holder → null
    expect(handle).toBeNull();

    const rows = await readLockRow('gbrain-sync');
    expect(rows).toHaveLength(1);
    expect(rows[0].holder_pid).toBe(process.pid);
  });
});
