/**
 * BrainEngine parity — the reads behind `describeJobs` (engine-sql/jobs-insight.ts `readJobInsight`): who submitted a
 * job, how many waiting jobs are ahead of it, which active jobs hold the slots of its queue, which live children a
 * parent waits for, which live lease a waiting job is blocked by, and the tokens of completed children another owner
 * submitted.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: one `readJobInsight` call returns the same rows on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): the submitter only for an application
 *    authority, the owner of the parent, the count of waiting jobs of the same queue ordered before a job (any status
 *    of the job asked about), the active holders of the waiting queues without the drain-lease queue, oldest start
 *    first, cut at the limit, the unfinished children by id, the unexpired leases with the beacon record and the
 *    owner of the job it names, and the completed children's tokens of every owner but the caller (a child with no
 *    owner counts as another owner).
 *  - Regression: an engine that counts waiting jobs of other queues or later ones as ahead, lists the drain-lease
 *    beacon as a slot holder, skips the limit or reorders the holders, lists finished children, returns an expired
 *    lease, joins the beacon to the wrong lease, treats a child with no owner as the caller's own, or leaks a
 *    submitter from a non-application job — a `jobs list` that tells an operator the wrong reason a job waits.
 *  - Why existing coverage misses it: test/job-insight.test.ts drives `describeJobs` on PGLite only; nothing compares
 *    the engines on one scenario, and a Rust engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Ids are compared relative to the case's first
 *    job (sequences keep counting across resets on Postgres) and lease dates only as present. Submissions are 2 ms
 *    apart so created_at never ties.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import type { JobInsightRows, JobInsightSpec } from '../../src/core/engine-sql/jobs-insight.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const BEACON_QUEUE = 'gbrain-drain-lease';
const REMOTE_AUTHORITY = { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'client-a' } } as unknown as SubmissionAuthority;
const TOKEN = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

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

function policy(authority: SubmissionAuthority = APPLICATION_AUTHORITY): AdmitJobPolicy {
  return {
    decide: async (_tx, row) => coalesceDecision(row, authority),
    parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
  };
}

function admit(engine: BrainEngine, spec: Partial<AdmitJobSpec> & { insert: JobInsertValues }) {
  return engine.admitJob({ maxSpawnDepth: 5, ...spec }, policy());
}

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, { insert: values(name, extra) });
  expect(out.coalesced).toBe(false);
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** A new job, claimed by `token` (the job's name is unique to the case, so the claim takes this row). */
async function active(engine: BrainEngine, name: string, token: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const id = await add(engine, name, extra);
  const row = await engine.claimNextJob(claimSpec(token, { names: [name], queue: extra.queue ?? 'default' }));
  expect(Number(row?.id)).toBe(id);
  await Bun.sleep(2);
  return id;
}

/** A child that completed holding `tokens` (completeJob rolls them into the parent, so the parent is the caller's concern). */
async function completedChild(engine: BrainEngine, name: string, parent: number, owner: string | null, tokens: number) {
  const token = `fin:${name}`;
  const id = await active(engine, name, token, { parent_job_id: parent, data: owner === null ? {} : { __owner_client_id: owner } });
  await engine.addJobTokens(id, token, { input: tokens, output: tokens * 2, cache_read: tokens * 3 });
  await engine.completeJob(id, token);
  return id;
}

/** A fenced caller: the OAuth client that owns rows by their `__owner_client_id` stamp (these rows record no principal). */
const CLIENT_A = { principal: { kind: 'oauth_client', id: 'client-a' }, clientId: 'client-a', actor: ['', '', '', ''] as const };
const empty = { jobIds: [], waitingIds: [], waitingQueues: [], parentIds: [], lockIds: [], holderQueue: BEACON_QUEUE, holderLimit: 500, owner: null } satisfies JobInsightSpec;

/** The rows as the engines must agree on them: ids relative to `base`, lease dates as present. */
function view(rows: JobInsightRows, base: number) {
  const r = (id: number) => id - base;
  return {
    meta: rows.meta.map(m => ({ ...m, id: r(m.id) })),
    ahead: rows.ahead.map(a => ({ ...a, id: r(a.id) })),
    holders: rows.holders.map(h => ({ ...h, id: r(h.id) })),
    children: rows.children.map(c => ({ ...c, id: r(c.id), parent_job_id: r(c.parent_job_id) })),
    locks: rows.locks.map(l => ({ ...l, acquired_at: l.acquired_at instanceof Date, ttl_expires_at: l.ttl_expires_at instanceof Date,
      beacon: l.beacon && typeof l.beacon === 'object' && (l.beacon as { id?: unknown }).id !== undefined
        ? { ...(l.beacon as object), id: r(Number((l.beacon as { id: unknown }).id)) } : l.beacon })),
    foreign_tokens: rows.foreign_tokens.map(t => ({ ...t, parent_job_id: r(t.parent_job_id) })),
  };
}

describe('engine parity: job insight', () => {
  parityTest('readJobInsight reads submitters, queue positions, slot holders, live children and foreign tokens',
    { methods: ['admitJob', 'claimNextJob', 'addJobTokens', 'completeJob', 'readJobInsight'] }, async engine => {
      // Active holders first: two in `default`, one in `other`, and a drain-lease beacon row that is never a holder.
      const base = await active(engine, 'holder-one', 'w:1', { data: { __owner_client_id: 'client-a' } });
      const holderTwo = await active(engine, 'holder-two', 'w:2');
      const holderOther = await active(engine, 'holder-other', 'w:3', { queue: 'other', data: { __owner_client_id: 'client-b' } });
      const beacon = await active(engine, 'beacon', 'w:4', { queue: BEACON_QUEUE });
      // Waiting rows: priority 5 is behind priority 0, and `other` counts on its own.
      const late = await add(engine, 'late', { priority: 5 });
      const first = await add(engine, 'first');
      const second = await add(engine, 'second', { data: { __submitter: 'cli:second' } });
      const remote = await add(engine, 'remote', { submission_authority: REMOTE_AUTHORITY, data: { __submitter: 'should-not-show' } });
      const otherQueue = await add(engine, 'in-other', { queue: 'other' });
      // A parent that waits for children of several owners and states.
      const parent = await add(engine, 'parent', { data: { __owner_client_id: 'client-a' } });
      const liveA = await add(engine, 'kid-live-a', { parent_job_id: parent, data: { __owner_client_id: 'client-a' } });
      const liveNone = await add(engine, 'kid-live-none', { parent_job_id: parent });
      const cancelled = await add(engine, 'kid-cancelled', { parent_job_id: parent });
      await engine.cancelJobs([cancelled]);
      await completedChild(engine, 'done-b', parent, 'client-b', 7);
      await completedChild(engine, 'done-b2', parent, 'client-b', 1);
      await completedChild(engine, 'done-none', parent, null, 100);
      await completedChild(engine, 'done-a', parent, 'client-a', 1000);
      // A child of another owner that holds tokens but has not completed is not summed.
      const midway = await active(engine, 'kid-midway', 'w:mid', { parent_job_id: parent, data: { __owner_client_id: 'client-b' } });
      await engine.addJobTokens(midway, 'w:mid', { input: 10_000, output: 20_000, cache_read: 30_000 });

      const all = [base, holderTwo, holderOther, beacon, late, first, second, remote, otherQueue, parent, liveA, liveNone, cancelled];
      const spec = (extra: Partial<JobInsightSpec>): JobInsightSpec => ({ ...empty, ...extra });
      const waiting = [late, first, second, remote, otherQueue, holderTwo];
      const fenced = view(await engine.readJobInsight(spec({
        jobIds: all, waitingIds: waiting, waitingQueues: ['default', 'other'], parentIds: [parent], owner: CLIENT_A,
      })), base);
      const unfenced = view(await engine.readJobInsight(spec({
        jobIds: all, waitingIds: waiting, waitingQueues: ['default', 'other'], parentIds: [parent],
      })), base);
      const limited = view(await engine.readJobInsight(spec({
        jobIds: [late], waitingIds: [late], waitingQueues: ['default', 'other', BEACON_QUEUE], holderLimit: 2,
      })), base);
      const withBeacon = view(await engine.readJobInsight(spec({
        jobIds: [late], waitingIds: [late], waitingQueues: ['default', 'other', BEACON_QUEUE],
      })), base);
      const none = view(await engine.readJobInsight(spec({ jobIds: [], waitingQueues: ['default'] })), base);
      const missing = view(await engine.readJobInsight(spec({ jobIds: [base + 100_000], owner: CLIENT_A })), base);
      return {
        fenced: { ...fenced, meta: sorted(fenced.meta, m => String(m.id).padStart(8, '0')) },
        unfenced: { foreign: unfenced.foreign_tokens, children: unfenced.children },
        limited: { holders: limited.holders, ahead: limited.ahead },
        withBeacon: withBeacon.holders,
        none, missing,
      };
    });

  parityTest('readJobInsight returns live leases with the beacon and the owner of the job it names',
    { methods: ['admitJob', 'claimNextJob', 'acquireCycleLock', 'readJobInsight'] }, async engine => {
      const lease = (pid: number, token: string, ttlMinutes = 30) => ({ holderPid: pid, holderHost: `host-${pid}`, acquisitionToken: token, ttlMinutes, stealGraceSeconds: 0 });
      const base = await active(engine, 'lock-holder', 'h:1', { data: { __owner_client_id: 'client-a' } });
      // A live lease whose beacon row (claimed under the lease's own token) names the holder job.
      expect(await engine.acquireCycleLock('gbrain-sync:src1', lease(101, TOKEN(1)))).not.toBeNull();
      const named = await add(engine, 'beacon-job', { queue: BEACON_QUEUE, data: { drain_lease_beacon: { kind: 'job', id: String(base) } } });
      expect(Number((await engine.claimNextJob(claimSpec(TOKEN(1), { names: ['beacon-job'], queue: BEACON_QUEUE })))?.id)).toBe(named);
      // A live lease with no beacon row, one whose beacon is a process (it carries an id too, which names no holder), and one whose beacon names a missing job.
      expect(await engine.acquireCycleLock('gbrain-sync:src2', lease(102, TOKEN(2)))).not.toBeNull();
      expect(await engine.acquireCycleLock('gbrain-sync:src3', lease(103, TOKEN(3)))).not.toBeNull();
      const proc = await add(engine, 'beacon-proc', { queue: BEACON_QUEUE, data: { drain_lease_beacon: { kind: 'process', pid: 103, id: String(base) } } });
      expect(Number((await engine.claimNextJob(claimSpec(TOKEN(3), { names: ['beacon-proc'], queue: BEACON_QUEUE })))?.id)).toBe(proc);
      expect(await engine.acquireCycleLock('gbrain-sync:src4', lease(104, TOKEN(4)))).not.toBeNull();
      await add(engine, 'beacon-gone', { queue: BEACON_QUEUE, data: { drain_lease_beacon: { kind: 'job', id: String(base + 100_000) } } });
      await engine.claimNextJob(claimSpec(TOKEN(4), { names: ['beacon-gone'], queue: BEACON_QUEUE }));
      // An expired lease, and a live one the caller does not ask about.
      expect(await engine.acquireCycleLock('gbrain-sync:expired', lease(105, TOKEN(5), -1))).not.toBeNull();
      expect(await engine.acquireCycleLock('gbrain-sync:unasked', lease(106, TOKEN(6)))).not.toBeNull();
      const ask = (lockIds: string[], owner: typeof CLIENT_A | null = null) => engine.readJobInsight({ ...empty, jobIds: [base], lockIds, owner });
      const lockIds = ['gbrain-sync:src1', 'gbrain-sync:src2', 'gbrain-sync:src3', 'gbrain-sync:src4', 'gbrain-sync:expired', 'gbrain-sync:absent'];
      return {
        locks: view(await ask(lockIds), base).locks,
        one: view(await ask(['gbrain-sync:src1', 'gbrain-sync:unasked']), base).locks.map(l => l.id),
        expiredOnly: view(await ask(['gbrain-sync:expired']), base).locks,
        fenced: view(await ask(['gbrain-sync:src1'], CLIENT_A), base).locks.map(l => l.holder_owned),
      };
    });
});
