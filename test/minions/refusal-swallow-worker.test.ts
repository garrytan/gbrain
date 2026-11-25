/**
 * Refusal-swallow sites in the minion worker path (triage rows 7-11: spend refusal record, terminal hook, worker
 * pause release, quiet-hours defer, worker stall check): a raw-SQL catch must not turn the Rust engine's
 * `engine_capability_missing` refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each site either reads and writes through a typed member (so an engine whose `executeRaw` refuses runs it
 *    exactly as PGLite does, and the Rust arm is compared with it), or lets the refusal surface.
 *  - Regression: the refusal was logged at most, so a Rust brain's terminal hook never ran, a spend refusal left no result
 *    row, a pause or quiet-hours release left the claim to expire, and the stall check never looked.
 *  - Why existing coverage misses it: the worker tests run PGLite, where every raw statement succeeds.
 *  - Seam: a PGLite engine wrapped so `executeRaw`, or a named typed member, throws the real refusal
 *    (test/helpers/refusing-engine.ts); the Rust cases need the addon and are skipped without it unless
 *    GBRAIN_TEST_RUST_ADDON_REQUIRED=1. The pause release, the quiet-hours defer and the stall count are typed members
 *    every engine serves (releaseClaimForPause, deferClaimForQuietHours, countWaitingJobsForNames), so their cases refuse
 *    that member; on a Rust brain the release and the defer put the claim back as delayed (as
 *    test/engine-parity/jobs-worker-liveness.test.ts pins on every arm). The quiet-hours skip is still raw SQL.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { terminalHookNotifier } from '../../src/core/minions/terminal-hook.ts';
import { jobSpendAuthorization, runWithJobSpend, SpendGroupRefusedError } from '../../src/core/minions/spend-authorization.ts';
import { chatInvocation } from '../../src/core/ai/guarded-generation.ts';
import { invokeAI } from '../../src/core/ai/invocation-guard.ts';
import type { MinionJob, MinionJobContext } from '../../src/core/minions/types.ts';
import { refusingEngine } from '../helpers/refusing-engine.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from '../engine-parity/rust-arm.ts';

let pg: PGLiteEngine;
beforeAll(async () => {
  pg = new PGLiteEngine();
  await pg.connect({ database_url: '' });
  await pg.initSchema();
}, 60_000);
afterAll(async () => { await pg.disconnect(); });

const rustRun = existsSync(rustArmAddonPath()) || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' ? test : test.skip;

function hookScript(): { dir: string; argv: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-refusal-hook-'));
  const script = join(dir, 'hook.sh');
  writeFileSync(script, '#!/bin/sh\nprintf "%s|%s" "$GBRAIN_JOB_ID" "$GBRAIN_JOB_STATUS" > "$1/$GBRAIN_JOB_ID.env"\n', { mode: 0o755 });
  return { dir, argv: ['/bin/sh', script, dir] };
}

/** Runs one `noop` job to completion on a worker whose engine is `engine`, with the terminal hook notifier attached. */
async function runHookedJob(engine: BrainEngine, workerEngine: BrainEngine, argv: string[]): Promise<number> {
  const queue = new MinionQueue(engine);
  const job = await queue.add('hook-ok', { n: 1 });
  const notifier = terminalHookNotifier(workerEngine, { argv, timeout_ms: 5_000 });
  const worker = new MinionWorker(workerEngine, { pollInterval: 50, healthCheckInterval: 0, onJobSettled: notifier.onJobSettled });
  worker.register('hook-ok', async () => ({ fine: true }));
  const running = worker.start();
  for (let i = 0; i < 200 && (await queue.getJob(job.id))?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
  worker.stop();
  await running;
  await notifier.drain();
  return job.id;
}

describe('worker refusal-swallow sites', () => {
  test('S8 terminalHookNotifier: the settled job is read through the typed getJob, so the hook runs on an engine whose raw SQL refuses', async () => {
    const { dir, argv } = hookScript();
    const id = await runHookedJob(pg, refusingEngine(pg, { needle: 'FROM minion_jobs WHERE id = $1' }), argv);
    expect(readFileSync(join(dir, `${id}.env`), 'utf8')).toBe(`${id}|completed`);
    expect(readdirSync(dir).filter((f) => f.endsWith('.env'))).toHaveLength(1);
  });

  rustRun('S8 on a Rust brain: the terminal hook runs for a job the worker completed', async () => {
    const { engine, dir: brainDir } = await openRustBrain();
    try {
      const { dir, argv } = hookScript();
      const id = await runHookedJob(engine as unknown as BrainEngine, engine as unknown as BrainEngine, argv);
      expect(readFileSync(join(dir, `${id}.env`), 'utf8')).toBe(`${id}|completed`);
    } finally {
      await engine.disconnect();
      removeBrainDir(brainDir);
    }
  }, 30_000);

  test('S7 recordRefusal: a spend refusal still ends the job with the refusal when the engine cannot record its result row, and says so', async () => {
    await pg.executeRaw('DELETE FROM minion_jobs');
    const record = jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 1, cap_source: 'user', via: 'yes' },
      { command: 'book-mirror', est_usd: 0.5, of: 1, argv: ['gbrain', 'book-mirror', '--slug', 'a-book'] });
    await new MinionQueue(pg).add('subagent', { prompt: 'x' }, {}, { allowProtectedSubmit: true, spendAuthorization: record });
    const job = (await new MinionQueue(pg).claim('tok-s7', 60_000, 'default', ['subagent']))!;
    const ctx = { id: job.id, name: job.name, data: job.data, attempts_made: 0 } as unknown as MinionJobContext;
    const engine = refusingEngine(pg, { needle: 'UPDATE minion_jobs SET result' });
    const lines: string[] = [];
    const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }) as never);
    try {
      const refusal = await runWithJobSpend(engine, job as MinionJob, ctx, async () => invokeAI(chatInvocation('test-unpriced', 'openrouter:example/unpriced-model', 1000),
        async () => 'unexpected', () => null)).catch((e) => e as Error);
      expect(refusal).toBeInstanceOf(SpendGroupRefusedError);
    } finally { err.mockRestore(); }
    expect(lines.join('\n')).toContain('cannot record the spend refusal');
    expect(lines.join('\n')).toContain('does not support executeRaw');
  });

  /** A claimed `noop` job on `engine`, and a worker over `workerEngine` to call its private release paths on. */
  async function claimedJob(engine: BrainEngine): Promise<{ job: MinionJob; token: string }> {
    const queue = new MinionQueue(engine);
    await queue.add('noop', {}, {});
    const token = `tok-${Math.random().toString(36).slice(2)}`;
    const job = await queue.claim(token, 60_000, 'default', ['noop']);
    if (!job) throw new Error('nothing claimed');
    return { job, token };
  }
  const releases = (worker: MinionWorker) => worker as unknown as {
    releaseClaimForPause(job: MinionJob, token: string): Promise<void>;
    handleQuietHoursDefer(job: MinionJob, token: string, verdict: 'skip' | 'defer'): Promise<void>;
  };

  test('S10 releaseClaimForPause: a capability refusal surfaces (the claim is not left to expire quietly); another error is logged and the worker goes on', async () => {
    await pg.executeRaw('DELETE FROM minion_jobs');
    const { job, token } = await claimedJob(pg);
    await expect(releases(new MinionWorker(refusingEngine(pg, { members: ['releaseClaimForPause'] }), { healthCheckInterval: 0 })).releaseClaimForPause(job, token))
      .rejects.toMatchObject({ code: 'engine_capability_missing' });
    const err = spyOn(console, 'error').mockImplementation((() => {}) as never);
    try {
      await releases(new MinionWorker(refusingEngine(pg, { error: () => new Error('connection reset') }), { healthCheckInterval: 0 })).releaseClaimForPause(job, token);
    } finally { err.mockRestore(); }
  });

  rustRun('S10 on a Rust brain: releasing a claim for the pause marker puts the claim back as delayed instead of leaving it to expire', async () => {
    const { engine, dir } = await openRustBrain();
    try {
      const e = engine as unknown as BrainEngine;
      const { job, token } = await claimedJob(e);
      await releases(new MinionWorker(e, { healthCheckInterval: 0 })).releaseClaimForPause(job, token);
      const after = await e.getJob(job.id);
      // The same release jobs-worker-liveness compares with PGLite: delayed, the lock cleared.
      expect({ status: after?.status, lock: after?.lock_token ?? null }).toEqual({ status: 'delayed', lock: null });
    } finally {
      await engine.disconnect();
      removeBrainDir(dir);
    }
  });

  test('S11 handleQuietHoursDefer: a capability refusal surfaces for a defer and for a skip; another error is logged and the worker goes on', async () => {
    for (const verdict of ['defer', 'skip'] as const) {
      await pg.executeRaw('DELETE FROM minion_jobs');
      const { job, token } = await claimedJob(pg);
      // The defer is the typed deferClaimForQuietHours; the skip is still raw SQL, which refusingEngine(pg) refuses.
      const refusing = verdict === 'defer' ? refusingEngine(pg, { members: ['deferClaimForQuietHours'] }) : refusingEngine(pg);
      await expect(releases(new MinionWorker(refusing, { healthCheckInterval: 0 })).handleQuietHoursDefer(job, token, verdict))
        .rejects.toMatchObject({ code: 'engine_capability_missing' });
      const err = spyOn(console, 'error').mockImplementation((() => {}) as never);
      try {
        await releases(new MinionWorker(refusingEngine(pg, { error: () => new Error('connection reset') }), { healthCheckInterval: 0 })).handleQuietHoursDefer(job, token, verdict);
      } finally { err.mockRestore(); }
    }
  });

  rustRun('S11 on a Rust brain: a quiet-hours defer of a claimed job puts the claim back as delayed instead of leaving it to expire', async () => {
    const { engine, dir } = await openRustBrain();
    try {
      const e = engine as unknown as BrainEngine;
      const { job, token } = await claimedJob(e);
      await releases(new MinionWorker(e, { healthCheckInterval: 0 })).handleQuietHoursDefer(job, token, 'defer');
      const after = await e.getJob(job.id);
      // The same defer jobs-worker-liveness compares with PGLite: delayed, the lock cleared.
      expect({ status: after?.status, lock: after?.lock_token ?? null }).toEqual({ status: 'delayed', lock: null });
    } finally {
      await engine.disconnect();
      removeBrainDir(dir);
    }
  });

  /** Starts a worker with a 50 ms health check, runs it `ms`, and returns the 'unhealthy' payloads it emitted. */
  async function unhealthyAfter(engine: BrainEngine, ms: number): Promise<Array<{ reason: string; message?: string }>> {
    const worker = new MinionWorker(engine, { pollInterval: 25, healthCheckInterval: 50, dbFailExitAfter: 1, dbProbeTimeoutMs: 1000, stallWarnAfterMs: 20, stallExitAfterMs: 600_000 });
    const events: Array<{ reason: string; message?: string }> = [];
    worker.on('unhealthy', (info) => { events.push(info as { reason: string; message?: string }); });
    worker.register('noop', async () => ({}));
    const running = worker.start();
    await new Promise((r) => setTimeout(r, ms));
    worker.stop();
    await running;
    return events;
  }

  test('S9 worker stall check: a capability refusal on the waiting-job count stops the worker as unhealthy instead of skipping the check', async () => {
    const events = await unhealthyAfter(refusingEngine(pg, { members: ['countWaitingJobsForNames'] }), 800);
    expect(events.map((e) => e.reason)).toEqual(['db_dead']);
    expect(events[0]!.message).toContain('does not support executeRaw');
  }, 20_000);

  rustRun('S9 on a Rust brain: the health check reaches the stall count, which the store answers, so an idle worker stays alive and sends no raw SQL', async () => {
    const { engine, dir } = await openRustBrain();
    try {
      const statements: string[] = [];
      let stallCounts = 0;
      const e = new Proxy(engine as unknown as BrainEngine, {
        get(target, property) {
          if (property === 'executeRaw') return async (sql: string) => { statements.push(sql); return (target.executeRaw as (s: string) => Promise<unknown>)(sql); };
          // The real member, counted once it has answered: the proof the health check reached the stall count.
          if (property === 'countWaitingJobsForNames') {
            return async (queue: string, names: readonly string[]) => {
              const n = await target.countWaitingJobsForNames(queue, names);
              stallCounts++;
              return n;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      // A waiting job of a name the worker does not handle makes the stall count run (and answer 0).
      await new MinionQueue(engine as unknown as BrainEngine).add('not-handled-here', { n: 1 });
      const worker = new MinionWorker(e, { pollInterval: 25, healthCheckInterval: 50, dbFailExitAfter: 1, dbProbeTimeoutMs: 1000, stallWarnAfterMs: 20, stallExitAfterMs: 600_000 });
      const events: Array<{ reason: string; message?: string }> = [];
      let ready = false;
      worker.on('unhealthy', (info) => { events.push(info as { reason: string; message?: string }); });
      worker.on('ready', () => { ready = true; });
      worker.register('noop', async () => ({}));
      const until = async (done: () => boolean, ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 10));
        return done();
      };
      const running = worker.start();
      try {
        const isReady = await until(() => ready || events.length > 0, 10_000);
        // Bounded wait for the stall count to complete twice (a tick later than the first, so the worker survived one).
        const counted = await until(() => stallCounts >= 2 || events.length > 0, 10_000);
        expect({ isReady, counted, stallCountsAtLeastTwo: stallCounts >= 2, unhealthy: events, statements }).toEqual({
          isReady: true, counted: true, stallCountsAtLeastTwo: true, unhealthy: [], statements: [],
        });
      } finally {
        worker.stop();
        await running;
      }
    } finally {
      await engine.disconnect();
      removeBrainDir(dir);
    }
  }, 30_000);
});
