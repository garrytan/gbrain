/**
 * BrainEngine parity — cycle locks family (the `gbrain_cycle_locks` lease rows
 * the cycle, sync and import filesystem locks take) plus the typed read of the
 * registered source paths `withSourceFilesystemLock` uses to pick a lock root.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: acquiring, renewing, releasing, reading and deleting a lock
 *    lease returns the same observable result on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts): who wins a contested lock, when an
 *    expired lease can be stolen, and that a stale token never touches a
 *    newer holder's row.
 *  - Regression: an engine that drifts on the steal rules (TTL expiry, the
 *    steal grace that protects a starved-but-alive holder), on token fencing
 *    for renew/release/delete, or on the stale and age-gated reads — the
 *    rules that keep two importers off one directory and a dead holder from
 *    wedging `gbrain import`.
 *  - Why existing coverage misses it: test/db-lock-concurrency.test.ts and
 *    test/e2e/db-lock-acquisition-token.test.ts exercise one engine each and
 *    reach the lease through `db-lock.ts`; nothing compares the two engines on
 *    one scenario, and a Rust engine has no raw SQL to fall back on.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Lease
 *    ages are made by negative TTLs and zero/large steal graces, never by
 *    sleeping; the cases return pids, hosts, tokens and booleans, never
 *    timestamps.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, CycleLockRow } from '../../src/core/engine.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const TOKEN_A = '00000000-0000-4000-8000-00000000000a';
const TOKEN_B = '00000000-0000-4000-8000-00000000000b';
const TOKEN_C = '00000000-0000-4000-8000-00000000000c';

/** The lease a holder takes: a long TTL and no steal grace unless the case says otherwise. */
function lease(pid: number, token: string, extra: { ttlMinutes?: number; stealGraceSeconds?: number } = {}) {
  return { holderPid: pid, holderHost: `host-${pid}`, acquisitionToken: token, ttlMinutes: 30, stealGraceSeconds: 0, ...extra };
}

/** A row as the engines must agree on it: identity and holder, no clock readings. */
const view = (r: CycleLockRow) => ({
  id: r.id,
  holder_pid: r.holder_pid,
  holder_host: r.holder_host,
  acquisition_token: r.acquisition_token,
  refreshed: r.last_refreshed_at !== null,
});
const views = (rows: CycleLockRow[]) => sorted(rows.map(view), (r) => r.id);
const idsOf = (rows: CycleLockRow[]) => sorted(rows.map((r) => r.id), (id) => id);

/** What `acquireCycleLock` returned, minus the fence text (the database's epoch, different per arm). */
const acquired = (r: { id: string; fence: string } | null) => (r ? { id: r.id, fenced: r.fence.length > 0 } : null);

async function holderOf(engine: BrainEngine, lockId: string) {
  const [row] = await engine.readCycleLocks({ by: 'id', lockId });
  return row ? view(row) : null;
}

describe('engine parity: cycle locks', () => {
  parityTest('a free lock is acquired, a held lock is refused', { methods: ['acquireCycleLock', 'readCycleLocks'] }, async (engine) => {
    const first = await engine.acquireCycleLock('gbrain-fs:one', lease(101, TOKEN_A));
    const second = await engine.acquireCycleLock('gbrain-fs:one', lease(102, TOKEN_B));
    expect(first?.id).toBe('gbrain-fs:one');
    expect(second).toBeNull();
    const holder = await holderOf(engine, 'gbrain-fs:one');
    expect(holder).toMatchObject({ holder_pid: 101, holder_host: 'host-101', acquisition_token: TOKEN_A, refreshed: true });
    // A different lock id is independent.
    const other = await engine.acquireCycleLock('gbrain-fs:two', lease(102, TOKEN_B));
    return { first: acquired(first), second: acquired(second), other: acquired(other), holder };
  });

  parityTest('an expired lease is stolen once the steal grace has passed', { methods: ['acquireCycleLock', 'readCycleLocks'] }, async (engine) => {
    // ttlMinutes -1: the lease is expired the moment it is written. A grace of -1 second: PGLite's clock ticks in
    // milliseconds, so two statements in the same millisecond see equal NOW() and a zero grace would not yet pass.
    const first = await engine.acquireCycleLock('gbrain-sync:work', lease(201, TOKEN_A, { ttlMinutes: -1 }));
    const stolen = await engine.acquireCycleLock('gbrain-sync:work', lease(202, TOKEN_B, { stealGraceSeconds: -1 }));
    expect(first).not.toBeNull();
    expect(stolen).not.toBeNull();
    const holder = await holderOf(engine, 'gbrain-sync:work');
    expect(holder).toMatchObject({ holder_pid: 202, acquisition_token: TOKEN_B });
    // The new lease is live: a third taker is refused.
    const third = await engine.acquireCycleLock('gbrain-sync:work', lease(203, TOKEN_C));
    return { first: acquired(first), stolen: acquired(stolen), third: acquired(third), holder };
  });

  parityTest('the steal grace protects an expired lease that refreshed recently', { methods: ['acquireCycleLock', 'readCycleLocks'] }, async (engine) => {
    await engine.acquireCycleLock('gbrain-sync:grace', lease(301, TOKEN_A, { ttlMinutes: -1 }));
    // Expired, but refreshed within the hour: a starved-but-alive holder is not stolen from.
    const protectedFromSteal = await engine.acquireCycleLock('gbrain-sync:grace', lease(302, TOKEN_B, { stealGraceSeconds: 3600 }));
    expect(protectedFromSteal).toBeNull();
    const holder = await holderOf(engine, 'gbrain-sync:grace');
    expect(holder).toMatchObject({ holder_pid: 301, acquisition_token: TOKEN_A });
    return { protectedFromSteal: acquired(protectedFromSteal), holder };
  });

  parityTest('refresh renews only the holder that owns the token', { methods: ['acquireCycleLock', 'refreshCycleLock', 'readCycleLocks'] }, async (engine) => {
    await engine.acquireCycleLock('gbrain-cycle', lease(401, TOKEN_A, { ttlMinutes: -1 }));
    expect((await engine.readCycleLocks({ by: 'stale' })).map((r) => r.id)).toEqual(['gbrain-cycle']);
    const wrongToken = await engine.refreshCycleLock('gbrain-cycle', { holderPid: 401, acquisitionToken: TOKEN_B, ttlMinutes: 30 });
    const wrongPid = await engine.refreshCycleLock('gbrain-cycle', { holderPid: 999, acquisitionToken: TOKEN_A, ttlMinutes: 30 });
    const stillStale = idsOf(await engine.readCycleLocks({ by: 'stale' }));
    const own = await engine.refreshCycleLock('gbrain-cycle', { holderPid: 401, acquisitionToken: TOKEN_A, ttlMinutes: 30 });
    const afterOwn = idsOf(await engine.readCycleLocks({ by: 'stale' }));
    const missing = await engine.refreshCycleLock('gbrain-no-such-lock', { holderPid: 401, acquisitionToken: TOKEN_A, ttlMinutes: 30 });
    expect({ wrongToken, wrongPid, own, missing }).toEqual({ wrongToken: false, wrongPid: false, own: true, missing: false });
    expect(stillStale).toEqual(['gbrain-cycle']);
    expect(afterOwn).toEqual([]);
    return { wrongToken, wrongPid, own, missing, stillStale, afterOwn };
  });

  parityTest('release deletes the row only for the holder, and frees the lock', { methods: ['acquireCycleLock', 'releaseCycleLock', 'readCycleLocks'] }, async (engine) => {
    await engine.acquireCycleLock('gbrain-fs:rel', lease(501, TOKEN_A));
    const wrongToken = await engine.releaseCycleLock('gbrain-fs:rel', { holderPid: 501, acquisitionToken: TOKEN_B });
    const wrongPid = await engine.releaseCycleLock('gbrain-fs:rel', { holderPid: 502, acquisitionToken: TOKEN_A });
    const heldAfterWrong = await holderOf(engine, 'gbrain-fs:rel');
    const own = await engine.releaseCycleLock('gbrain-fs:rel', { holderPid: 501, acquisitionToken: TOKEN_A });
    const again = await engine.releaseCycleLock('gbrain-fs:rel', { holderPid: 501, acquisitionToken: TOKEN_A });
    const heldAfterOwn = await holderOf(engine, 'gbrain-fs:rel');
    // Free again: the next taker wins.
    const reacquired = await engine.acquireCycleLock('gbrain-fs:rel', lease(503, TOKEN_C));
    expect({ wrongToken, wrongPid, own, again }).toEqual({ wrongToken: false, wrongPid: false, own: true, again: false });
    expect(heldAfterWrong).toMatchObject({ holder_pid: 501, acquisition_token: TOKEN_A });
    expect(heldAfterOwn).toBeNull();
    expect(reacquired).not.toBeNull();
    return { wrongToken, wrongPid, own, again, heldAfterWrong, heldAfterOwn, reacquired: acquired(reacquired) };
  });

  parityTest('readCycleLocks reads by id, by ids, stale, and all', { methods: ['acquireCycleLock', 'readCycleLocks'] }, async (engine) => {
    await engine.acquireCycleLock('gbrain-fs:live', lease(601, TOKEN_A));
    await engine.acquireCycleLock('gbrain-sync:dead', lease(602, TOKEN_B, { ttlMinutes: -1 }));
    await engine.acquireCycleLock('gbrain-cycle', lease(603, TOKEN_C));
    const byId = await engine.readCycleLocks({ by: 'id', lockId: 'gbrain-sync:dead' });
    const byIdMissing = await engine.readCycleLocks({ by: 'id', lockId: 'gbrain-nope' });
    const byIds = await engine.readCycleLocks({ by: 'ids', lockIds: ['gbrain-cycle', 'gbrain-fs:live', 'gbrain-nope'] });
    const byNoIds = await engine.readCycleLocks({ by: 'ids', lockIds: [] });
    const stale = await engine.readCycleLocks({ by: 'stale' });
    const all = await engine.readCycleLocks({ by: 'all' });
    expect(byIdMissing).toEqual([]);
    expect(byNoIds).toEqual([]);
    expect(idsOf(stale)).toEqual(['gbrain-sync:dead']);
    // Every row carries the database clock the ages compare against.
    expect(all.every((r) => r.db_now !== undefined && r.db_now !== null)).toBe(true);
    return { byId: views(byId), byIdMissing, byIds: views(byIds), byNoIds, stale: views(stale), all: views(all) };
  });

  parityTest('deleteCycleLock removes the row only for the observed holder', { methods: ['acquireCycleLock', 'deleteCycleLock', 'readCycleLocks'] }, async (engine) => {
    await engine.acquireCycleLock('gbrain-sync:del', lease(701, TOKEN_A));
    // A reused pid or a replaced holder must not delete the live row.
    const wrongToken = await engine.deleteCycleLock('gbrain-sync:del', { holderPid: 701, acquisitionToken: TOKEN_B });
    const wrongPid = await engine.deleteCycleLock('gbrain-sync:del', { holderPid: 702, acquisitionToken: TOKEN_A });
    const kept = await holderOf(engine, 'gbrain-sync:del');
    const own = await engine.deleteCycleLock('gbrain-sync:del', { holderPid: 701, acquisitionToken: TOKEN_A });
    const again = await engine.deleteCycleLock('gbrain-sync:del', { holderPid: 701, acquisitionToken: TOKEN_A });
    const gone = await holderOf(engine, 'gbrain-sync:del');
    expect({ wrongToken, wrongPid, own, again }).toEqual({ wrongToken: false, wrongPid: false, own: true, again: false });
    expect(kept).toMatchObject({ holder_pid: 701, acquisition_token: TOKEN_A });
    expect(gone).toBeNull();
    return { wrongToken, wrongPid, own, again, kept, gone };
  });

  parityTest('deleteCycleLockIfStale removes only a holder that stopped refreshing', { methods: ['acquireCycleLock', 'deleteCycleLockIfStale', 'readCycleLocks'] }, async (engine) => {
    await engine.acquireCycleLock('gbrain-sync:wedged', lease(801, TOKEN_A));
    // Refreshed just now: a one-hour age gate leaves it alone.
    const young = await engine.deleteCycleLockIfStale('gbrain-sync:wedged', { holderPid: 801, acquisitionToken: TOKEN_A, maxAgeSeconds: 3600 });
    const keptYoung = await holderOf(engine, 'gbrain-sync:wedged');
    // A negative age gate makes any refreshed row stale. The wrong token still deletes nothing.
    const wrongToken = await engine.deleteCycleLockIfStale('gbrain-sync:wedged', { holderPid: 801, acquisitionToken: TOKEN_B, maxAgeSeconds: -3600 });
    const wrongPid = await engine.deleteCycleLockIfStale('gbrain-sync:wedged', { holderPid: 802, acquisitionToken: TOKEN_A, maxAgeSeconds: -3600 });
    const kept = await holderOf(engine, 'gbrain-sync:wedged');
    const stale = await engine.deleteCycleLockIfStale('gbrain-sync:wedged', { holderPid: 801, acquisitionToken: TOKEN_A, maxAgeSeconds: -3600 });
    const gone = await holderOf(engine, 'gbrain-sync:wedged');
    const again = await engine.deleteCycleLockIfStale('gbrain-sync:wedged', { holderPid: 801, acquisitionToken: TOKEN_A, maxAgeSeconds: -3600 });
    expect(young).toEqual({ deleted: false, lastRefreshedAt: null });
    expect(wrongToken.deleted).toBe(false);
    expect(wrongPid.deleted).toBe(false);
    expect(stale.deleted).toBe(true);
    expect(stale.lastRefreshedAt).toBeInstanceOf(Date);
    expect(again).toEqual({ deleted: false, lastRefreshedAt: null });
    return {
      young, keptYoung, wrongToken, wrongPid, kept,
      stale: { deleted: stale.deleted, dated: stale.lastRefreshedAt instanceof Date }, gone, again,
    };
  });

  parityTest('listSourceLocalPaths returns every registered path and drops sources without one', { methods: ['listSourceLocalPaths'] }, async (engine, backend) => {
    await createSource(engine, backend, 'with-path-a', {}, '/srv/brain/a');
    await createSource(engine, backend, 'with-path-b', {}, '/srv/brain/b');
    await createSource(engine, backend, 'empty-path', {}, '');
    await createSource(engine, backend, 'no-path');
    const paths = sorted(await engine.listSourceLocalPaths(), (p) => p);
    expect(paths).toEqual(['/srv/brain/a', '/srv/brain/b']);
    return paths;
  });
});
