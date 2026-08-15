/**
 * v0.41.13.0 — PGLite tests for the sync break-lock + max-age + abort
 * threading wave.
 *
 * Coverage diagram targets:
 *   - tryAcquireDbLock writes last_refreshed_at = NOW() on INSERT (R4 baseline).
 *   - withRefreshingLock-style refresh bumps both ttl_expires_at AND
 *     last_refreshed_at (R5 + new column).
 *   - inspectLock surfaces last_refreshed_at + ms_since_last_refresh.
 *   - deleteLockRowIfStale: refuses fresh, breaks stale, holder_pid mismatch
 *     refuses, NULL last_refreshed_at refuses (pre-v98-style row).
 *   - migration v98 backfills last_refreshed_at = NOW() (R6).
 *
 * Test isolation: canonical PGLite block per CLAUDE.md R3 + R4. No
 * top-level module mocks (R2 — `mock.module` calls leak across files in
 * the shard process); no process.env mutations.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  tryAcquireDbLock,
  inspectLock,
  deleteLockRow,
  deleteLockRowIfStale,
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
  // Also clear gbrain_cycle_locks since resetPgliteState focuses on user data
  // and the lock table is per-test state we want fresh.
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks', []);
});

// Helper: read raw row for assertions against the new column shape.
async function readLockRow(lockId: string) {
  const rows = await engine.executeRaw<{
    id: string;
    holder_pid: number;
    acquired_at: string;
    ttl_expires_at: string;
    last_refreshed_at: string | null;
  }>(
    `SELECT id, holder_pid, acquired_at, ttl_expires_at, last_refreshed_at
       FROM gbrain_cycle_locks WHERE id = $1`,
    [lockId],
  );
  return rows[0] ?? null;
}

describe('tryAcquireDbLock writes last_refreshed_at (v0.41.13.0 T5)', () => {
  test('fresh INSERT sets last_refreshed_at to a non-null timestamp', async () => {
    const handle = await tryAcquireDbLock(engine, 'test:fresh-acquire', 30);
    expect(handle).not.toBeNull();
    const row = await readLockRow('test:fresh-acquire');
    expect(row).not.toBeNull();
    expect(row!.last_refreshed_at).not.toBeNull();
    // The acquired_at and last_refreshed_at are set in the same INSERT
    // (both NOW()) so they should be within a few ms of each other.
    const acq = new Date(row!.acquired_at).getTime();
    const ref = new Date(row!.last_refreshed_at!).getTime();
    expect(Math.abs(acq - ref)).toBeLessThan(1000);
    await handle!.release();
  });

  test('takeover (TTL-expired) refreshes last_refreshed_at too', async () => {
    // Insert a stale lock row directly with TTL already expired AND an OLD
    // last_refreshed_at so we can verify the takeover bumps it.
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, $4, $5, $4)`,
      ['test:takeover', 99999, 'fake-host', oldTs, oldTs],
    );
    const before = await readLockRow('test:takeover');
    // PGLite returns timestamps as Date objects; normalize via .toISOString().
    expect(new Date(before!.last_refreshed_at!).toISOString()).toBe(oldTs);

    const handle = await tryAcquireDbLock(engine, 'test:takeover', 30);
    expect(handle).not.toBeNull();

    const after = await readLockRow('test:takeover');
    expect(new Date(after!.last_refreshed_at!).toISOString()).not.toBe(oldTs);
    // After takeover, last_refreshed_at should be recent.
    const refMs = new Date(after!.last_refreshed_at!).getTime();
    expect(Date.now() - refMs).toBeLessThan(5000);
    await handle!.release();
  });

  test('refresh() bumps both ttl_expires_at AND last_refreshed_at', async () => {
    const handle = await tryAcquireDbLock(engine, 'test:refresh', 30);
    expect(handle).not.toBeNull();
    const before = await readLockRow('test:refresh');

    // Sleep just a hair so the timestamp changes are observable.
    await new Promise(r => setTimeout(r, 50));
    await handle!.refresh();

    const after = await readLockRow('test:refresh');
    expect(new Date(after!.ttl_expires_at).getTime()).toBeGreaterThan(
      new Date(before!.ttl_expires_at).getTime(),
    );
    expect(new Date(after!.last_refreshed_at!).getTime()).toBeGreaterThan(
      new Date(before!.last_refreshed_at!).getTime(),
    );
    await handle!.release();
  });
});

describe('inspectLock surfaces last_refreshed_at (v0.41.13.0 T5)', () => {
  test('returns last_refreshed_at + ms_since_last_refresh on a live lock', async () => {
    const handle = await tryAcquireDbLock(engine, 'test:inspect', 30);
    expect(handle).not.toBeNull();
    const snap = await inspectLock(engine, 'test:inspect');
    expect(snap).not.toBeNull();
    expect(snap!.last_refreshed_at).toBeInstanceOf(Date);
    expect(snap!.ms_since_last_refresh).not.toBeNull();
    // Fresh acquire → ms_since_last_refresh should be tiny.
    expect(snap!.ms_since_last_refresh!).toBeLessThan(5000);
    await handle!.release();
  });

  test('returns null for last_refreshed_at when the row has NULL (pre-v98 fallback)', async () => {
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('test:null-ref', 12345, 'h', NOW(), NOW() + INTERVAL '30 minutes', NULL)`,
      [],
    );
    const snap = await inspectLock(engine, 'test:null-ref');
    expect(snap).not.toBeNull();
    expect(snap!.last_refreshed_at).toBeNull();
    expect(snap!.ms_since_last_refresh).toBeNull();
  });

  test('returns null for absent lock', async () => {
    const snap = await inspectLock(engine, 'test:does-not-exist');
    expect(snap).toBeNull();
  });
});

describe('deleteLockRowIfStale (v0.41.13.0 T4 + D-V4-mech-4/5)', () => {
  test('refuses to break a fresh lock (no rows deleted)', async () => {
    const handle = await tryAcquireDbLock(engine, 'test:fresh', 30);
    expect(handle).not.toBeNull();
    const snap = await inspectLock(engine, 'test:fresh');

    // max-age 1800s (30 min); lock is fresh → refuse.
    const result = await deleteLockRowIfStale(engine, 'test:fresh', snap!.holder_pid, 1800);
    expect(result.deleted).toBe(false);
    expect(result.lastRefreshedAt).toBeNull();

    // Row still present after the no-op delete.
    const after = await readLockRow('test:fresh');
    expect(after).not.toBeNull();
    await handle!.release();
  });

  test('breaks a stale lock (last_refreshed_at older than max-age)', async () => {
    // Insert a row with last_refreshed_at 1 hour ago.
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('test:stale', 54321, 'h', NOW(), NOW() + INTERVAL '30 minutes', $1)`,
      [oldTs],
    );
    // max-age 1800s (30 min); lock has not refreshed in 1h → break.
    const result = await deleteLockRowIfStale(engine, 'test:stale', 54321, 1800);
    expect(result.deleted).toBe(true);
    expect(result.lastRefreshedAt).toBeInstanceOf(Date);
    expect(Math.abs(result.lastRefreshedAt!.getTime() - new Date(oldTs).getTime()))
      .toBeLessThan(1000);
    // Row gone.
    expect(await readLockRow('test:stale')).toBeNull();
  });

  test('refuses on holder_pid mismatch (PID-safe)', async () => {
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('test:wrong-pid', 11111, 'h', NOW(), NOW() + INTERVAL '30 minutes', $1)`,
      [oldTs],
    );
    // Even though the lock IS stale, mismatched pid → refuse.
    const result = await deleteLockRowIfStale(engine, 'test:wrong-pid', 22222, 1800);
    expect(result.deleted).toBe(false);
    // Row still present.
    expect(await readLockRow('test:wrong-pid')).not.toBeNull();
  });

  test('refuses when last_refreshed_at IS NULL (pre-v98 row)', async () => {
    // A row with NULL last_refreshed_at is conservatively kept alive — the
    // operator should run apply-migrations or use --force-break-lock.
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('test:null-ref-stale', 33333, 'h', NOW() - INTERVAL '2 hours', NOW() + INTERVAL '30 minutes', NULL)`,
      [],
    );
    const result = await deleteLockRowIfStale(engine, 'test:null-ref-stale', 33333, 1800);
    expect(result.deleted).toBe(false);
    expect(await readLockRow('test:null-ref-stale')).not.toBeNull();
  });

  test('refuses on absent row', async () => {
    const result = await deleteLockRowIfStale(engine, 'test:nonexistent', 12345, 1800);
    expect(result.deleted).toBe(false);
    expect(result.lastRefreshedAt).toBeNull();
  });
});

describe('R1 regression: existing deleteLockRow byte-stable', () => {
  test('safe deleteLockRow still works with the new column present', async () => {
    const handle = await tryAcquireDbLock(engine, 'test:r1', 30);
    expect(handle).not.toBeNull();
    const snap = await inspectLock(engine, 'test:r1');
    // Pre-v98 deleteLockRow shape (no maxAge, just id + pid).
    const result = await deleteLockRow(engine, 'test:r1', snap!.holder_pid);
    expect(result.deleted).toBe(true);
    expect(await readLockRow('test:r1')).toBeNull();
  });
});

describe('R6 regression: schema bootstrap includes last_refreshed_at column', () => {
  test('CREATE TABLE shape (from pglite-schema.ts snapshot) has the column', async () => {
    // information_schema.columns is the canonical introspection. If the
    // column is missing, the SELECT returns 0 rows.
    const rows = await engine.executeRaw<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'gbrain_cycle_locks' AND column_name = 'last_refreshed_at'`,
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toMatch(/timestamp/i);
    expect(rows[0].is_nullable).toBe('YES');
  });
});

// ============================================================================
// BUG 5 (v0.42.x) — honest --force-break-lock diagnostic when no lock is held.
// Previously --force-break-lock emitted the same terse "not held (nothing to
// break)" line and exited 0, sending operators down a dead end when a sync was
// wedged for a reason other than a held lock.
// ============================================================================
describe('BUG 5 — --force-break-lock honest no-lock diagnostic', () => {
  const LOCK = 'gbrain-sync:wiki';

  test('force + no lock → wedge_hint in JSON, status absent, rc 0', async () => {
    const { runBreakLock } = await import('../src/commands/sync.ts');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    let rc: number;
    try {
      rc = await runBreakLock(engine, LOCK, 'wiki', { force: true, json: true });
    } finally {
      console.log = orig;
    }
    expect(rc).toBe(0);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.status).toBe('absent');
    expect(parsed.lock).toBe(LOCK);
    expect(typeof parsed.wedge_hint).toBe('string');
    expect(parsed.wedge_hint).toContain('not a held lock');
  });

  test('force + no lock → human output carries the wedge hint, not the terse line', async () => {
    const { runBreakLock } = await import('../src/commands/sync.ts');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    let rc: number;
    try {
      rc = await runBreakLock(engine, LOCK, 'wiki', { force: true, json: false });
    } finally {
      console.log = orig;
    }
    expect(rc).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('nothing to break');
    expect(out).toContain('gbrain doctor');
    expect(out).not.toBe(`Lock ${LOCK} is not held (nothing to break).`);
  });

  test('non-force + no lock → unchanged terse line, no wedge_hint', async () => {
    const { runBreakLock } = await import('../src/commands/sync.ts');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    let rc: number;
    try {
      rc = await runBreakLock(engine, LOCK, 'wiki', { force: false, json: true });
    } finally {
      console.log = orig;
    }
    expect(rc).toBe(0);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.status).toBe('absent');
    expect(parsed.wedge_hint).toBeUndefined();
  });
});
