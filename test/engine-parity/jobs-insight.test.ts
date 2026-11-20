/**
 * BrainEngine parity: the reads behind `describeJobs` (engine-sql/jobs-insight.ts): readJobInsight answers a batch of
 * jobs' submitter and parent owner, queue position, slot holders, live children, blocking leases and the tokens of
 * completed children another owner submitted.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the read answers the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts). A batch of jobs that do not exist answers empty lists on every arm (the
 *    Rust arm included); a seeded queue answers what master's statements answered (priority-then-age position, the
 *    holders' start order with no start last, live children only, unexpired leases with their beacon, foreign-owner
 *    tokens only for an owner-fenced caller), with counts as numbers and lease times as `Date`s.
 *  - Regression: a member that counts a delayed job as ahead, lists the drain-lease row as a slot holder, lists a
 *    finished child as live, shows an expired lease, or counts the caller's own children's tokens as foreign would make
 *    `jobs list` and `jobs get` explain a job's wait wrongly.
 *  - Why existing coverage misses it: test/minions-*.test.ts script `executeRaw`; nothing compares the engines on one
 *    scenario, and a Rust engine has no raw SQL.
 *  - Seam: the seeded case writes `minion_jobs` and `gbrain_cycle_locks` rows with `executeRaw` (BrainEngine has no typed
 *    job writer on this base), so it declares `requires: 'raw_sql'` and the Rust arm must end on the typed `raw_sql`
 *    refusal. The Rust arm therefore proves the empty answers only; test/n4-sql-move-parity.test.ts proves the seeded rows
 *    against master's statements on both SQL engines.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { seedInsightJobs } from '../helpers/n4-seed.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: describeJobs reads', () => {
  parityTest('jobs that do not exist answer empty lists from every read', { methods: ['readJobInsight'] }, async (engine) => {
    const rows = await engine.readJobInsight({
      jobIds: [999_001, 999_002], waitingIds: [999_001], waitingQueues: ['default'], parentIds: [999_002], lockIds: ['no-such-lock'],
      holderQueue: 'gbrain-drain-lease', owner: 'o1',
    });
    expect(rows).toEqual({ meta: [], ahead: [], holders: [], children: [], locks: [], foreign_tokens: [] });
    const none = await engine.readJobInsight({ jobIds: [], waitingIds: [], waitingQueues: [], parentIds: [], lockIds: [], holderQueue: 'gbrain-drain-lease', owner: null });
    expect(none).toEqual({ meta: [], ahead: [], holders: [], children: [], locks: [], foreign_tokens: [] });
    return { rows, none };
  });

  parityTest('seeded jobs answer position, holders, children, leases and foreign tokens the way describeJobs reads them', { methods: ['readJobInsight'], requires: 'raw_sql' }, async (engine) => {
    const ids = await seedInsightJobs(engine);
    const rows = await engine.readJobInsight({
      jobIds: ids.all, waitingIds: ids.waiting, waitingQueues: ['default', 'q2'], parentIds: [ids.parent], lockIds: ids.lockIds,
      holderQueue: 'gbrain-drain-lease', owner: 'o1',
    });
    const at = (n: number) => n - ids.all[0]!;
    expect(rows.meta.find(r => Number(r.id) === ids.byName.submitted)!.submitter).toBe('cli:import');
    expect(rows.meta.find(r => Number(r.id) === ids.byName.principal)!.submitter).toBeNull();
    expect(new Map(rows.ahead.map(r => [Number(r.id), Number(r.ahead)]))).toEqual(new Map([[ids.byName.w1!, 1], [ids.byName.w2!, 2], [ids.byName.w3!, 0], [ids.byName.w4!, 0]]));
    expect(rows.holders.map(r => Number(r.id))).toEqual([ids.byName.act1!, ids.byName.act4!, ids.byName.act2!, ids.byName.act3!]);
    expect(rows.children.map(r => ({ id: at(Number(r.id)), parent: at(Number(r.parent_job_id)), owner: r.owner })))
      .toEqual([{ id: at(ids.byName.child1!), parent: at(ids.parent), owner: 'o1' }, { id: at(ids.byName.child2!), parent: at(ids.parent), owner: 'o2' }]);
    expect(rows.locks.map(l => l.id).sort()).toEqual(['lock-live-beacon', 'lock-live-plain']);
    expect(rows.locks.every(l => l.acquired_at instanceof Date && l.ttl_expires_at instanceof Date)).toBe(true);
    expect(rows.locks.find(l => l.id === 'lock-live-beacon')!.holder_owner).toBe('o1');
    expect(rows.foreign_tokens.map(r => ({ parent: at(Number(r.parent_job_id)), i: Number(r.i), o: Number(r.o), c: Number(r.c) }))).toEqual([{ parent: at(ids.parent), i: 15, o: 25, c: 35 }]);
    return { holders: rows.holders.map(r => at(Number(r.id))) };
  });
});
