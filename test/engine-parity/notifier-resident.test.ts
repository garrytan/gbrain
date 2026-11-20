/**
 * BrainEngine parity — the resident notifier's three reads (src/core/notifier/resident.ts): which marker jobs are still
 * live (`sqlNotifierStore(...).liveJobs`), the commit a source's last sync reached (`residentNotifierOptions(...)
 * .lastCommit`) and whether a drain holds the source's lease (`runnerStart(...).drainHeld`, through `readDrainLease` in
 * src/core/persistence/sync-lease.ts). Three arms: PGLite always, Postgres with DATABASE_URL, Rust through
 * test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: liveJobs keeps the asked ids whose job is waiting, active, delayed, waiting-children or paused, and drops
 *    a finished, failed or missing job. lastCommit reads the source's last_commit: null before a sync, the advanced
 *    commit after it, null for a missing source. drainHeld reads false with no lease and true while a live holder holds
 *    it, and 'stalled' while a live holder has held it for the stall window with no progress; the lease reading names
 *    the holder's kind from its record, and its progress counts the source's managed commits (none on an unbound
 *    source).
 *  - Regression: the Rust engine refused the three raw reads and the drain lease's holder record writes. The notifier
 *    logged each refusal and went on blind: it could not tell a live marker job from a dead one, read no commit a run
 *    reached, and read a held lease without its holder's kind or progress; a sync could not take the drain lease at all.
 *  - Why existing coverage misses it: test/commit-notifier*.test.ts inject fake stores and seams, and
 *    test/sync-lease*.test.ts run PGLite or Postgres only.
 *  - Seam: one, for the stall case only: the lease rows the engine returns read as taken earlier (a Proxy over the
 *    engine shifts `acquired_at`), since no typed method backdates a lease and the stall window is five minutes. The
 *    engine still reads the rows, the holder record and the holder's progress. Otherwise real engines, the real
 *    resident store, options and runner seams, the real cycle lock and drain lease. Job ids are compared by the label
 *    of the job they name, and clock readings as present or absent.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision } from '../../src/core/minions/submission-authority.ts';
import { residentNotifierOptions, runnerStart, sqlNotifierStore } from '../../src/core/notifier/resident.ts';
import { HOLDER_STALL_MS, readDrainLease, withDrainLease, type DrainLeaseReading } from '../../src/core/persistence/sync-lease.ts';
import { syncLockId, tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { writeSyncAnchor } from '../../src/core/sync-anchor.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SYNCED = 'a'.repeat(40);

function values(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await engine.admitJob({ maxSpawnDepth: 5, insert: values(name, extra) },
    { decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY), parentAuthorityKind: () => null });
  return Number(out.row.id);
}

/** A lease reading as the engines must agree on it: the holder's identity and progress, clock readings as present. */
const leaseView = (lease: DrainLeaseReading | null) => lease && {
  live: lease.live, kind: lease.holder.kind, id: lease.holder.id, version: lease.holder.version !== null,
  pid: lease.holder.pid === process.pid, started: lease.holder.started_at !== null, progress: lease.holder.progress,
};

describe('engine parity: the resident notifier reads', () => {
  parityTest('liveJobs keeps the ids of live jobs and drops finished and missing ones', {
    methods: ['readLiveJobIds', 'pauseJob', 'cancelJobs'],
  }, async (engine) => {
    const waiting = await add(engine, 'work');
    const delayed = await add(engine, 'work', { status: 'delayed', delay_until: new Date(Date.now() + 3_600_000).toISOString() });
    const paused = await add(engine, 'work');
    await engine.pauseJob(paused);
    const done = await add(engine, 'other');
    await engine.cancelJobs([done]);
    const missing = Math.max(waiting, delayed, paused, done) + 1000;
    const label = new Map<number, string>([[waiting, 'waiting'], [delayed, 'delayed'], [paused, 'paused'], [done, 'done'], [missing, 'missing']]);
    const named = (ids: Set<number>) => [...ids].map(id => label.get(id) ?? `unasked:${id}`).sort();
    const store = sqlNotifierStore(engine);
    const observed = {
      live: named(await store.liveJobs([waiting, delayed, paused, done, missing])),
      none: named(await store.liveJobs([])),
      statuses: await Promise.all([waiting, delayed, paused, done].map(async id => (await engine.getJob(id))?.status ?? null)),
    };
    expect(observed).toEqual({ live: ['delayed', 'paused', 'waiting'], none: [], statuses: ['waiting', 'delayed', 'paused', 'cancelled'] });
    return observed;
  });

  parityTest('lastCommit reads the commit the source last synced', {
    methods: ['readSourceLastCommit', 'advanceSourceCommit'],
  }, async (engine, backend) => {
    for (const id of ['alpha', 'beta']) await createSource(engine, backend, id, {}, `/srv/brain/${id}`);
    await writeSyncAnchor(engine, 'alpha', 'last_commit', SYNCED);
    const lastCommit = residentNotifierOptions(engine, { resident: 'serve', log: () => {} }).lastCommit;
    const observed = { alpha: await lastCommit('alpha'), beta: await lastCommit('beta'), missing: await lastCommit('no-such-source') };
    expect(observed).toEqual({ alpha: SYNCED, beta: null, missing: null });
    return observed;
  });

  parityTest('drainHeld reads a held lease and its holder', {
    methods: ['readCycleLocks', 'readDrainLeaseBeacon', 'readDrainHolderProgress', 'writeDrainLeaseHolder', 'releaseDrainLeaseHolder'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    const drainHeld = runnerStart(engine).drainHeld!;
    const free = { held: await drainHeld('alpha'), lease: leaseView(await readDrainLease(engine, 'alpha')) };
    const handle = await tryAcquireDbLock(engine, syncLockId('alpha'));
    expect(handle).not.toBeNull();
    const locked = { held: await drainHeld('alpha'), lease: leaseView(await readDrainLease(engine, 'alpha')) };
    await handle!.release();
    let draining: unknown = null;
    await withDrainLease(engine, 'alpha', { holder: { kind: 'job', id: '7' } }, async () => {
      draining = { held: await drainHeld('alpha'), lease: leaseView(await readDrainLease(engine, 'alpha')) };
      return { status: 'up_to_date' } as unknown as SyncResult;
    });
    const after = { held: await drainHeld('alpha'), lease: leaseView(await readDrainLease(engine, 'alpha')) };
    const none = { committed: 0, last_committed_at: null, last_progress_at: null };
    const observed = { free, locked, draining, after };
    expect(observed).toEqual({
      free: { held: false, lease: null },
      locked: { held: true, lease: { live: true, kind: 'unknown', id: null, version: false, pid: true, started: true, progress: none } },
      draining: { held: true, lease: { live: true, kind: 'job', id: '7', version: true, pid: true, started: true, progress: none } },
      after: { held: false, lease: null },
    });
    return observed;
  });

  parityTest('drainHeld reads a live holder with no progress for the stall window as stalled', {
    methods: ['readCycleLocks', 'readDrainLeaseBeacon', 'readDrainHolderProgress', 'writeDrainLeaseHolder', 'releaseDrainLeaseHolder'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    const heldFor = async (ms: number) => {
      const drainHeld = runnerStart(takenEarlier(engine, ms)).drainHeld!;
      return drainHeld('alpha');
    };
    let observed: Record<string, unknown> = {};
    await withDrainLease(engine, 'alpha', { holder: { kind: 'job', id: '7' } }, async () => {
      observed = {
        fresh: await heldFor(0),
        underWindow: await heldFor(HOLDER_STALL_MS - 60_000),
        pastWindow: await heldFor(HOLDER_STALL_MS + 60_000),
        progress: (await readDrainLease(takenEarlier(engine, HOLDER_STALL_MS + 60_000), 'alpha'))?.holder.progress ?? null,
      };
      return { status: 'up_to_date' } as unknown as SyncResult;
    });
    const after = await heldFor(HOLDER_STALL_MS + 60_000);
    expect({ ...observed, after } as Record<string, unknown>).toEqual({
      fresh: true, underWindow: true, pastWindow: 'stalled',
      progress: { committed: 0, last_committed_at: null, last_progress_at: null }, after: false,
    });
    return { ...observed, after };
  });
});

/**
 * The engine with its lease rows read as taken `ms` earlier, as a holder that took the lease then and has renewed it
 * since: the TTL and the renewal stamp stay the engine's, so the lease reads live, and the holder's progress is read
 * from the earlier start.
 */
function takenEarlier(engine: BrainEngine, ms: number): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'readCycleLocks') {
        return async (filter: Parameters<BrainEngine['readCycleLocks']>[0]) => (await target.readCycleLocks(filter))
          .map(row => ({ ...row, acquired_at: new Date(new Date(row.acquired_at).getTime() - ms) }));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
