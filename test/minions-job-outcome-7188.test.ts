/**
 * #7188: a job whose handler result reports a failed phase, a failed or blocked status, or unfinished work no longer
 * ends a plain `completed`. A failure ends `failed` with the phase and reason (result kept, marked `job_outcome`
 * `phase_failed` with `failed_phase`, or `failed`); unfinished work
 * completes with `job_outcome: 'partial'` on its result (the queue has no partial status); a clean result or a
 * deliberate skip completes as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { jobResultOutcome } from '../src/core/minions/job-outcome.ts';
import { waitFor } from './helpers/wait-for.ts';

const failedSyncPhase = {
  phase: 'sync', status: 'fail', duration_ms: 1, summary: 'sync failed',
  error: { class: 'DatabaseConnection', code: '25006', message: 'cannot execute INSERT in a read-only transaction' },
};
const cycleResult = (phases: unknown[], status: string) => ({ partial: status !== 'ok', status, report: { status, phases } });

describe('#7188 jobResultOutcome', () => {
  test('a failed phase fails the job and names the phase, code and message', () => {
    expect(jobResultOutcome(cycleResult([{ phase: 'lint', status: 'ok' }, failedSyncPhase], 'partial'))).toEqual({
      outcome: 'failed', phase: 'sync', reason: 'phase sync failed (25006): cannot execute INSERT in a read-only transaction',
    });
  });

  test('an autopilot-global-maintenance result whose synthesize phase failed fails the job', () => {
    const result = {
      partial: true, status: 'partial',
      report: { status: 'partial', phases: [{ phase: 'lint', status: 'ok' }, { phase: 'synthesize', status: 'fail', duration_ms: 3, summary: 'error: synthesis failed', code: 'SYNTH_PHASE_FAIL', details: {} }] },
      phase_streaks: [{ phase: 'synthesize', count: 1, fix: 'gbrain dream --phase synthesize' }],
    };
    expect(jobResultOutcome(result)).toEqual({ outcome: 'failed', phase: 'synthesize', reason: 'phase synthesize failed (SYNTH_PHASE_FAIL): error: synthesis failed' });
  });

  test('a failed or blocked status fails the job', () => {
    expect(jobResultOutcome({ status: 'blocked_by_failures', reason: 'held_files' })).toEqual({ outcome: 'failed', reason: 'result status blocked_by_failures (held_files)' });
    expect(jobResultOutcome({ partial: true, status: 'failed', report: { status: 'failed', phases: [] } }).outcome).toBe('failed');
  });

  test('unfinished work without a failure is partial; warnings, skips and plain results are clean', () => {
    expect(jobResultOutcome({ status: 'partial', reason: 'timeout' })).toEqual({ outcome: 'partial' });
    expect(jobResultOutcome(cycleResult([{ phase: 'embed', status: 'warn' }], 'partial')).outcome).toBe('partial');
    expect(jobResultOutcome(cycleResult([{ phase: 'embed', status: 'warn' }, { phase: 'lint', status: 'ok' }], 'ok')).outcome).toBe('clean');
    expect(jobResultOutcome({ partial: false, status: 'skipped', report: { reason: 'source_in_cooldown' } }).outcome).toBe('clean');
    expect(jobResultOutcome({ skipped: true, reason: 'sync_in_progress' }).outcome).toBe('clean');
    expect(jobResultOutcome({ processed: 3 }).outcome).toBe('clean');
    expect(jobResultOutcome(undefined).outcome).toBe('clean');
  });
});

describe('#7188 worker records the outcome', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

  async function runOne(name: string, result: unknown, opts: Record<string, unknown> = {}) {
    const job = await queue.add(name, {}, { max_attempts: 3, ...opts });
    const worker = new MinionWorker(engine, { pollInterval: 25 });
    worker.register(name, async () => result as Record<string, unknown>);
    const running = worker.start();
    try {
      await waitFor(async () => ['completed', 'failed', 'dead'].includes((await queue.getJob(job.id))?.status ?? ''), { timeoutMs: 10_000, label: `${name} terminal` });
    } finally {
      worker.stop();
      await running;
    }
    return (await queue.getJob(job.id))!;
  }

  test('a result with a failed phase ends failed, once, with the reason and the result kept', async () => {
    const result = cycleResult([failedSyncPhase], 'failed');
    const job = await runOne('phase-fail', result);
    expect(job.status).toBe('failed');
    expect(job.attempts_made).toBe(1);
    expect(job.error_text).toBe('phase sync failed (25006): cannot execute INSERT in a read-only transaction');
    expect(job.result).toEqual({ ...result, job_outcome: 'phase_failed', failed_phase: 'sync' });
    expect(job.finished_at).not.toBeNull();
  });

  test('a partial result completes with job_outcome partial', async () => {
    const job = await runOne('drain-partial', { status: 'partial', reason: 'timeout', filesImported: 2 });
    expect(job.status).toBe('completed');
    expect(job.result).toEqual({ status: 'partial', reason: 'timeout', filesImported: 2, job_outcome: 'partial' });
  });

  test('a clean result and a skip complete unchanged', async () => {
    expect(await runOne('clean', { processed: true })).toMatchObject({ status: 'completed', result: { processed: true } });
    expect(await runOne('skip', { skipped: true, reason: 'sync_in_progress' })).toMatchObject({ status: 'completed', result: { skipped: true, reason: 'sync_in_progress' } });
  });

  test('a failed child under fail_parent fails its parent', async () => {
    const parent = await queue.add('outcome-parent', {}, { max_attempts: 1 });
    const child = await queue.add('outcome-child', {}, { parent_job_id: parent.id, on_child_fail: 'fail_parent', max_attempts: 3 });
    expect((await queue.getJob(parent.id))!.status).toBe('waiting-children');
    const worker = new MinionWorker(engine, { pollInterval: 25 });
    worker.register('outcome-child', async () => ({ status: 'blocked_by_failures' }));
    worker.register('outcome-parent', async () => ({ ok: true }));
    const running = worker.start();
    try {
      await waitFor(async () => (await queue.getJob(parent.id))?.status === 'failed', { timeoutMs: 10_000, label: 'parent failed' });
    } finally {
      worker.stop();
      await running;
    }
    expect((await queue.getJob(child.id))!.status).toBe('failed');
    expect((await queue.getJob(parent.id))!.error_text).toBe(`child job ${child.id} failed: result status blocked_by_failures`);
  });
});
