/**
 * v0.41.6.0 D3 — inspectLock + listStaleLocks + deleteLockRow.
 *
 * Hermetic PGLite tests for the new lock-inspector / atomic-delete
 * primitives. Covers:
 *   - inspectLock shape (returns LockSnapshot or null)
 *   - inspectLock age_ms computation + ttl_expired flag
 *   - listStaleLocks filters by ttl_expires_at < NOW()
 *   - deleteLockRow atomic verify-and-delete with RETURNING
 *   - deleteLockRow idempotent on race (returns deleted=false when row already gone)
 *
 * --break-lock CLI flag logic (PID-liveness + 60s age guard) is covered
 * by E2E tests since it requires real subprocess spawning to verify
 * process.kill(pid, 0) semantics.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  tryAcquireDbLock,
  inspectLock,
  listStaleLocks,
  deleteLockRow,
  liveSyncStatus,
  syncLockId,
} from '../src/core/db-lock.ts';

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

describe('inspectLock', () => {
  test('returns null when no row exists', async () => {
    const snap = await inspectLock(engine, 'gbrain-sync:test-source');
    expect(snap).toBeNull();
  });

  test('returns LockSnapshot shape after tryAcquireDbLock', async () => {
    const handle = await tryAcquireDbLock(engine, 'gbrain-sync:default');
    expect(handle).not.toBeNull();
    const snap = await inspectLock(engine, 'gbrain-sync:default');
    expect(snap).not.toBeNull();
    expect(snap!.id).toBe('gbrain-sync:default');
    expect(snap!.holder_pid).toBe(process.pid);
    expect(typeof snap!.holder_host).toBe('string');
    expect(snap!.holder_host.length).toBeGreaterThan(0);
    expect(snap!.acquired_at).toBeInstanceOf(Date);
    expect(snap!.ttl_expires_at).toBeInstanceOf(Date);
    expect(snap!.age_ms).toBeGreaterThanOrEqual(0);
    expect(snap!.age_ms).toBeLessThan(5000);
    expect(snap!.ttl_expired).toBe(false); // fresh lock
    await handle!.release();
  });

  test('ttl_expired=true after the TTL has elapsed', async () => {
    // Use a 0-minute TTL via raw INSERT to simulate an expired lock.
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')`,
      ['gbrain-sync:stale', 99999, 'old-host'],
    );
    const snap = await inspectLock(engine, 'gbrain-sync:stale');
    expect(snap).not.toBeNull();
    expect(snap!.ttl_expired).toBe(true);
    expect(snap!.age_ms).toBeGreaterThan(3000_000); // > 50 min in ms
  });
});

describe('listStaleLocks', () => {
  test('returns empty when no stale rows exist', async () => {
    const handle = await tryAcquireDbLock(engine, 'gbrain-sync:fresh');
    expect(handle).not.toBeNull();
    const stale = await listStaleLocks(engine);
    expect(stale).toEqual([]);
    await handle!.release();
  });

  test('returns only rows where ttl_expires_at < NOW()', async () => {
    // Insert one fresh + one stale.
    const handle = await tryAcquireDbLock(engine, 'gbrain-sync:still-live');
    expect(handle).not.toBeNull();
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')`,
      ['gbrain-sync:stale-A', 11111, 'host-A'],
    );
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      ['gbrain-sync:stale-B', 22222, 'host-B'],
    );

    const stale = await listStaleLocks(engine);
    const ids = stale.map(s => s.id).sort();
    expect(ids).toEqual(['gbrain-sync:stale-A', 'gbrain-sync:stale-B']);
    expect(stale.every(s => s.ttl_expired)).toBe(true);
    await handle!.release();
  });

  test('orders by acquired_at ascending', async () => {
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')`,
      ['gbrain-sync:newer-stale', 11111, 'h1'],
    );
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours')`,
      ['gbrain-sync:older-stale', 22222, 'h2'],
    );

    const stale = await listStaleLocks(engine);
    // Older-stale was acquired first → ordered first.
    expect(stale[0].id).toBe('gbrain-sync:older-stale');
    expect(stale[1].id).toBe('gbrain-sync:newer-stale');
  });
});

describe('deleteLockRow', () => {
  test('deletes the row + RETURNING returns it when (id, pid) matches', async () => {
    const handle = await tryAcquireDbLock(engine, 'gbrain-sync:to-delete');
    expect(handle).not.toBeNull();
    const result = await deleteLockRow(engine, 'gbrain-sync:to-delete', process.pid);
    expect(result.deleted).toBe(true);
    // Row should be gone.
    const snap = await inspectLock(engine, 'gbrain-sync:to-delete');
    expect(snap).toBeNull();
    // handle.release() would also have run a DELETE — verify it's idempotent.
    await handle!.release();
  });

  test('returns deleted=false when row was already cleared (race)', async () => {
    // Insert a row, then delete it directly, then call deleteLockRow.
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 minutes')`,
      ['gbrain-sync:race-target', 11111, 'h1'],
    );
    await (engine as any).db.query(
      `DELETE FROM gbrain_cycle_locks WHERE id = $1`,
      ['gbrain-sync:race-target'],
    );
    const result = await deleteLockRow(engine, 'gbrain-sync:race-target', 11111);
    expect(result.deleted).toBe(false);
  });

  test('refuses to delete when pid does not match (preserves cross-host safety)', async () => {
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 minutes')`,
      ['gbrain-sync:wrong-pid', 11111, 'h1'],
    );
    const result = await deleteLockRow(engine, 'gbrain-sync:wrong-pid', 22222);
    expect(result.deleted).toBe(false);
    // Row should still exist.
    const snap = await inspectLock(engine, 'gbrain-sync:wrong-pid');
    expect(snap).not.toBeNull();
    expect(snap!.holder_pid).toBe(11111);
  });

  test('atomic shape: single round trip (RETURNING in same statement)', async () => {
    // We can't directly observe atomicity, but we can verify the shape:
    // there is no separate SELECT-then-DELETE pattern visible to callers.
    // This test exists as a regression guard against splitting the
    // DELETE...RETURNING into a SELECT-check + DELETE later.
    const handle = await tryAcquireDbLock(engine, 'gbrain-sync:atomic-test');
    expect(handle).not.toBeNull();
    const r = await deleteLockRow(engine, 'gbrain-sync:atomic-test', process.pid);
    expect(r.deleted).toBe(true);
    // Calling again is a no-op (idempotent).
    const r2 = await deleteLockRow(engine, 'gbrain-sync:atomic-test', process.pid);
    expect(r2.deleted).toBe(false);
    await handle!.release();
  });
});

describe('liveSyncStatus (#1950)', () => {
  test('returns null when the source holds no lock (idle)', async () => {
    const live = await liveSyncStatus(engine, 'never-synced');
    expect(live).toBeNull();
  });

  test('returns the holder when a live (non-expired) sync lock is held', async () => {
    const handle = await tryAcquireDbLock(engine, syncLockId('busy-source'));
    expect(handle).not.toBeNull();
    const live = await liveSyncStatus(engine, 'busy-source');
    expect(live).not.toBeNull();
    expect(live!.holder_pid).toBe(process.pid);
    expect(typeof live!.holder_host).toBe('string');
    expect(live!.holder_host.length).toBeGreaterThan(0);
    await handle!.release();
  });

  test('returns null for a stale (TTL-expired) lock — structurally available, not running', async () => {
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      [syncLockId('wedged-dead'), 31337, 'old-host'],
    );
    const live = await liveSyncStatus(engine, 'wedged-dead');
    expect(live).toBeNull();
  });

  test('is scoped per source — one source live does not mark another running', async () => {
    const handle = await tryAcquireDbLock(engine, syncLockId('source-a'));
    expect(handle).not.toBeNull();
    expect(await liveSyncStatus(engine, 'source-a')).not.toBeNull();
    expect(await liveSyncStatus(engine, 'source-b')).toBeNull();
    await handle!.release();
  });
});
