/**
 * BrainEngine parity — the spend-reservation and lease-pressure tables of the minion queue (engine-sql/jobs-spend.ts):
 * `readJobSpendTree` (what `describeJobs` prints as a job's cost), `insertSpendReservation`, `expireSpendReservations`,
 * `settleSpendReservation`, `markSpendUsageUnknown`, `insertLeasePressure`, `countLeasePressure` and
 * `listRecentLeasePressure`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same calls return the same answers on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts). The spend tree sums settled cents (to four decimals) and counts
 *    priced and unsettled holds per described job, separately for the job itself and for its descendants, and an
 *    owner-fenced caller counts only descendants it owns. A sweep marks only overdue pending holds, in the scope asked
 *    (all, one client, one group), once. Settling works on a pending or an overdue hold, once. A usage-unknown mark
 *    lands on a pending or an overdue hold only. A reservation naming no job, no owner or two owners, or repeating an
 *    id, is refused. A lease-pressure row is stamped with the clock, counted by window, job and lease key together, and
 *    listed newest first; deleting its job keeps the row and clears the job.
 *  - Regression: an engine that adds a child's cost to the wrong job, ignores the owner fence, counts a settled hold as
 *    unsettled, sums unrounded cents, expires holds that are not overdue or settled ones, sweeps the wrong scope,
 *    settles twice, marks a settled hold, takes a reservation for a job that does not exist, treats a count filter as
 *    an either-or, or drops pressure rows with their job — `jobs list` printing the wrong cost and a pressure counter
 *    that disagrees across engines.
 *  - Why existing coverage misses it: test/minions/job-insight.test.ts and budget-meter.test.ts run on PGLite only and
 *    seed with raw SQL; a Rust engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Job ids are compared relative to the case's first
 *    job and log ids relative to its first row (sequences keep counting across resets on Postgres). Window cases sleep
 *    about a second between inserts.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import type { SpendReservationInsert } from '../../src/core/engine-sql/jobs-spend.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

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

function claimSpec(token: string, name: string): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: [name], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 },
  };
}

/** A job that ran to completion, so it can be deleted. */
async function finished(engine: BrainEngine, name: string): Promise<number> {
  const id = await add(engine, name);
  const row = await engine.claimNextJob(claimSpec(`fin:${name}`, name));
  expect(Number(row?.id)).toBe(id);
  await engine.completeJob(id, `fin:${name}`);
  return id;
}

function hold(n: number, extra: Partial<SpendReservationInsert> = {}): SpendReservationInsert {
  return {
    reservation_id: uuid(n), client_id: 'client-a', budget_key: null, job_id: null, estimated_cents: 5,
    model: 'anthropic:claude-sonnet', provider: 'anthropic', expires_at: FUTURE, estimate_known: true,
    usage_unknown_reason: null, ...extra,
  };
}

/** Whether a call threw (constraint messages name the engine's own driver, so only the fact is compared); a typed refusal propagates. */
async function threw(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') throw error;
    return true;
  }
}

describe('engine parity: spend reservations and lease pressure', () => {
  parityTest('readJobSpendTree sums settled holds of a job and its descendants, fenced by owner',
    { methods: ['admitJob', 'insertSpendReservation', 'settleSpendReservation', 'readJobSpendTree'] }, async engine => {
      const root = await add(engine, 'root', { data: { __owner_client_id: 'client-a' } });
      const a1 = await add(engine, 'a1', { parent_job_id: root, data: { __owner_client_id: 'agent-a' } });
      const b1 = await add(engine, 'b1', { parent_job_id: root, data: { __owner_client_id: 'agent-b' } });
      const a2 = await add(engine, 'a2', { parent_job_id: a1, data: { __owner_client_id: 'agent-a' } });
      const b2 = await add(engine, 'b2', { parent_job_id: b1, data: { __owner_client_id: 'agent-a' } });
      const bare = await add(engine, 'bare', { parent_job_id: root });
      const other = await add(engine, 'other');
      const base = root;
      let n = 0;
      const settled = async (job: number, cents: number, extra: Partial<SpendReservationInsert> = {}) => {
        const id = ++n;
        await engine.insertSpendReservation(hold(id, { job_id: job, ...extra }));
        expect((await engine.settleSpendReservation(uuid(id), cents)).outcome).toBe('settled');
      };
      const pending = (job: number, extra: Partial<SpendReservationInsert> = {}) => engine.insertSpendReservation(hold(++n, { job_id: job, ...extra }));
      await settled(root, 1.5);
      await pending(root);
      await settled(a1, 0.25);
      await settled(a2, 3.1234);
      await settled(a2, 0.0001);
      await settled(a2, 0.12345);
      await settled(b2, 10);
      await pending(b1, { budget_key: 'group-1', client_id: null });
      await pending(b2, { estimate_known: false, usage_unknown_reason: 'pricing_or_bound_unknown' });
      await settled(bare, 7, { client_id: null, budget_key: 'group-1' });
      await settled(other, 99);
      await pending(other);
      // A fenced caller is the OAuth client that owns the rows by their `__owner_client_id` stamp (these rows record no principal).
      const asOwner = (client: string | null) => client === null ? null : { principal: { kind: 'oauth_client', id: client }, clientId: client, actor: ['', '', '', ''] as const };
      const view = async (jobIds: number[], owner: string | null) =>
        (await engine.readJobSpendTree({ jobIds, owner: asOwner(owner) })).map(r => ({ ...r, root: r.root - base }));
      const all = [root, a1, b1, a2, b2, bare, other];
      return {
        unfenced: await view(all, null),
        agentA: await view(all, 'agent-a'),
        agentB: await view([root, b1], 'agent-b'),
        stranger: await view([root, other], 'nobody'),
        onlyRoot: await view([root], null),
        leaf: await view([a2], 'agent-a'),
        none: await view([], null),
        missing: await view([base + 100_000], null),
      };
    });

  parityTest('spend reservations are inserted, swept, settled and marked unknown once, in the scope asked',
    { methods: ['admitJob', 'insertSpendReservation', 'expireSpendReservations', 'settleSpendReservation', 'markSpendUsageUnknown'] }, async engine => {
      const job = await add(engine, 'holder');
      await engine.insertSpendReservation(hold(1, { expires_at: PAST }));
      await engine.insertSpendReservation(hold(2, { client_id: null, budget_key: 'group-1', expires_at: PAST, job_id: job }));
      await engine.insertSpendReservation(hold(3, { client_id: 'client-b', expires_at: PAST }));
      await engine.insertSpendReservation(hold(4));
      await engine.insertSpendReservation(hold(5, { expires_at: PAST }));
      await engine.insertSpendReservation(hold(6, { client_id: null, budget_key: 'group-2', expires_at: PAST }));
      const settledEarly = await engine.settleSpendReservation(uuid(5), 2.5);
      const refused = {
        noJob: await threw(() => engine.insertSpendReservation(hold(7, { job_id: job + 100_000 }))),
        noOwner: await threw(() => engine.insertSpendReservation(hold(8, { client_id: null }))),
        twoOwners: await threw(() => engine.insertSpendReservation(hold(9, { budget_key: 'group-1' }))),
        repeated: await threw(() => engine.insertSpendReservation(hold(1))),
        badStatusless: await threw(() => engine.insertSpendReservation(hold(10, { reservation_id: 'not-a-uuid' }))),
      };
      const sweeps = {
        client: await engine.expireSpendReservations({ clientId: 'client-a' }),
        clientAgain: await engine.expireSpendReservations({ clientId: 'client-a' }),
        group: await engine.expireSpendReservations({ budgetKey: 'group-1' }),
        wrongGroup: await engine.expireSpendReservations({ budgetKey: 'group-none' }),
        everything: await engine.expireSpendReservations(),
        again: await engine.expireSpendReservations(),
      };
      const unknown = {
        pending: await engine.markSpendUsageUnknown(uuid(4), 'provider_usage_unknown'),
        expired: await engine.markSpendUsageUnknown(uuid(1), 'pricing_unknown'),
        settled: await engine.markSpendUsageUnknown(uuid(5), 'pricing_unknown'),
        missing: await engine.markSpendUsageUnknown(uuid(99), 'pricing_unknown'),
      };
      const settle = {
        expired: await engine.settleSpendReservation(uuid(1), 1.25),
        group: await engine.settleSpendReservation(uuid(2), 0),
        pendingClient: await engine.settleSpendReservation(uuid(4), 0.5),
        again: await engine.settleSpendReservation(uuid(4), 9),
        missing: await engine.settleSpendReservation(uuid(99), 1),
      };
      // The budget meter's ids are version 7: the store must keep every bit of the id it was given.
      const v7 = '01a1efa3-9ee6-701e-ada3-d202d5776740';
      await engine.insertSpendReservation(hold(11, { reservation_id: v7 }));
      const version7 = {
        unknown: await engine.markSpendUsageUnknown(v7, 'pricing_unknown'),
        settled: await engine.settleSpendReservation(v7, 0.75),
        again: await engine.settleSpendReservation(v7, 9),
      };
      return { settledEarly, refused, sweeps, unknown, settle, version7 };
    });

  parityTest('lease pressure rows are inserted, counted by window, job and lease key, and listed newest first',
    { methods: ['admitJob', 'insertLeasePressure', 'countLeasePressure', 'listRecentLeasePressure'] }, async engine => {
      const first = await add(engine, 'bounced-one');
      const second = await add(engine, 'bounced-two');
      const row = (job: number, key: string, extra: object = {}) => ({
        job_id: job, lease_key: key, active_at_bounce: 3, max_concurrent: 3, ...extra,
      });
      await engine.insertLeasePressure(row(first, 'anthropic:sonnet', {
        queue_name: 'default', job_name: 'subagent', model: 'sonnet', provider: 'anthropic', root_owner_id: 42,
      }));
      await Bun.sleep(2);
      await engine.insertLeasePressure(row(first, 'anthropic:opus'));
      await Bun.sleep(2);
      await engine.insertLeasePressure(row(second, 'anthropic:sonnet', { active_at_bounce: 5, max_concurrent: 4, queue_name: null }));
      await Bun.sleep(1000);
      await engine.insertLeasePressure(row(second, 'anthropic:opus', { model: 'opus' }));
      const list = await engine.listRecentLeasePressure(3_600_000, 1000);
      const baseId = Math.min(...list.map(r => r.id));
      const shown = (rows: typeof list) => rows.map(r => ({ ...r, id: r.id - baseId, job_id: r.job_id === null ? null : r.job_id - first, bounced_at: r.bounced_at instanceof Date }));
      const counts = {
        all: await engine.countLeasePressure(),
        none: await engine.countLeasePressure({}),
        window: await engine.countLeasePressure({ windowMs: 500 }),
        wide: await engine.countLeasePressure({ windowMs: 3_600_000 }),
        zero: await engine.countLeasePressure({ windowMs: 0 }),
        job: await engine.countLeasePressure({ jobId: first }),
        key: await engine.countLeasePressure({ leaseKey: 'anthropic:opus' }),
        jobAndKey: await engine.countLeasePressure({ jobId: first, leaseKey: 'anthropic:opus' }),
        all3: await engine.countLeasePressure({ windowMs: 500, jobId: second, leaseKey: 'anthropic:opus' }),
        stale: await engine.countLeasePressure({ windowMs: 500, jobId: first }),
        missingJob: await engine.countLeasePressure({ jobId: first + 100_000 }),
      };
      const out = {
        counts,
        newest: shown(list),
        limited: shown(await engine.listRecentLeasePressure(3_600_000, 2)),
        window: shown(await engine.listRecentLeasePressure(500, 1000)).map(r => r.lease_key),
        zeroLimit: (await engine.listRecentLeasePressure(3_600_000, 0)).length,
      };
      // Last: Postgres spends a sequence value on an insert its foreign key refuses, so a refusal moves later ids.
      const refused = {
        noJob: await threw(() => engine.insertLeasePressure(row(first + 100_000, 'k'))),
        tooBig: await threw(() => engine.insertLeasePressure(row(first, 'k', { active_at_bounce: 2 ** 31 }))),
      };
      return { ...out, refused };
    });

  parityTest('deleting a job keeps its spend and lease-pressure rows and clears their job',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'deleteTerminalJob', 'insertSpendReservation', 'settleSpendReservation', 'readJobSpendTree', 'insertLeasePressure', 'countLeasePressure', 'listRecentLeasePressure'] }, async engine => {
      const job = await finished(engine, 'to-delete');
      const keeper = await add(engine, 'keeper');
      await engine.insertSpendReservation(hold(1, { job_id: job }));
      await engine.insertSpendReservation(hold(2, { job_id: keeper }));
      await engine.settleSpendReservation(uuid(2), 4);
      await engine.insertLeasePressure({ job_id: job, lease_key: 'k', active_at_bounce: 1, max_concurrent: 1 });
      await engine.insertLeasePressure({ job_id: keeper, lease_key: 'k', active_at_bounce: 1, max_concurrent: 1 });
      const before = { byJob: await engine.countLeasePressure({ jobId: job }), tree: await engine.readJobSpendTree({ jobIds: [job], owner: null }) };
      expect(await engine.deleteTerminalJob(job)).toBe(true);
      const list = await engine.listRecentLeasePressure(3_600_000, 10);
      return {
        before: { byJob: before.byJob, tree: before.tree.length },
        after: {
          byDeletedJob: await engine.countLeasePressure({ jobId: job }),
          all: await engine.countLeasePressure(),
          jobs: list.map(r => (r.job_id === null ? null : r.job_id - job)).sort((x, y) => (x ?? -1) - (y ?? -1)),
          kept: (await engine.readJobSpendTree({ jobIds: [keeper], owner: null })).length,
          // The hold of the deleted job still exists (its id is taken).
          reused: await threw(() => engine.insertSpendReservation(hold(1))),
        },
      };
    });
});
