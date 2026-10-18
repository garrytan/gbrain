/**
 * A-30 (GBRA-130): an RSS watchdog drain charges only the job that trips the
 * watchdog while running alone, never the jobs that shared the worker.
 *
 * Protects: with concurrency 2, a job whose memory crosses --max-rss next to
 * an innocent job makes the watchdog drain both, and both go back to the queue
 * with no attempt burned and a persisted watchdog mark (the job's history
 * records it, so the mark survives the worker's exit); a marked job is then
 * claimed only when nothing else runs and nothing else is claimed beside it,
 * so the hog trips alone and is charged (delayed, then dead at max attempts)
 * while the innocent job keeps its attempts and lands on its own run. The
 * kernel OOM variant (the process dies, every lease expires) gets the same
 * attribution: stalled jobs whose worker held others are requeued with the
 * mark and no stall counted, and a marked job's solo stall counts. A lone job
 * that trips the watchdog is charged as before. A run-scoped failure while
 * releasing a co-runner leaves its claim for the stall sweep, unmarked and
 * uncharged.
 * Fails when: the drain aborts every job with reason `watchdog` and the
 * catch charges each one (`attempts_made` + 1 for the innocent job), a marked
 * job is claimed beside another job, or the stall sweep counts a stall against
 * every job of a dead worker.
 * Seams: `getRss` (the worker option the watchdog tests use) reports the
 * hog's memory; the run case wraps the worker's queue method. PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue, WATCHDOG_SUSPECT_MARK } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import type { MinionJob, MinionJobContext } from '../../src/core/minions/types.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { expectItemFailure, expectUnitNotAborted, pathologicalArms, runScopedErrors } from './harness.ts';

const MB = 1024 * 1024;

interface Run { worker: MinionWorker; started: Set<string>; maxConcurrent: number }

/** A worker whose RSS reads over the cap while `hogging()` is true; handlers wait for their abort unless `finish` lets them return. */
function makeWorker(engine: BrainEngine, hogging: () => boolean, finish: Set<string>): Run {
  const worker = new MinionWorker(engine, { concurrency: 2, maxRssMb: 100, getRss: () => (hogging() ? 500 : 10) * MB, rssCheckInterval: 20,
    pollInterval: 10, lockDuration: 60_000, healthCheckInterval: 0, stalledInterval: 600_000 });
  const run: Run = { worker, started: new Set(), maxConcurrent: 0 };
  let running = 0;
  const handler = (name: string) => async (ctx: MinionJobContext) => {
    run.started.add(name);
    running++;
    run.maxConcurrent = Math.max(run.maxConcurrent, running);
    try {
      if (finish.has(name)) return { ok: true };
      await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error(`${name} stopped`)), { once: true }));
    } finally { running--; }
  };
  for (const name of ['hog', 'sleeper', 'solo']) worker.register(name, handler(name));
  return run;
}

const row = async (queue: MinionQueue, id: number) => {
  const job = (await queue.getJob(id)) as MinionJob;
  return { status: job.status, attempts: job.attempts_made, error: job.error_text, marked: job.stacktrace.includes(WATCHDOG_SUSPECT_MARK) };
};

async function waitFor(check: () => Promise<boolean> | boolean, what: string) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await Bun.sleep(10); }
  throw new Error(`timed out waiting for ${what}`);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-30 watchdog attribution (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });

    test('A-30 item: a drain shared with an innocent job charges neither; the marked hog re-runs alone and is charged; the innocent job lands', async () => {
      await engine.executeRaw('DELETE FROM minion_jobs');
      const queue = new MinionQueue(engine);
      const hog = await queue.add('hog', {}, { max_attempts: 2, backoff_delay: 60_000 }, { allowProtectedSubmit: true });
      const sleeper = await queue.add('sleeper', {}, { max_attempts: 2, backoff_delay: 60_000 }, { allowProtectedSubmit: true });

      let hogging = false;
      const first = makeWorker(engine, () => hogging, new Set());
      const running = first.worker.start();
      await waitFor(() => first.started.has('hog') && first.started.has('sleeper'), 'both jobs running');
      hogging = true;
      await expectUnitNotAborted(() => running);
      expect(first.worker.rssWatchdogTriggered).toBe(true);
      expect(await row(queue, sleeper.id)).toMatchObject({ status: 'waiting', attempts: 0, marked: true });
      expect(await row(queue, hog.id)).toMatchObject({ status: 'waiting', attempts: 0, marked: true });

      hogging = false;
      const second = makeWorker(engine, () => second.started.has('hog') && second.started.size === 1, new Set());
      await expectUnitNotAborted(() => second.worker.start());
      expect([...second.started]).toEqual(['hog']);
      expect(second.maxConcurrent).toBe(1);
      const charged = await row(queue, hog.id);
      expect(charged).toMatchObject({ status: 'delayed', attempts: 1, marked: true });
      expectItemFailure({ key: String(hog.id), code: charged.error ?? undefined }, { key: String(hog.id), code: 'aborted: watchdog' });
      expect(await row(queue, sleeper.id)).toMatchObject({ status: 'waiting', attempts: 0 });

      const third = makeWorker(engine, () => false, new Set(['sleeper']));
      const done = third.worker.start();
      await waitFor(async () => (await row(queue, sleeper.id)).status === 'completed', 'the innocent job to complete');
      third.worker.stop();
      await done;
      expect(third.maxConcurrent).toBe(1);
      expect(await row(queue, sleeper.id)).toMatchObject({ status: 'completed', attempts: 0 });
    }, 60_000);

    test('A-30 item: a job alone in the worker that trips the watchdog is charged, and at max attempts dead-letters', async () => {
      await engine.executeRaw('DELETE FROM minion_jobs');
      const queue = new MinionQueue(engine);
      const solo = await queue.add('solo', {}, { max_attempts: 1 }, { allowProtectedSubmit: true });
      const run = makeWorker(engine, () => run.started.has('solo'), new Set());
      await expectUnitNotAborted(() => run.worker.start());
      expect(await row(queue, solo.id)).toMatchObject({ status: 'dead', attempts: 1, error: 'aborted: watchdog' });
    }, 60_000);

    test('A-30 item: the stall sweep requeues the jobs of a dead worker that held several with the mark and no stall counted; a marked solo stall counts', async () => {
      await engine.executeRaw('DELETE FROM minion_jobs');
      const queue = new MinionQueue(engine);
      const ids: number[] = [];
      for (const name of ['hog', 'sleeper', 'solo', 'solo']) ids.push((await queue.add(name, {}, { max_attempts: 3 }, { allowProtectedSubmit: true })).id);
      const [a, b, lone, marked] = ids as [number, number, number, number];
      const stall = (id: number, token: string, expiredMs: number) => engine.executeRaw(
        `UPDATE minion_jobs SET status = 'active', lock_token = $2, lock_until = now() - ($3::double precision * interval '1 millisecond'), started_at = now(), claim_generation = claim_generation + 1 WHERE id = $1`, [id, token, expiredMs]);
      await stall(a, 'worker-a:1', 60_000);
      await stall(b, 'worker-a:2', 1_000);
      await stall(lone, 'worker-b:1', 60_000);
      await engine.executeRaw(`UPDATE minion_jobs SET stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($2::text) WHERE id = $1`, [marked, WATCHDOG_SUSPECT_MARK]);
      await stall(marked, 'worker-c:1', 60_000);
      await queue.handleStalled(30_000);
      expect(await row(queue, a)).toMatchObject({ status: 'waiting', marked: true });
      expect(await row(queue, b)).toMatchObject({ status: 'active' });
      await queue.handleStalled(0);
      const counters = await engine.executeRaw<{ id: number; stalled_counter: number }>('SELECT id, stalled_counter FROM minion_jobs ORDER BY id');
      expect(counters.map(r => [Number(r.id), Number(r.stalled_counter)])).toEqual([[a, 0], [b, 0], [lone, 1], [marked, 1]]);
      expect(await row(queue, b)).toMatchObject({ status: 'waiting', marked: true });
      expect(await row(queue, lone)).toMatchObject({ status: 'waiting', marked: false });
    }, 60_000);

    for (const injected of runScopedErrors().filter(e => e.name === 'connection lost' || e.name === 'failed transaction (25P02)')) {
      test(`A-30 run: a run-scoped error (${injected.name}) releasing a co-runner leaves its claim to the stall sweep, unmarked and uncharged`, async () => {
        await engine.executeRaw('DELETE FROM minion_jobs');
        const queue = new MinionQueue(engine);
        const hog = await queue.add('hog', {}, { max_attempts: 2 }, { allowProtectedSubmit: true });
        const sleeper = await queue.add('sleeper', {}, { max_attempts: 2 }, { allowProtectedSubmit: true });
        let hogging = false;
        const run = makeWorker(engine, () => hogging, new Set());
        const internals = run.worker as unknown as { queue: MinionQueue };
        internals.queue.releaseWatchdogClaim = (async () => { throw injected.error(); }) as MinionQueue['releaseWatchdogClaim'];
        const running = run.worker.start();
        await waitFor(() => run.started.has('hog') && run.started.has('sleeper'), 'both jobs running');
        hogging = true;
        await expectUnitNotAborted(() => running);
        for (const id of [hog.id, sleeper.id]) expect(await row(queue, id)).toMatchObject({ status: 'active', attempts: 0, marked: false });
      }, 60_000);
    }
  });
}
