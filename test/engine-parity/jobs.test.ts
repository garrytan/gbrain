/**
 * BrainEngine parity — minion jobs family (the `minion_jobs` lifecycle members the queue reaches the database
 * through: admitJob, getJob, listJobs, claimNextJob, renewJobLease, completeJob, failJob, reclaimStalledJobs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: submitting, reading, listing, claiming, renewing, completing, failing and reclaiming a job returns the
 *    same observable rows on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts): which row a submission coalesces onto or refuses, which job a worker claims and
 *    what the claim stamps, that a stale token changes nothing, and how a finished child wakes or fails its parent.
 *  - Regression: an engine that drifts on the idempotency key (coalesce, release of a dead holder, refusal across
 *    authorities), the admission caps (parameter coalesce, name quota, backpressure), the parent checks, the claim
 *    order and stamps (lease and timeout resolution, the legacy spend fence), the token fence of renew/complete/fail,
 *    `on_child_fail`, or the stall sweep (stall count, dead at `max_stalled`, the co-runner requeue, the drain-lease
 *    holder cleanup) — the rules that keep a job from running twice or a parent from waiting forever.
 *  - Why existing coverage misses it: test/minions*.test.ts drive `MinionQueue` on PGLite only and reach these
 *    statements through the queue; nothing compares the engines on one scenario, and a Rust engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Expired leases are made by negative lease
 *    durations, never by sleeping. Ids are compared relative to the case's first job (sequences keep counting across
 *    resets on Postgres), and clock readings are compared only as present or absent. Submissions are 2 ms apart, so
 *    the created_at order the claim and list members use never ties.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues, JobRow } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { WATCHDOG_SUSPECT_MARK } from '../../src/core/minions/watchdog-attribution.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const TOKEN = '00000000-0000-4000-8000-0000000000aa';
const OTHER_AUTHORITY = { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'client-a' } } as unknown as SubmissionAuthority;

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

/** The queue's policy for a caller holding `authority` (no delegated client). */
function policy(authority: SubmissionAuthority = APPLICATION_AUTHORITY): AdmitJobPolicy {
  return {
    decide: async (_tx, row) => coalesceDecision(row, authority),
    parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
  };
}

function admit(engine: BrainEngine, spec: Partial<AdmitJobSpec> & { insert: JobInsertValues }, authority?: SubmissionAuthority) {
  return engine.admitJob({ maxSpawnDepth: 5, ...spec }, policy(authority));
}

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, { insert: values(name, extra) });
  expect(out.coalesced).toBe(false);
  // The claim and list orders break priority ties on created_at, which two quick submissions can share on PGLite.
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** What a thrown error is, for comparing refusals across arms. */
function refusal(error: unknown) {
  const e = error as { name?: string; code?: unknown; message?: string };
  return { name: e.name, code: e.code ?? null, message: e.message };
}

async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return refusal(error);
  }
}

/** A row as the engines must agree on it: ids relative to `base`, clock readings as present or absent. */
function rowView(base: number) {
  const rel = (v: unknown) => (v == null ? null : Number(v) - base);
  return (r: JobRow | null) => {
    if (!r) return null;
    const out: Record<string, unknown> = {
      id: rel(r.id), name: r.name, queue: r.queue, status: r.status, priority: r.priority, data: r.data, depth: r.depth,
      parent_job_id: rel(r.parent_job_id), on_child_fail: r.on_child_fail, max_children: r.max_children,
      attempts_made: r.attempts_made, attempts_started: Number(r.attempts_started), stalled_counter: r.stalled_counter,
      max_stalled: r.max_stalled, claim_generation: Number(r.claim_generation),
      spend_claim_token: r.spend_claim_token == null ? null : Number(r.spend_claim_token), lock_token: r.lock_token,
      lock_duration_ms: r.lock_duration_ms, timeout_ms: r.timeout_ms, error_text: r.error_text, stacktrace: r.stacktrace,
      result: r.result, idempotency_key: r.idempotency_key, submission_authority: r.submission_authority,
      remove_on_complete: r.remove_on_complete, remove_on_fail: r.remove_on_fail,
      has: Object.fromEntries(['lock_until', 'delay_until', 'timeout_at', 'started_at', 'finished_at'].map(k => [k, r[k] != null])),
    };
    if ('legacy_authority_is_null' in r) out.legacy_authority_is_null = r.legacy_authority_is_null;
    return out;
  };
}

/** The legacy spend record a claim stamps, minus its clock reading. */
function spendView(raw: unknown) {
  const value = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown> | null;
  if (!value) return null;
  const { authorized_at, ...rest } = value;
  return { ...rest, authorized_at: typeof authorized_at === 'string' };
}

describe('engine parity: minion jobs', () => {
  parityTest('admitJob inserts, coalesces on its idempotency key, refuses another authority, and frees a dead key',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'getJob'] }, async (engine) => {
      const first = await admit(engine, { insert: values('work', { idempotency_key: 'k1', data: { n: 1 }, max_stalled: 4 }) });
      const base = Number(first.row.id);
      const view = rowView(base);
      const again = await admit(engine, { insert: values('work', { idempotency_key: 'k1', data: { n: 2 } }) });
      const crossed = await thrown(() => admit(engine, { insert: values('work', { idempotency_key: 'k1', submission_authority: OTHER_AUTHORITY }) }, OTHER_AUTHORITY));
      const claimed = await engine.claimNextJob(claimSpec('w1:a'));
      await engine.failJob(base, 'w1:a', 'boom', 'dead');
      const reissued = await admit(engine, { insert: values('work', { idempotency_key: 'k1', data: { n: 3 } }) });
      expect(again.coalesced).toBe(true);
      expect(crossed?.code).toBe('permission_denied');
      return {
        first: { row: view(first.row), coalesced: first.coalesced, audit: first.audit },
        again: { row: view(again.row), coalesced: again.coalesced, audit: again.audit },
        crossed,
        claimed: view(claimed),
        reissued: { row: view(reissued.row), coalesced: reissued.coalesced },
        freed: view(await engine.getJob(base)),
      };
    });

  parityTest('coalesceOnIdempotencyKey alone: no row reads null, a live row is returned, another authority is refused, a dead row frees its key',
    { methods: ['admitJob', 'coalesceOnIdempotencyKey', 'claimNextJob', 'failJob', 'getJob'] }, async (engine) => {
      const step = (authority: SubmissionAuthority = APPLICATION_AUTHORITY) =>
        engine.coalesceOnIdempotencyKey('k1', { authority, decide: policy(authority).decide });
      const none = await step();
      const first = await admit(engine, { insert: values('work', { idempotency_key: 'k1', data: { n: 1 } }) });
      const base = Number(first.row.id);
      const view = rowView(base);
      const live = await step();
      const crossed = await thrown(() => step(OTHER_AUTHORITY));
      const stillHeld = (await engine.getJob(base))?.idempotency_key;
      await engine.claimNextJob(claimSpec('w1:k'));
      await engine.failJob(base, 'w1:k', 'boom', 'dead');
      const released = await step();
      const freed = await engine.getJob(base);
      expect(live?.id != null && Number(live.id)).toBe(base);
      expect(crossed?.code).toBe('permission_denied');
      return { none, live: view(live), crossed, stillHeld, released, freed: view(freed), afterRelease: await step() };
    });

  parityTest('admitJob coalesces an identical waiting payload and enforces the name quota and backpressure caps',
    { methods: ['admitJob'] }, async (engine) => {
      const first = await admit(engine, { insert: values('work', { data: { __param_hash: 'h1', sourceId: 's1' } }) });
      const view = rowView(Number(first.row.id));
      const same = await admit(engine, { insert: values('work', { data: { __param_hash: 'h1', sourceId: 's1' } }), paramCoalesce: { paramHash: 'h1', maxAgeHours: 24 } });
      const differs = await admit(engine, { insert: values('work', { data: { __param_hash: 'h2', sourceId: 's2' } }), paramCoalesce: { paramHash: 'h2', maxAgeHours: null } });
      const quota = await thrown(() => admit(engine, { insert: values('work'), quotaMaxWaiting: 2 }));
      const underQuota = await admit(engine, { insert: values('other'), quotaMaxWaiting: 2 });
      const pending = await admit(engine, { insert: values('work', { data: { sourceId: 's1' } }), backpressure: { sourceId: 's1', maxPending: 1 } });
      const waiting = await admit(engine, { insert: values('work', { data: { sourceId: 's2' } }), backpressure: { sourceId: null, maxWaiting: 2 } });
      const roomy = await admit(engine, { insert: values('work', { data: { sourceId: 's3' } }), backpressure: { sourceId: 's3', maxPending: 1 } });
      const rel = (a: { returned_job_id: number } | null) => (a ? { ...a, returned_job_id: a.returned_job_id - Number(first.row.id) } : null);
      expect(quota?.code).toBe('quota_exceeded');
      return {
        same: { row: view(same.row), coalesced: same.coalesced, audit: rel(same.audit) },
        differs: { row: view(differs.row), coalesced: differs.coalesced, audit: rel(differs.audit) },
        quota,
        underQuota: underQuota.coalesced,
        pending: { id: view(pending.row)?.id, coalesced: pending.coalesced, audit: rel(pending.audit) },
        waiting: { id: view(waiting.row)?.id, coalesced: waiting.coalesced, audit: rel(waiting.audit) },
        roomy: { id: view(roomy.row)?.id, coalesced: roomy.coalesced },
      };
    });

  parityTest('admitJob checks the parent: missing, finished, too deep, full; a child flips its parent to waiting-children',
    { methods: ['admitJob', 'getJob', 'claimNextJob', 'completeJob'] }, async (engine) => {
      const parent = await add(engine, 'parent', { max_children: 1 });
      const view = rowView(parent);
      const missing = await thrown(() => admit(engine, { insert: values('work', { parent_job_id: parent + 1000 }) }));
      const tooDeep = await thrown(() => admit(engine, { insert: values('work', { parent_job_id: parent }), maxSpawnDepth: 0 }));
      const child = await add(engine, 'work', { parent_job_id: parent });
      const full = await thrown(() => admit(engine, { insert: values('work', { parent_job_id: parent }) }));
      const done = await add(engine, 'finished');
      await engine.claimNextJob(claimSpec('w1:a', { names: ['finished'] }));
      await engine.completeJob(done, 'w1:a');
      const finished = await thrown(() => admit(engine, { insert: values('work', { parent_job_id: done }) }));
      const relMsg = (r: ReturnType<typeof refusal> | null) => r && { ...r, message: r.message?.replace(/(parent(?:_job_id| job)? )(\d+)/g, (_m, word: string, id: string) => `${word}+${Number(id) - parent}`) };
      return {
        missing: relMsg(missing), tooDeep: relMsg(tooDeep), full: relMsg(full), finished: relMsg(finished),
        parent: view(await engine.getJob(parent)), child: view(await engine.getJob(child)),
      };
    });

  parityTest('admitJob stores a delayed job with its delay, stall limit and spend record',
    { methods: ['admitJob', 'getJob'] }, async (engine) => {
      const spend = { version: 1, kind: 'operator', cap_usd: 3 };
      const id = await add(engine, 'work', {
        status: 'delayed', delay_until: '2099-01-01T00:00:00.000Z', priority: 7, max_stalled: 9, timeout_ms: 60_000,
        lock_duration_ms: 20_000, remove_on_complete: true, stagger_key: 'stagger-a', spend_authorization: JSON.stringify(spend),
      });
      const row = await engine.getJob(id);
      expect((row?.delay_until as Date).toISOString()).toBe('2099-01-01T00:00:00.000Z');
      return { row: rowView(id)(row), delay: (row?.delay_until as Date).toISOString(), stagger: row?.stagger_key, spend: spendView(row?.spend_authorization) };
    });

  parityTest('getJob reads one row by id and null for a missing id', { methods: ['admitJob', 'getJob'] }, async (engine) => {
    const id = await add(engine, 'work', { data: { a: [1, 'two', { three: true }] } });
    return { row: rowView(id)(await engine.getJob(id)), missing: await engine.getJob(id + 1000) };
  });

  parityTest('listJobs filters by status, queue, name and owner client, newest first, with limit and offset',
    { methods: ['admitJob', 'listJobs', 'claimNextJob'] }, async (engine) => {
      const a = await add(engine, 'work', { data: { __owner_client_id: 'client-a' } });
      await add(engine, 'work', { queue: 'side' });
      await add(engine, 'other', { data: { __owner_client_id: 'client-b' } });
      await add(engine, 'work', { data: { __owner_client_id: 'client-a' } });
      await engine.claimNextJob(claimSpec('w1:a'));
      const ids = async (f?: Parameters<BrainEngine['listJobs']>[0]) => (await engine.listJobs(f)).map(r => Number(r.id) - a);
      return {
        all: await ids(), none: await ids({}), waiting: await ids({ status: 'waiting' }), active: await ids({ status: 'active' }),
        side: await ids({ queue: 'side' }), work: await ids({ name: 'work' }), owner: await ids({ ownerClientId: 'client-a' }),
        both: await ids({ name: 'work', queue: 'default' }), page: await ids({ limit: 2, offset: 1 }), empty: await ids({ status: '' }),
      };
    });

  parityTest('claimNextJob takes the highest priority, then the oldest, of the named jobs and stamps the claim',
    { methods: ['admitJob', 'claimNextJob'] }, async (engine) => {
      const low = await add(engine, 'work', { priority: 5 });
      await add(engine, 'work', { priority: 1 });
      await add(engine, 'work', { priority: 1 });
      await add(engine, 'skip', { priority: 0 });
      await add(engine, 'work', { priority: 0, queue: 'side' });
      const view = rowView(low);
      const order: unknown[] = [];
      for (let i = 0; i < 4; i++) order.push(view(await engine.claimNextJob(claimSpec(`w${i}:a`))));
      return { order, unnamed: await engine.claimNextJob(claimSpec('w9:a', { names: [] })), excluded: await engine.claimNextJob(claimSpec('w9:a', { names: ['skip'], excludeNames: ['skip'] })) };
    });

  parityTest('claimNextJob resolves the lease and timeout from the row, then the handler maps, and stamps the legacy spend fence',
    { methods: ['admitJob', 'claimNextJob'] }, async (engine) => {
      const base = await add(engine, 'work', { lock_duration_ms: 6_000, timeout_ms: 9_000 });
      await add(engine, 'mapped');
      await add(engine, 'short');
      await add(engine, 'plain');
      await add(engine, 'enrich', { idempotency_key: 'enrich:page-a', data: { maxCostUsd: 2 } });
      await add(engine, 'subagent', { idempotency_key: 'book-mirror:b' });
      await add(engine, 'subagent', { idempotency_key: 'other:c' });
      const view = rowView(base);
      const take = async (name: string) => {
        const row = await engine.claimNextJob(claimSpec('w1:a', { names: [name], handlerTimeouts: { mapped: 7_000 }, handlerLockDurations: { mapped: 999_999_999, short: 1_000 } }));
        return { row: view(row), spend: spendView(row?.spend_authorization) };
      };
      return { row: await take('work'), mapped: await take('mapped'), short: await take('short'), plain: await take('plain'), enrich: await take('enrich'), mirror: await take('subagent'), unrelated: await take('subagent') };
    });

  parityTest('renewJobLease renews only an active job its token holds', { methods: ['admitJob', 'claimNextJob', 'renewJobLease', 'completeJob'] }, async (engine) => {
    const id = await add(engine, 'work');
    const waiting = await engine.renewJobLease(id, 'w1:a', 30_000);
    await engine.claimNextJob(claimSpec('w1:a'));
    const holder = await engine.renewJobLease(id, 'w1:a', 30_000);
    const stranger = await engine.renewJobLease(id, 'w2:a', 30_000);
    const missing = await engine.renewJobLease(id + 1000, 'w1:a', 30_000);
    await engine.completeJob(id, 'w1:a');
    const finished = await engine.renewJobLease(id, 'w1:a', 30_000);
    return { waiting, holder, stranger, missing, finished };
  });

  parityTest('completeJob finishes a held job, wakes the parent after its last child, and deletes a remove_on_complete row',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'getJob'] }, async (engine) => {
      const parent = await add(engine, 'parent');
      const view = rowView(parent);
      const a = await add(engine, 'work', { parent_job_id: parent });
      const b = await add(engine, 'work', { parent_job_id: parent, remove_on_complete: true });
      await engine.claimNextJob(claimSpec('w1:a'));
      await engine.claimNextJob(claimSpec('w2:a'));
      const stale = await engine.completeJob(a, 'w9:a');
      const first = await engine.completeJob(a, 'w1:a', { ok: 1 });
      const between = view(await engine.getJob(parent));
      const second = await engine.completeJob(b, 'w2:a');
      const twice = await engine.completeJob(a, 'w1:a');
      return { stale: view(stale), first: view(first), between, second: view(second), twice, removed: await engine.getJob(b), parent: view(await engine.getJob(parent)) };
    });

  parityTest('failJob retries delayed, fails or kills a held job and applies on_child_fail to the parent',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'getJob'] }, async (engine) => {
      const p1 = await add(engine, 'parent');
      const view = rowView(p1);
      const failing = await add(engine, 'work', { parent_job_id: p1, on_child_fail: 'fail_parent' });
      const p2 = await add(engine, 'parent');
      const removing = await add(engine, 'work', { parent_job_id: p2, on_child_fail: 'remove_dep' });
      const p3 = await add(engine, 'parent');
      const ignoring = await add(engine, 'work', { parent_job_id: p3, on_child_fail: 'ignore', remove_on_fail: true });
      const retrying = await add(engine, 'work');
      for (const w of ['w1', 'w2', 'w3', 'w4']) await engine.claimNextJob(claimSpec(`${w}:a`));
      const stale = await engine.failJob(failing, 'w9:a', 'boom', 'failed');
      const failed = await engine.failJob(failing, 'w1:a', 'boom', 'failed', undefined, { partial: true });
      const removed = await engine.failJob(removing, 'w2:a', 'gone', 'dead');
      const ignored = await engine.failJob(ignoring, 'w3:a', 'meh', 'failed');
      const delayed = await engine.failJob(retrying, 'w4:a', 'later', 'delayed', 60_000);
      const p1Row = await engine.getJob(p1);
      return {
        stale: view(stale), failed: view(failed), removed: view(removed), ignored: view(ignored), delayed: view(delayed),
        p1: { ...view(p1Row), error_text: null }, p1Error: p1Row?.error_text === `child job ${failing} failed: boom`,
        p2: view(await engine.getJob(p2)), removingAfter: view(await engine.getJob(removing)),
        p3: view(await engine.getJob(p3)), ignoringAfter: await engine.getJob(ignoring),
      };
    });

  // A delegated client's lock and capacity check run in the admission's transaction on every arm, before the insert.
  parityTest('admitJob runs a delegated client\'s lock and capacity check inside the admission',
    { methods: ['admitJob'] }, async (engine) => {
      const seen: Array<number | null> = [];
      const out = await engine.admitJob({ maxSpawnDepth: 5, insert: values('work') }, {
        ...policy(), lock: async () => 2, checkCapacity: async (_tx, limit) => { seen.push(limit); },
      });
      return { coalesced: out.coalesced, seen };
    });

  parityTest('claimNextJob with suspectWaitMs still claims a waiting job', { methods: ['admitJob', 'claimNextJob'] }, async (engine) => {
    const id = await add(engine, 'work');
    const row = await engine.claimNextJob(claimSpec('w1:a', { suspectWaitMs: 60_000 }));
    return rowView(id)(row);
  });

  parityTest('claimNextJob from eight workers at once, while jobs keep arriving, hands each job to exactly one worker',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'getJob'] }, async (engine) => {
      // The engines serialize this differently (row locks with SKIP LOCKED, one writer, or optimistic commits that
      // rerun on a conflict); what must match is the outcome: no job claimed twice, none lost, one claim each.
      const base = await add(engine, 'work');
      for (let i = 1; i < 24; i++) await add(engine, 'work', { priority: i % 3 });
      const total = 32;
      const claimed: number[] = [];
      const refusedCompletes: number[] = [];
      let idlePolls = 0;
      const submitter = (async () => { for (let i = 0; i < total - 24; i++) await add(engine, 'work', { priority: i % 2 }); })();
      const worker = async (w: number) => {
        while (claimed.length < total && idlePolls < 5_000) {
          const row = await engine.claimNextJob(claimSpec(`w${w}:a`));
          if (!row) { idlePolls++; await Bun.sleep(1); continue; }
          const id = Number(row.id);
          claimed.push(id - base);
          if (!(await engine.completeJob(id, `w${w}:a`))) refusedCompletes.push(id - base);
        }
      };
      await Promise.all([submitter, ...Array.from({ length: 8 }, (_, w) => worker(w))]);
      const rows = await Promise.all(Array.from({ length: total }, (_, i) => engine.getJob(base + i)));
      const tally = (values: unknown[]) => Object.fromEntries(sorted([...new Set(values.map(String))]).map(v => [v, values.filter(x => String(x) === v).length]));
      return {
        claimed: [...claimed].sort((a, b) => a - b),
        twice: claimed.length - new Set(claimed).size,
        refusedCompletes,
        status: tally(rows.map(r => r?.status)),
        claimGeneration: tally(rows.map(r => Number(r?.claim_generation))),
        attemptsStarted: tally(rows.map(r => Number(r?.attempts_started))),
      };
    });

  parityTest('reclaimStalledJobs requeues an expired lease, kills one at max_stalled, requeues a dead worker\'s co-runners marked, and clears drain-lease holders',
    { methods: ['admitJob', 'claimNextJob', 'reclaimStalledJobs', 'getJob', 'acquireCycleLock'] }, async (engine) => {
      const parent = await add(engine, 'parent');
      const view = rowView(parent);
      const lone = await add(engine, 'work', { max_stalled: 3 });
      const last = await add(engine, 'work', { max_stalled: 1, parent_job_id: parent });
      const co1 = await add(engine, 'co');
      const co2 = await add(engine, 'co');
      const live = await add(engine, 'work');
      const held = await add(engine, 'beacon', { queue: 'gbrain-drain-lease' });
      const orphan = await add(engine, 'beacon', { queue: 'gbrain-drain-lease' });
      const expired = { lockDurationMs: -60_000 };
      await engine.claimNextJob(claimSpec('w1:a', expired));
      await engine.claimNextJob(claimSpec('w2:a', expired));
      await engine.claimNextJob(claimSpec('w3:a', { ...expired, names: ['co'] }));
      await engine.claimNextJob(claimSpec('w3:b', { ...expired, names: ['co'] }));
      await engine.claimNextJob(claimSpec('w4:a'));
      await engine.acquireCycleLock('gbrain-sync:held', { holderPid: 1, holderHost: 'h', acquisitionToken: TOKEN, ttlMinutes: 30, stealGraceSeconds: 0 });
      await engine.claimNextJob(claimSpec(TOKEN, { ...expired, queue: 'gbrain-drain-lease', names: ['beacon'] }));
      await engine.claimNextJob(claimSpec('00000000-0000-4000-8000-0000000000bb', { ...expired, queue: 'gbrain-drain-lease', names: ['beacon'] }));
      const swept = await engine.reclaimStalledJobs(0);
      const byId = (rows: JobRow[]) => sorted(rows.map(view), r => String(r!.id).padStart(6, '0'));
      const marked = await engine.getJob(co1);
      expect((marked?.stacktrace as string[]).includes(WATCHDOG_SUSPECT_MARK)).toBe(true);
      const again = await engine.reclaimStalledJobs(0);
      const suspect = await engine.claimNextJob(claimSpec('w5:a', { names: ['co'], excludeWatchdogSuspects: true }));
      return {
        requeued: byId(swept.requeued), dead: byId(swept.dead), again: { requeued: again.requeued.length, dead: again.dead.length },
        lone: view(await engine.getJob(lone)), last: view(await engine.getJob(last)), co2: view(await engine.getJob(co2)),
        live: view(await engine.getJob(live)), parent: view(await engine.getJob(parent)),
        held: view(await engine.getJob(held)), orphan: await engine.getJob(orphan), suspect: view(suspect),
      };
    });
});
