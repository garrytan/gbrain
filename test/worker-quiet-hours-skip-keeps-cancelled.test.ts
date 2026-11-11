/**
 * Quiet-hours skip fallback: when MinionQueue.cancelJob throws, the worker's
 * direct UPDATE must not touch a job that is already cancelled. Otherwise an
 * operator's cancel reason is overwritten with 'skipped_quiet_hours'.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';

describe('quiet-hours skip fallback', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  test('a job already cancelled keeps its cancel reason when cancelJob throws', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('quiet-hours-probe', {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'cancelled', error_text = 'cancelled by operator' WHERE id = $1`,
      [job.id],
    );
    const worker = new MinionWorker(engine, { concurrency: 1 });
    const internals = worker as unknown as {
      queue: MinionQueue;
      handleQuietHoursDefer(job: unknown, lockToken: string, verdict: 'skip' | 'defer'): Promise<void>;
    };
    internals.queue.cancelJob = async () => { throw new Error('transient cancel failure'); };
    const log = console.log;
    console.log = () => {};
    try {
      await internals.handleQuietHoursDefer(job, 'no-lock', 'skip');
    } finally {
      console.log = log;
    }
    const [row] = await engine.executeRaw<{ status: string; error_text: string | null }>(
      'SELECT status, error_text FROM minion_jobs WHERE id = $1', [job.id],
    );
    expect(row!.status).toBe('cancelled');
    expect(row!.error_text).toBe('cancelled by operator');
  });
});
