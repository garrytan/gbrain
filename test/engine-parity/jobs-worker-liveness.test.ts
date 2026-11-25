/**
 * BrainEngine parity — a minion worker stays alive on every engine, and the two places it hands a just-claimed job
 * back (the pause marker that appeared after the claim, quiet hours) leave the same row (src/core/minions/worker.ts:
 * the health probe, `releaseClaimForPause`, `handleQuietHoursDefer`). Three arms: PGLite always, Postgres with
 * DATABASE_URL, Rust through test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a worker whose store answers its health probe runs past more than three health intervals without
 *    emitting `unhealthy`, and still takes and finishes a job afterwards. A claim released for the pause marker or
 *    deferred for quiet hours goes back to `delayed` with its lock cleared and a delay of one minute or fifteen minutes,
 *    keeps its start time, attempt counts and error text, and a claim another worker holds is left alone. The store's
 *    liveness round trip (`pingStore`, on the default and the direct lane) answers while the store is open and rejects
 *    once it is closed or the call's signal has aborted, so the worker's health logic still sees a dead store.
 *  - Regression: the Rust engine refuses raw SQL, so its worker's `SELECT 1` probe failed three times in a row and the
 *    worker stopped as `db_dead` after about three health intervals, and the release and defer statements threw the same
 *    refusal, so a released claim stayed active until its lock expired.
 *  - Why existing coverage misses it: test/worker-supervised-db-probe.test.ts, test/autopilot-pause-marker.test.ts and
 *    test/worker-quiet-hours-skip-keeps-cancelled.test.ts run PGLite only.
 *  - Seam: the worker's private release methods are called directly (the pause marker and the quiet-hours clock are
 *    process state a case would otherwise have to fake). Real engines and a real worker otherwise. Ids are compared
 *    relative to the case's first job and clock readings as present or absent, delays as the minutes they land on.
 *  - Not covered: the quiet-hours skip verdict. Its first statement clears the lock of a row that is still active, which
 *    the queue-protocol trigger refuses on PGLite and Postgres, so a skip never reaches the cancel on any engine.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ClaimJobSpec, JobInsertValues, JobRow } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision } from '../../src/core/minions/submission-authority.ts';
import { MinionWorker, type UnhealthyReason } from '../../src/core/minions/worker.ts';
import type { MinionQueue } from '../../src/core/minions/queue.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

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
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string, name: string): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: [name], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 },
  };
}

/** A new job claimed by `token` (its name is unique to the case, so the claim takes this row). */
async function active(engine: BrainEngine, name: string, token: string): Promise<{ id: number; job: JobRow }> {
  const id = await add(engine, name);
  const job = await engine.claimNextJob(claimSpec(token, name));
  expect(Number(job?.id)).toBe(id);
  return { id, job: job! };
}

const minutesAhead = (v: unknown) => (v == null ? null : Math.round((new Date(v as string | Date).getTime() - Date.now()) / 60_000));

/** The row as the engines must agree on it: ids relative to `base`, clock readings as present or absent, the delay in minutes. */
function view(base: number) {
  return (r: JobRow | null | undefined) => (!r ? null : {
    id: Number(r.id) - base, status: r.status, attempts_made: r.attempts_made, attempts_started: Number(r.attempts_started),
    stalled_counter: r.stalled_counter, lock_token: r.lock_token, error_text: r.error_text, stacktrace: r.stacktrace,
    delay_minutes: minutesAhead(r.delay_until),
    has: Object.fromEntries(['lock_until', 'delay_until', 'timeout_at', 'started_at', 'finished_at'].map(k => [k, r[k] != null])),
  });
}

interface WorkerInternals {
  queue: MinionQueue & { ensureSchema(): Promise<void> };
  releaseClaimForPause(job: unknown, lockToken: string): Promise<void>;
  handleQuietHoursDefer(job: unknown, lockToken: string, verdict: 'skip' | 'defer'): Promise<void>;
}

/** Runs `run` with the worker's console output and the engine's logging silenced; the messages it wrote come back. */
async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const { log, error } = console;
  const errors: string[] = [];
  console.log = () => {};
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    return { value: await run(), errors };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('engine parity: a minion worker stays alive and releases a claim as every engine does', () => {
  parityTest('a worker runs past more than three health intervals without going unhealthy and still finishes a job',
    { methods: ['pingStore', 'admitJob', 'claimNextJob', 'completeJob', 'getJob'], timeout: 90_000 }, async (engine) => {
      // Count the probes that completed, through a wrapper that still calls the engine's own pingStore.
      let completedProbes = 0;
      const counted = new Proxy(engine, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'pingStore') {
            return async (opts?: { signal?: AbortSignal; direct?: boolean }) => {
              await (value as BrainEngine['pingStore']).call(target, opts);
              completedProbes++;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const worker = new MinionWorker(counted, {
        queue: 'default', concurrency: 1, pollInterval: 25, maxRssMb: 0, healthCheckInterval: 20, dbFailExitAfter: 3,
        dbProbeTimeoutMs: 1_000,
      });
      worker.register('noop', async () => {});
      const unhealthy: UnhealthyReason[] = [];
      worker.on('unhealthy', info => unhealthy.push(info));
      const until = async (done: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (await done()) return true;
          await Bun.sleep(10);
        }
        return await done();
      };
      // Count only the periodic health probes: the probes before 'ready' (Postgres's readiness ping) do not count.
      let ready = false;
      let probesAtReady = 0;
      worker.on('ready', () => { ready = true; probesAtReady = completedProbes; });
      const { value } = await quietly(async () => {
        const run = worker.start();
        try {
          const isReady = await until(() => ready || unhealthy.length > 0, 10_000);
          // Three failed probes end a worker; more than three completed ones show the probe keeps answering.
          const probed = await until(() => completedProbes - probesAtReady >= 4 || unhealthy.length > 0, 10_000);
          const afterProbes = completedProbes - probesAtReady;
          const id = await add(engine, 'noop');
          const finished = await until(async () => String((await engine.getJob(id))?.status) === 'completed' || unhealthy.length > 0, 10_000);
          const status = String((await engine.getJob(id))?.status);
          return {
            isReady, probed, atLeastFourProbes: afterProbes >= 4, finished, status, unhealthy: unhealthy.map(u => u.reason),
          };
        } finally {
          worker.stop();
          await run;
        }
      });
      expect(value).toEqual({ isReady: true, probed: true, atLeastFourProbes: true, finished: true, status: 'completed', unhealthy: [] });
      return value;
    });

  parityTest('an idle worker keeps running well past stallWarnAfterMs, checks the waiting count each tick, and still finishes a job',
    { methods: ['pingStore', 'countWaitingJobsForNames', 'admitJob', 'claimNextJob', 'completeJob', 'getJob'], timeout: 90_000 }, async (engine) => {
      // A waiting job of a name this worker does not handle: the stall check runs its count, which answers 0 for this worker.
      const unhandled = await add(engine, 'not-handled-here');
      // Count the stall counts that completed, through a wrapper that still calls the engine's own member: a worker that
      // never reaches the stall check (or stops at it) never moves this number.
      let completedStallCounts = 0;
      const counted = new Proxy(engine, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'countWaitingJobsForNames') {
            return async (queue: string, names: readonly string[]) => {
              const n = await (value as BrainEngine['countWaitingJobsForNames']).call(target, queue, names);
              completedStallCounts++;
              return n;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const stallWarnAfterMs = 60;
      const worker = new MinionWorker(counted, {
        queue: 'default', concurrency: 1, pollInterval: 25, maxRssMb: 0, healthCheckInterval: 20, dbFailExitAfter: 3,
        dbProbeTimeoutMs: 1_000, stallWarnAfterMs, stallExitAfterMs: 600_000,
      });
      worker.register('noop', async () => {});
      const unhealthy: UnhealthyReason[] = [];
      worker.on('unhealthy', info => unhealthy.push(info));
      const until = async (done: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (await done()) return true;
          await Bun.sleep(10);
        }
        return await done();
      };
      let readyAt = 0;
      let countsAtReady = 0;
      worker.on('ready', () => { readyAt = Date.now(); countsAtReady = completedStallCounts; });
      const { value } = await quietly(async () => {
        const run = worker.start();
        try {
          const isReady = await until(() => readyAt > 0 || unhealthy.length > 0, 10_000);
          // Idle time counts from the start of the run, so past this point every health tick runs the stall check.
          const pastThreshold = await until(() => (readyAt > 0 && Date.now() > readyAt + stallWarnAfterMs + 40) || unhealthy.length > 0, 10_000);
          // Each tick past the threshold completes one stall count (at least four after 'ready'); a refused count would have ended the worker on its first.
          const ticked = await until(() => completedStallCounts - countsAtReady >= 4 || unhealthy.length > 0, 10_000);
          const ticksPastThreshold = completedStallCounts - countsAtReady;
          const id = await add(engine, 'noop');
          const finished = await until(async () => String((await engine.getJob(id))?.status) === 'completed' || unhealthy.length > 0, 10_000);
          return {
            isReady, pastThreshold, ticked, atLeastFourTicks: ticksPastThreshold >= 4, finished,
            status: String((await engine.getJob(id))?.status), unhandledStatus: String((await engine.getJob(unhandled))?.status),
            unhealthy: unhealthy.map(u => u.reason),
          };
        } finally {
          worker.stop();
          await run;
        }
      });
      expect(value).toEqual({
        isReady: true, pastThreshold: true, ticked: true, atLeastFourTicks: true, finished: true, status: 'completed',
        unhandledStatus: 'waiting', unhealthy: [],
      });
      return value;
    });

  parityTest('a claim released because the pause marker appeared goes back to delayed for a minute, and a claim another worker holds is left alone',
    { methods: ['releaseClaimForPause', 'admitJob', 'claimNextJob', 'getJob'] }, async (engine) => {
      const { id, job } = await active(engine, 'paused', 'w1:a');
      const v = view(id);
      const worker = new MinionWorker(engine, { queue: 'default', concurrency: 1 }) as unknown as WorkerInternals;
      await worker.queue.ensureSchema();
      const held = v(await engine.getJob(id));
      const stale = await quietly(() => worker.releaseClaimForPause(job, 'w9:a'));
      const afterStale = v(await engine.getJob(id));
      const released = await quietly(() => worker.releaseClaimForPause(job, 'w1:a'));
      const afterRelease = v(await engine.getJob(id));
      const again = await quietly(() => worker.releaseClaimForPause(job, 'w1:a'));
      const afterAgain = v(await engine.getJob(id));
      expect(held?.status).toBe('active');
      expect(afterStale).toEqual(held);
      expect(afterRelease).toMatchObject({ status: 'delayed', lock_token: null, error_text: null, delay_minutes: 1, attempts_made: 0, attempts_started: 1 });
      expect(afterRelease?.has).toMatchObject({ lock_until: false, delay_until: true, started_at: true });
      // The member the worker calls, on its own: a stale token changes nothing, the holder's token releases, a repeat changes nothing.
      const direct = await active(engine, 'paused-direct', 'w3:a');
      const dv = view(direct.id);
      await engine.releaseClaimForPause(direct.id, 'w9:a');
      const directStale = dv(await engine.getJob(direct.id));
      await engine.releaseClaimForPause(direct.id, 'w3:a');
      const directReleased = dv(await engine.getJob(direct.id));
      await engine.releaseClaimForPause(direct.id, 'w3:a');
      const directAgain = dv(await engine.getJob(direct.id));
      expect(directStale?.status).toBe('active');
      expect(directReleased).toMatchObject({ status: 'delayed', lock_token: null, delay_minutes: 1 });
      return {
        held, afterStale, afterRelease, afterAgain, errors: [stale.errors, released.errors, again.errors],
        directStale, directReleased, directAgain,
      };
    });

  parityTest('quiet hours defer returns a claim to delayed for fifteen minutes and leaves a claim another worker holds alone',
    { methods: ['deferClaimForQuietHours', 'admitJob', 'claimNextJob', 'getJob'] }, async (engine) => {
      const deferred = await active(engine, 'defer-me', 'w1:a');
      const other = await active(engine, 'held-by-other', 'w2:a');
      const v = view(deferred.id);
      const worker = new MinionWorker(engine, { queue: 'default', concurrency: 1 }) as unknown as WorkerInternals;
      await worker.queue.ensureSchema();

      const held = v(await engine.getJob(deferred.id));
      const wrongToken = await quietly(() => worker.handleQuietHoursDefer(other.job, 'w9:a', 'defer'));
      const afterWrongToken = v(await engine.getJob(other.id));
      const defer = await quietly(() => worker.handleQuietHoursDefer(deferred.job, 'w1:a', 'defer'));
      const afterDefer = v(await engine.getJob(deferred.id));
      const again = await quietly(() => worker.handleQuietHoursDefer(deferred.job, 'w1:a', 'defer'));
      const afterAgain = v(await engine.getJob(deferred.id));

      expect(held?.status).toBe('active');
      expect(afterWrongToken).toMatchObject({ status: 'active', lock_token: 'w2:a' });
      expect(afterDefer).toMatchObject({ status: 'delayed', lock_token: null, error_text: null, delay_minutes: 15, attempts_made: 0, attempts_started: 1 });
      expect(afterDefer?.has).toMatchObject({ lock_until: false, delay_until: true, started_at: true });
      // The member the worker calls, on its own.
      const direct = await active(engine, 'defer-direct', 'w3:a');
      const dv = view(direct.id);
      await engine.deferClaimForQuietHours(direct.id, 'w9:a');
      const directStale = dv(await engine.getJob(direct.id));
      await engine.deferClaimForQuietHours(direct.id, 'w3:a');
      const directDeferred = dv(await engine.getJob(direct.id));
      await engine.deferClaimForQuietHours(direct.id, 'w3:a');
      const directAgain = dv(await engine.getJob(direct.id));
      expect(directStale?.status).toBe('active');
      expect(directDeferred).toMatchObject({ status: 'delayed', lock_token: null, delay_minutes: 15 });
      return {
        held, afterWrongToken, afterDefer, afterAgain, errors: [wrongToken.errors, defer.errors, again.errors],
        directStale, directDeferred, directAgain,
      };
    });

  parityTest('quiet hours skip on a claim: PGLite and Postgres log the engine error and go on; a Rust refusal is not swallowed',
    { methods: ['admitJob', 'claimNextJob', 'getJob'] }, async (engine) => {
      const { id, job } = await active(engine, 'skip-me', 'w1:a');
      const v = view(id);
      const worker = new MinionWorker(engine, { queue: 'default', concurrency: 1 }) as unknown as WorkerInternals;
      await worker.queue.ensureSchema();
      // No catch here: on Rust the capability refusal of the first statement must reach the caller (the case then ends on it).
      const skip = await quietly(() => worker.handleQuietHoursDefer(job, 'w1:a', 'skip'));
      const after = v(await engine.getJob(id));
      // The SQL engines refuse the lock-clearing UPDATE of an active row (the queue-protocol trigger), log it and resolve.
      expect(after?.status).toBe('active');
      expect(skip.errors.length).toBe(1);
      return { after, errors: skip.errors.map(e => e.replace(`job ${id}:`, 'job <id>:')) };
    });

  parityTest('pingStore answers on the default and the direct lane, and rejects once the store is closed',
    { methods: ['pingStore', 'connect', 'initSchema', 'disconnect'] }, async (_engine, _backend, ctx) => {
      const { engine: second, config } = ctx.unconnectedEngine();
      await second.connect(config);
      await second.initSchema();
      const answers = [
        await second.pingStore().then(() => 'answered', () => 'rejected'),
        await second.pingStore({ signal: new AbortController().signal }).then(() => 'answered', () => 'rejected'),
        await second.pingStore({ direct: true }).then(() => 'answered', () => 'rejected'),
      ];
      const aborted = new AbortController();
      aborted.abort();
      const abortedAnswer = await second.pingStore({ signal: aborted.signal }).then(() => 'answered', () => 'rejected');
      await second.disconnect();
      const closed = await second.pingStore().then(() => 'answered', () => 'rejected');
      const closedDirect = await second.pingStore({ direct: true }).then(() => 'answered', () => 'rejected');
      expect(answers).toEqual(['answered', 'answered', 'answered']);
      expect({ abortedAnswer, closed, closedDirect }).toEqual({ abortedAnswer: 'rejected', closed: 'rejected', closedDirect: 'rejected' });
      return { answers, abortedAnswer, closed, closedDirect };
    });
});
