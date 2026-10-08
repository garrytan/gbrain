/**
 * #6242: lease-set primitive for a source cycle that also needs the shared
 * maintenance lease. Pins non-waiting acquisition in fixed order with
 * duplicates dropped, rollback on a busy required lease or a throw, the
 * busy-optional degrade, fenced refresh and release-every-lease semantics,
 * and the maintenance_lock_busy skip shape.
 */
import { describe, test, expect } from 'bun:test';
import { acquireLeaseSet, combineLeases, maintenanceLockBusySkip, type Lease } from '../src/core/cycle/lock-set.ts';

type Log = string[];

function fakeAcquire(log: Log, opts: { busy?: string[]; throwOn?: string[]; refreshFalse?: string[]; releaseThrows?: string[] } = {}) {
  return async (id: string): Promise<Lease | null> => {
    log.push(`acquire:${id}`);
    if (opts.throwOn?.includes(id)) throw new Error(`boom:${id}`);
    if (opts.busy?.includes(id)) return null;
    return {
      refresh: async () => { log.push(`refresh:${id}`); return !opts.refreshFalse?.includes(id); },
      release: async () => {
        log.push(`release:${id}`);
        if (opts.releaseThrows?.includes(id)) throw new Error(`release:${id}`);
      },
    };
  };
}

describe('acquireLeaseSet', () => {
  test('acquires required then optional ids in order, once each', async () => {
    const log: Log = [];
    const r = await acquireLeaseSet(['src', 'src'], fakeAcquire(log), ['shared', 'src']);
    expect(r.status).toBe('acquired');
    expect(r.status === 'acquired' && r.busyOptional).toBeNull();
    expect(log).toEqual(['acquire:src', 'acquire:shared']);
    if (r.status === 'acquired') await r.lease.release();
    expect(log.slice(2)).toEqual(['release:shared', 'release:src']);
  });

  test('a busy required lease releases what was taken and names the busy id', async () => {
    const log: Log = [];
    const r = await acquireLeaseSet(['a', 'b'], fakeAcquire(log, { busy: ['b'] }), ['shared']);
    expect(r).toEqual({ status: 'busy', busyId: 'b' });
    expect(log).toEqual(['acquire:a', 'acquire:b', 'release:a']);
  });

  test('a busy optional lease keeps the required ones and reports it', async () => {
    const log: Log = [];
    const r = await acquireLeaseSet(['src'], fakeAcquire(log, { busy: ['shared'] }), ['shared']);
    expect(r.status).toBe('acquired');
    if (r.status !== 'acquired') return;
    expect(r.busyOptional).toBe('shared');
    expect(log).toEqual(['acquire:src', 'acquire:shared']);
    await r.lease.release();
    expect(log.slice(2)).toEqual(['release:src']);
  });

  test('an acquire that throws rolls back every lease taken and rethrows', async () => {
    const log: Log = [];
    await expect(acquireLeaseSet(['src'], fakeAcquire(log, { throwOn: ['shared'] }), ['shared'])).rejects.toThrow('boom:shared');
    expect(log).toEqual(['acquire:src', 'acquire:shared', 'release:src']);
  });
});

describe('combineLeases', () => {
  test('refresh is fenced: false at the first lost lease, later ones untouched', async () => {
    const log: Log = [];
    const acquire = fakeAcquire(log, { refreshFalse: ['a'] });
    const lease = combineLeases([(await acquire('a'))!, (await acquire('b'))!]);
    log.length = 0;
    expect(await lease.refresh()).toBe(false);
    expect(log).toEqual(['refresh:a']);
  });

  test('release attempts every lease and rethrows the first failure', async () => {
    const log: Log = [];
    const acquire = fakeAcquire(log, { releaseThrows: ['b', 'a'] });
    const lease = combineLeases([(await acquire('a'))!, (await acquire('b'))!, (await acquire('c'))!]);
    log.length = 0;
    await expect(lease.release()).rejects.toThrow('release:b');
    expect(log).toEqual(['release:c', 'release:b', 'release:a']);
  });
});

describe('maintenanceLockBusySkip', () => {
  test('is a skipped phase with code, why, holder and a read-only verify', () => {
    const r = maintenanceLockBusySkip('patterns', { id: 'gbrain-cycle', holder_pid: 42, holder_host: 'worker-1', age_ms: 1000 } as never);
    expect(r.status).toBe('skipped');
    expect(r.phase).toBe('patterns');
    expect(r.summary).toContain('pid 42 on worker-1');
    const d = r.details as Record<string, any>;
    expect(d.reason).toBe('maintenance_lock_busy');
    expect(d.code).toBe('maintenance_lock_busy');
    expect(d.phase_scope).toBe('mixed');
    expect(d.lock_holder).toEqual({ id: 'gbrain-cycle', holder_pid: 42, holder_host: 'worker-1', age_ms: 1000 });
    expect(typeof d.why).toBe('string');
    expect(d.fix.argv).toEqual(['gbrain', 'dream', '--phase', 'patterns']);
    expect(d.fix.consent).toEqual(['paid']);
    expect(d.fix.verify.argv).toEqual(['gbrain', 'status', '--section', 'locks', '--json']);
  });
});
