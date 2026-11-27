/**
 * BrainEngine parity — queue health reads (engine-sql/jobs-health.ts): the counts `gbrain doctor`'s queue checks, the
 * advisor's stalled-jobs collector and the submit-time queue probe ask of `minion_jobs`: readQueueHealthSignals,
 * listWaitingByQueue, readQueueDivergence, listQueueWedgeCounts, listPrivateQueueHealth, readWedgeSignals,
 * readOldestWaitingAge, countWaitingJobs, countWaitingJobsForNames, listStuckActiveJobsByName and readUntakenWaitingJobs (the
 * facts_drain phase's no-worker check, src/core/minions/no-worker.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read returns the same counts, ties, orders and nulls on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): which statuses and names a count includes,
 *    what a window or cut-off lets in, the limit of five with the full total beside it, the `prompt_too_long:` match (its
 *    underscores are LIKE wildcards), the dream phase a dead subagent's key names (its own or the one a release kept in
 *    `data`), a delayed job that is due, a lapsed lock against a live one, and the bytewise order of equal counts.
 *  - Regression: an engine that counts delayed as waiting, a lapsed lock as live, a cancellation outside its prefix or
 *    window, a source id by locale instead of bytes, drops the total behind the five listed, or reads the wrong dream
 *    phase, would make `gbrain doctor` call a healthy queue wedged (or a wedged one healthy), and make the advisor and
 *    the submit probe misreport it.
 *  - Why existing coverage misses it: test/doctor-*.test.ts and test/supervisor-wedge.test.ts script `executeRaw` or run
 *    PGLite only; nothing compares the engines on one scenario, and a Rust engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Every window and cut-off is an argument, so a
 *    case moves rows inside or outside it with a negative or a huge number, and a lapsed lock comes from a negative
 *    lock duration; nothing waits out a clock. Ids are compared relative to the case's first job, and clock readings
 *    (ages, minutes, dates) only as a range.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision } from '../../src/core/minions/submission-authority.ts';
import { untakenWaitingJobs, runWaitingJobsFix } from '../../src/core/minions/no-worker.ts';
import { runPhaseFactsDrain } from '../../src/core/cycle/facts-drain.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const PAST = '2000-01-01T00:00:00.000Z';
const FAR = '2099-01-01T00:00:00.000Z';
const TTL = 'waiting_ttl_expired';

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

const policy: AdmitJobPolicy = {
  decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
  parentAuthorityKind: () => null,
};

function admit(engine: BrainEngine, spec: Partial<AdmitJobSpec> & { insert: JobInsertValues }) {
  return engine.admitJob({ maxSpawnDepth: 5, ...spec }, policy);
}

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, { insert: values(name, extra) });
  expect(out.coalesced).toBe(false);
  // Claims and lists break priority ties on created_at, which two quick submissions can share on PGLite.
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** A new job, claimed by `token`; `claim.lockDurationMs` negative leaves a lapsed lock. */
async function active(engine: BrainEngine, name: string, token: string, extra: Partial<JobInsertValues> = {}, claim: Partial<ClaimJobSpec> = {}): Promise<number> {
  const id = await add(engine, name, extra);
  const row = await engine.claimNextJob(claimSpec(token, { names: [name], queue: extra.queue ?? 'default', ...claim }));
  expect(Number(row?.id)).toBe(id);
  return id;
}

/** A new job that ended as `how`; `errorText` is its error. */
async function ended(engine: BrainEngine, name: string, how: 'failed' | 'dead', errorText: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const token = `end:${name}:${errorText}`;
  const id = await active(engine, name, token, extra);
  await engine.failJob(id, token, errorText, how);
  return id;
}

async function completed(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const id = await active(engine, name, `done:${name}`, extra);
  await engine.completeJob(id, `done:${name}`);
  return id;
}

/** Waiting jobs: `n` of `name` in `queue`. */
async function waiting(engine: BrainEngine, name: string, n: number, queue = 'default'): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await add(engine, name, { queue }));
  return ids;
}

/** A clock reading is a whole number of seconds within a few minutes of now (the case just created the rows). */
const recentSeconds = (n: number | null) => n !== null && Number.isInteger(n) && n >= 0 && n < 600;
const recentMinutes = (n: number | null) => n !== null && n >= 0 && n < 10;
const recentDate = (d: Date | null) => d !== null && Math.abs(d.getTime() - Date.now()) < 600_000;

describe('engine parity: queue health reads', () => {
  parityTest('readQueueHealthSignals counts stalled-forever, deep, watchdog-killed, prompt_too_long and old embed-backfill jobs inside the spec\'s cut-offs',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'readQueueHealthSignals'] }, async (engine) => {
      // Seven active jobs (a live lock each) one name and queue apart: only the five oldest list, the total says seven.
      const first = await active(engine, 'stall-0', 's0');
      const base = first;
      for (let i = 1; i < 7; i++) await active(engine, `stall-${i}`, `s${i}`);
      // Waiting depth: names that tie on count order bytewise ('Zed' before 'alpha'), a delayed job never counts.
      await waiting(engine, 'sync', 3);
      await waiting(engine, 'sync', 2, 'other-q');
      await waiting(engine, 'Zed', 2);
      await waiting(engine, 'alpha', 2);
      await waiting(engine, 'zeta', 2); // a sixth group over the threshold: the limit of five cuts it
      await waiting(engine, 'embed-backfill', 3, 'q-embed');
      // Whole seconds apart, so the oldest group lists first (an ascending order lists the newer one first).
      await Bun.sleep(1600);
      await waiting(engine, 'embed-backfill', 1);
      await add(engine, 'sync', { status: 'delayed', delay_until: FAR });
      // Watchdog kills: dead or failed with exactly that text.
      await ended(engine, 'job-a', 'dead', 'aborted: watchdog');
      await ended(engine, 'job-b', 'failed', 'aborted: watchdog');
      await ended(engine, 'job-c', 'dead', 'aborted: watchdog again');
      await ended(engine, 'job-d', 'failed', 'something else');
      // prompt_too_long by dream phase: the key, or the key a release kept in data; `_` matches any one character.
      await ended(engine, 'subagent', 'dead', 'prompt_too_long: a', { idempotency_key: 'dream:patterns:one' });
      await ended(engine, 'subagent', 'dead', 'prompt_too_long: b', { idempotency_key: 'dream:patterns:two' });
      await ended(engine, 'subagent', 'dead', 'prompt_too_long: c', { idempotency_key: 'dream:synthesize:one' });
      await ended(engine, 'subagent', 'dead', 'prompt_too_long: d', { idempotency_key: 'dream:synth-x' });
      await ended(engine, 'subagent', 'dead', 'prompt_too_long: e', { data: { __released_idempotency_key: 'dream:patterns:kept' } });
      await ended(engine, 'subagent', 'dead', 'prompt_too_long: f', { idempotency_key: 'something-else' });
      await ended(engine, 'subagent', 'dead', 'prompt_too_long: g');
      await ended(engine, 'subagent', 'dead', 'promptXtooXlong: wildcard');
      await ended(engine, 'subagent', 'dead', 'prompt_too_longer no colon');
      await ended(engine, 'subagent', 'failed', 'prompt_too_long: failed not dead', { idempotency_key: 'dream:patterns:failed' });
      await ended(engine, 'not-subagent', 'dead', 'prompt_too_long: other name');

      const spec = { waitingThreshold: 1, oldWaitingHours: -1, windowHours: 24, stalledAfterHours: -1 };
      const signals = async (s: typeof spec) => {
        const r = await engine.readQueueHealthSignals(s);
        return {
          stalled: r.stalled.map(x => ({ id: x.id - base, name: x.name, total: x.total })),
          depth: r.depth, rss_kills: r.rss_kills, prompt_too_long: r.prompt_too_long,
          old_embed_backfill: r.old_embed_backfill.map(x => ({ name: x.name, queue: x.queue, depth: x.depth, recent: recentSeconds(x.oldest_age_seconds) })),
        };
      };
      const all = await signals(spec);
      expect(all.stalled.length).toBe(5);
      expect(all.stalled[0]?.total).toBe(7);
      return {
        all,
        // `HAVING count > threshold` is strict: a depth equal to it is not listed.
        strict: (await signals({ ...spec, waitingThreshold: 2 })).depth,
        none: await signals({ waitingThreshold: 1000, oldWaitingHours: 1, windowHours: -1, stalledAfterHours: 1 }),
        wideWindow: (await signals({ ...spec, windowHours: 100_000, oldWaitingHours: 100_000 })).old_embed_backfill,
      };
    });

  parityTest('listWaitingByQueue counts only waiting jobs per queue, deepest first and bytewise by name on a tie',
    { methods: ['admitJob', 'claimNextJob', 'pauseJob', 'listWaitingByQueue'] }, async (engine) => {
      await waiting(engine, 'work', 3);
      await waiting(engine, 'work', 2, 'aq');
      await waiting(engine, 'work', 2, 'Zq');
      await waiting(engine, 'work', 1, 'mq');
      // A queue with no waiting job never lists: delayed, paused and active rows do not count.
      await add(engine, 'work', { queue: 'dq', status: 'delayed', delay_until: FAR });
      const paused = await add(engine, 'work', { queue: 'dq' });
      expect(await engine.pauseJob(paused)).not.toBeNull();
      await active(engine, 'work', 'w1', { queue: 'dq' });
      const rows = await engine.listWaitingByQueue();
      return rows.map(r => ({ queue: r.queue, depth: r.depth, recent: recentSeconds(r.oldest_age_seconds) }));
    });

  parityTest('readQueueDivergence counts intake, completions and waiting per waiting name, and waiting-TTL cancellations, inside the window',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'cancelJobs', 'readQueueDivergence'] }, async (engine) => {
      // A claim takes the oldest waiting job of its name, so each name's active and completed jobs come first.
      await completed(engine, 'alpha');
      await completed(engine, 'alpha');
      await completed(engine, 'gamma');
      await waiting(engine, 'alpha', 2);
      await waiting(engine, 'Beta', 1);
      await add(engine, 'delayed-only', { status: 'delayed', delay_until: FAR });
      const [c1, c2] = await waiting(engine, 'alpha', 2);
      const [c3] = await waiting(engine, 'Beta', 1);
      const [c4] = await waiting(engine, 'Beta', 1);
      const [c5] = await waiting(engine, 'Beta', 1);
      const [c6] = await waiting(engine, 'Beta', 1);
      await engine.cancelJobs([c1!, c2!, c3!], { reason: `${TTL}: waited > 1h in queue` });
      await engine.cancelJobs([c4!], { reason: 'cancelled by an operator' });
      await engine.cancelJobs([c5!]);
      await engine.cancelJobs([c6!], { reason: 'waitingXttlXexpired: wildcard' });
      const read = (windowHours: number) => engine.readQueueDivergence({ windowHours, ttlReasonPrefix: TTL });
      return { inside: await read(24), outside: await read(-1), wide: await read(100_000) };
    });

  parityTest('listQueueWedgeCounts reports live-lock active rows, waiting rows and minutes since the last completion per queue, private dream queues excluded',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'listQueueWedgeCounts'] }, async (engine) => {
      await active(engine, 'live', 'l1');
      await active(engine, 'lapsed', 'l2', {}, { lockDurationMs: -60_000 });
      await waiting(engine, 'work', 2);
      await completed(engine, 'done');
      await add(engine, 'delayed', { status: 'delayed', delay_until: FAR });
      await waiting(engine, 'work', 1, 'Q2');
      await active(engine, 'lapsed', 'l3', { queue: 'aq' }, { lockDurationMs: -60_000 });
      await waiting(engine, 'work', 4, 'dream-inline-1-aaaa');
      const rows = await engine.listQueueWedgeCounts();
      return rows.map(r => ({
        queue: r.queue, active_healthy: r.active_healthy, waiting: r.waiting,
        mins: r.mins_since_completion === null ? null : recentMinutes(r.mins_since_completion),
      }));
    });

  parityTest('listPrivateQueueHealth reads each dream-inline queue\'s live, waiting-class and paused rows, oldest wait, birth and smallest source id',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'pauseJob', 'listPrivateQueueHealth'] }, async (engine) => {
      const QA = 'dream-inline-100-aaaa';
      const QB = 'dream-inline-200-bbbb';
      await active(engine, 'm', 'a1', { queue: QA, data: {} });
      await completed(engine, 'm', { queue: QA, data: { source_id: 'src-z' } });
      await active(engine, 'm', 'b1', { queue: QB }, { lockDurationMs: -60_000 });
      await add(engine, 'm', { queue: QA, data: { source_id: 'src-b' } });
      await add(engine, 'm', { queue: QA, status: 'delayed', delay_until: FAR, data: { source_id: 'src-a' } });
      const paused = await add(engine, 'm', { queue: QA, data: { source_id: 'Src-C' } });
      expect(await engine.pauseJob(paused)).not.toBeNull();
      await waiting(engine, 'work', 2);
      const rows = await engine.listPrivateQueueHealth();
      return rows.map(r => ({
        queue: r.queue, source_id: r.source_id, active_healthy: r.active_healthy, waiting: r.waiting, paused: r.paused,
        oldest_waiting: r.oldest_waiting_minutes === null ? null : recentMinutes(r.oldest_waiting_minutes),
        born: r.birth_epoch_ms !== null && Math.abs(r.birth_epoch_ms - Date.now()) < 600_000,
      }));
    });

  parityTest('readWedgeSignals counts one queue\'s stalled, live, waiting and claimable rows and last completions; readOldestWaitingAge is its oldest waiting job',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'readWedgeSignals', 'readOldestWaitingAge'] }, async (engine) => {
      const Q = 'wq';
      await active(engine, 'work', 'w1', { queue: Q });
      await active(engine, 'work', 'w2', { queue: Q }, { lockDurationMs: -60_000 });
      await active(engine, 'zzz', 'w3', { queue: Q });
      await completed(engine, 'work', { queue: Q });
      await completed(engine, 'zzz', { queue: Q });
      await completed(engine, 'zzz', { queue: 'only-zzz' });
      await waiting(engine, 'work', 2, Q);
      await waiting(engine, 'zzz', 1, Q);
      await add(engine, 'work', { queue: Q, status: 'delayed', delay_until: PAST });
      await add(engine, 'work', { queue: Q, status: 'delayed', delay_until: FAR });
      await add(engine, 'zzz', { queue: Q, status: 'delayed', delay_until: PAST });
      await add(engine, 'work', { queue: 'only-delayed', status: 'delayed', delay_until: FAR });
      // The oldest of two waiting jobs a few seconds apart: the age of the older one, not the newer.
      await add(engine, 'work', { queue: 'age-q' });
      await Bun.sleep(1600);
      await add(engine, 'work', { queue: 'age-q' });
      const view = (s: Awaited<ReturnType<BrainEngine['readWedgeSignals']>>) => ({
        stalled: s.stalled, activeHealthy: s.activeHealthy, waiting: s.waiting, waitingClaimable: s.waitingClaimable,
        lastCompleted: s.lastCompleted === null ? null : recentDate(s.lastCompleted),
        lastCompletedClaimable: s.lastCompletedClaimable === null ? null : recentDate(s.lastCompletedClaimable),
      });
      const signal = new AbortController().signal;
      const age = async (q: string) => { const a = await engine.readOldestWaitingAge(q); return a === null ? null : recentSeconds(a); };
      return {
        handled: view(await engine.readWedgeSignals(Q, ['work', 'extra'])),
        withSignal: view(await engine.readWedgeSignals(Q, ['work'], { signal })),
        noHandlers: view(await engine.readWedgeSignals(Q, [])),
        otherNames: view(await engine.readWedgeSignals('only-zzz', ['work'])),
        empty: view(await engine.readWedgeSignals('no-such-queue', ['work'])),
        age: await age(Q), ageSignal: await engine.readOldestWaitingAge(Q, { signal }) !== null,
        ageOldest: (await engine.readOldestWaitingAge('age-q') ?? 0) >= 1,
        ageNone: await age('no-such-queue'), ageDelayedOnly: await age('only-delayed'), ageCompletedOnly: await age('only-zzz'),
      };
    });

  parityTest('listStuckActiveJobsByName counts active jobs with a lapsed lock or two stalls per name, most first and bytewise on a tie',
    { methods: ['admitJob', 'claimNextJob', 'completeJob', 'reclaimStalledJobs', 'getJob', 'listStuckActiveJobsByName'] }, async (engine) => {
      // Two stalls (the reclaim requeues it each time), then a live claim: active, a live lock, stalled_counter 2.
      const twice = await active(engine, 'beta', 'b1', { max_stalled: 5 }, { lockDurationMs: -60_000 });
      await engine.reclaimStalledJobs(0);
      await engine.claimNextJob(claimSpec('b2', { names: ['beta'], lockDurationMs: -60_000 }));
      await engine.reclaimStalledJobs(0);
      await engine.claimNextJob(claimSpec('b3', { names: ['beta'] }));
      expect((await engine.getJob(twice))?.stalled_counter).toBe(2);
      // One stall only: not stuck while its lock is live.
      const once = await active(engine, 'gamma', 'g1', { max_stalled: 5 }, { lockDurationMs: -60_000 });
      await engine.reclaimStalledJobs(0);
      await engine.claimNextJob(claimSpec('g2', { names: ['gamma'] }));
      expect((await engine.getJob(once))?.stalled_counter).toBe(1);
      await active(engine, 'work', 'k1', {}, { lockDurationMs: -60_000 });
      await active(engine, 'work', 'k2', {}, { lockDurationMs: -60_000 });
      await active(engine, 'Alpha', 'k3', {}, { lockDurationMs: -60_000 });
      await active(engine, 'Alpha', 'k4', {}, { lockDurationMs: -60_000 });
      await active(engine, 'fine', 'k5');
      await waiting(engine, 'waiting-one', 2);
      await completed(engine, 'work');
      return await engine.listStuckActiveJobsByName();
    });

  parityTest('readUntakenWaitingJobs names the queue whose waiting facts-absorb jobs no worker takes, and facts_drain warns no_worker on a server engine',
    { methods: ['admitJob', 'claimNextJob', 'readUntakenWaitingJobs'] }, async (engine, backend) => {
      // 0.0003 h is 1.08 s: the jobs below wait 1.5 s before the reads, so they are past it, and the job claimed after the
      // wait started inside it, so its queue counts as served.
      const H = 0.0003;
      await waiting(engine, 'facts-absorb', 2, 'idle-q');
      await waiting(engine, 'facts-absorb', 1, 'served-q');
      await waiting(engine, 'work', 1, 'work-q');
      await Bun.sleep(1500);
      await active(engine, 'work', 'served', { queue: 'served-q' });
      const view = (r: Awaited<ReturnType<BrainEngine['readUntakenWaitingJobs']>>) =>
        r === null ? null : { queue: r.queue, waiting: r.waiting, aged: Number.isInteger(r.oldest_age_seconds) && r.oldest_age_seconds >= 1 && r.oldest_age_seconds < 600 };
      const member = {
        stuck: view(await engine.readUntakenWaitingJobs('facts-absorb', H)),
        // A day-long threshold: nothing has waited that long.
        fresh: view(await engine.readUntakenWaitingJobs('facts-absorb', 24)),
        otherName: view(await engine.readUntakenWaitingJobs('work', H)),
        none: view(await engine.readUntakenWaitingJobs('no-such-job', H)),
      };
      return withEnv({ GBRAIN_QUEUE_NO_WORKER_WARN_HOURS: String(H) }, async () => {
        if (backend !== 'pglite') {
          // Postgres and the Rust engine have no facts drain in the cycle: the phase warns, naming the supervisor. It runs
          // first, so an engine whose check fails shows the phase's own no_worker_check_failed warning here.
          const phase = await runPhaseFactsDrain(engine, { dryRun: false });
          const details = phase.details as { no_worker?: { oldest_age_seconds: number } };
          const age = details.no_worker?.oldest_age_seconds ?? -1;
          expect({ backend, phase }).toEqual({ backend, phase: {
            phase: 'facts_drain', duration_ms: 0, status: 'warn',
            details: { reason: 'no_worker', no_worker: { queue: 'idle-q', waiting: 2, oldest_age_seconds: age, threshold_hours: H,
              fix: runWaitingJobsFix('postgres', 'idle-q') }, dead_retry: { resubmitted: 0, pending: 0, exhausted: 0, not_retryable: 0 } },
            summary: `2 facts-absorb job(s) have waited up to 1m on queue 'idle-q' and no job worker has run a job there in ${H}h, so no facts are being extracted; start one: gbrain jobs supervisor start --queue idle-q`,
          } });
          expect({ backend, aged: age >= 1 && age < 600 }).toEqual({ backend, aged: true });
        }
        const untaken = await untakenWaitingJobs(engine, 'facts-absorb');
        expect(untaken?.fix).toEqual(runWaitingJobsFix(engine.kind, 'idle-q'));
        return { member, helper: untaken === null ? null : { queue: untaken.queue, waiting: untaken.waiting, threshold_hours: untaken.threshold_hours } };
      });
    });

  parityTest('readUntakenWaitingJobs calls a freshly queued facts-absorb job not stuck, and facts_drain on a server engine does not warn',
    { methods: ['admitJob', 'readUntakenWaitingJobs'] }, async (engine, backend) => {
      await waiting(engine, 'facts-absorb', 1, 'idle-q');
      if (backend !== 'pglite') {
        expect({ backend, phase: await runPhaseFactsDrain(engine, { dryRun: false }) }).toEqual({ backend, phase: {
          phase: 'facts_drain', duration_ms: 0, status: 'skipped', summary: 'Postgres brains run facts-absorb jobs on the job worker',
          details: { reason: 'not_applicable', dead_retry: { resubmitted: 0, pending: 0, exhausted: 0, not_retryable: 0 } },
        } });
      }
      const member = await engine.readUntakenWaitingJobs('facts-absorb', 1);
      const untaken = await untakenWaitingJobs(engine, 'facts-absorb');
      return { member, untaken };
    });

  parityTest('countWaitingJobs counts waiting jobs and can leave out facts-absorb jobs', { methods: ['admitJob', 'countWaitingJobs'] }, async (engine) => {
    const empty = await engine.countWaitingJobs(false);
    await waiting(engine, 'work', 2);
    await waiting(engine, 'facts-absorb', 1);
    await add(engine, 'work', { status: 'delayed', delay_until: FAR });
    await active(engine, 'busy', 'c1');
    const all = await engine.countWaitingJobs(false);
    const noAbsorb = await engine.countWaitingJobs(true);
    expect({ empty, all, noAbsorb }).toEqual({ empty: 0, all: 3, noAbsorb: 2 });
    return { empty, all, noAbsorb };
  });

  parityTest('countWaitingJobsForNames counts only the waiting jobs of one queue under the listed names',
    { methods: ['admitJob', 'claimNextJob', 'countWaitingJobsForNames'] }, async (engine) => {
      const empty = await engine.countWaitingJobsForNames('default', ['work']);
      await waiting(engine, 'work', 2);
      await waiting(engine, 'other', 1);
      await add(engine, 'work', { queue: 'side' });
      await add(engine, 'side-only', { queue: 'side' });
      await add(engine, 'work', { status: 'delayed', delay_until: FAR });
      await active(engine, 'busy', 'c1');
      await waiting(engine, 'busy', 1);
      const counts = {
        empty,
        oneName: await engine.countWaitingJobsForNames('default', ['work']),
        twoNames: await engine.countWaitingJobsForNames('default', ['work', 'other']),
        repeatedName: await engine.countWaitingJobsForNames('default', ['work', 'work']),
        sideQueue: await engine.countWaitingJobsForNames('side', ['work', 'side-only', 'other']),
        noNames: await engine.countWaitingJobsForNames('default', []),
        unknownQueue: await engine.countWaitingJobsForNames('no-such-queue', ['work', 'other']),
        unknownName: await engine.countWaitingJobsForNames('default', ['nothing']),
        otherCase: await engine.countWaitingJobsForNames('default', ['Work']),
        claimedAndWaiting: await engine.countWaitingJobsForNames('default', ['busy']),
      };
      expect(counts).toEqual({
        empty: 0, oneName: 2, twoNames: 3, repeatedName: 2, sideQueue: 2, noNames: 0, unknownQueue: 0, unknownName: 0,
        otherCase: 0, claimedAndWaiting: 1,
      });
      // Counted jobs leave the count once a worker claims them: the stall check counts only what is still waiting.
      await engine.claimNextJob(claimSpec('c2', { names: ['other'] }));
      const afterClaim = await engine.countWaitingJobsForNames('default', ['work', 'other']);
      expect(afterClaim).toBe(2);
      return { ...counts, afterClaim };
    });
});
