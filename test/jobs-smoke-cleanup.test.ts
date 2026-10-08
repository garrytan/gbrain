/**
 * `gbrain jobs smoke` must not leave a job it created on the private `smoke`
 * queue. Production workers never serve that queue, so a leftover job waits
 * forever and trips oldest-waiting-job health checks. Each case also seeds
 * jobs the run did not create and pins that they survive: cleanup owns
 * exactly the run's job ids, never the queue.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { runJobsSmoke } from '../src/commands/jobs/smoke.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function jobRows(): Promise<Array<{ id: number; queue: string; status: string }>> {
  return engine.executeRaw<{ id: number; queue: string; status: string }>(
    'SELECT id, queue, status FROM minion_jobs ORDER BY id',
  );
}

/**
 * Jobs the smoke run did not create: a delayed `smoke` job (the run's own
 * worker cannot claim it, so only cleanup could remove it) and a default-queue job.
 */
async function seedUnrelated(): Promise<Array<{ id: number; queue: string; status: string }>> {
  await queue.add('noop', {}, { queue: 'smoke', max_attempts: 1, delay: 3_600_000 });
  await queue.add('noop', {}, { queue: 'default', max_attempts: 1 });
  return jobRows();
}

/** Run the smoke with process.exit and console captured; resolves to the exit code. */
async function runSmoke(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stderr: string }> {
  const stderr: string[] = [];
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never);
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runJobsSmoke({ args, engine, engineOrNull: engine, queue }, opts);
    throw new Error('expected process.exit');
  } catch (e) {
    const m = /^EXIT:(\d+)$/.exec((e as Error).message);
    if (!m) throw e;
    return { code: Number(m[1]), stderr: stderr.join('\n') };
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  }
}

describe('gbrain jobs smoke cleanup', () => {
  test('timeout: a probe no worker claims is cancelled and removed before exit 1', async () => {
    const unrelated = await seedUnrelated();
    const startSpy = spyOn(MinionWorker.prototype, 'start').mockImplementation(async () => {});
    let result: { code: number; stderr: string };
    try {
      result = await runSmoke([], { timeoutMs: 300 });
    } finally {
      startSpy.mockRestore();
    }
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('status: waiting');
    expect(await jobRows()).toEqual(unrelated);
  }, 30_000);

  test('pass: exit 0 and the run leaves no job of its own', async () => {
    const unrelated = await seedUnrelated();
    expect((await runSmoke([])).code).toBe(0);
    expect(await jobRows()).toEqual(unrelated);
  }, 30_000);

  test('throw mid-run: the error propagates and the live probe is still discarded', async () => {
    const unrelated = await seedUnrelated();
    const startSpy = spyOn(MinionWorker.prototype, 'start').mockImplementation(async () => {});
    const getJobSpy = spyOn(queue, 'getJob').mockImplementationOnce(async () => {
      throw new Error('getJob unavailable');
    });
    try {
      await expect(runSmoke([], { timeoutMs: 300 })).rejects.toThrow('getJob unavailable');
    } finally {
      getJobSpy.mockRestore();
      startSpy.mockRestore();
    }
    expect(await jobRows()).toEqual(unrelated);
  }, 30_000);

  test('--sigkill-rescue: the stalled probe is rescued (exit 0), and neither probe nor rescue job is left', async () => {
    const unrelated = await seedUnrelated();
    // W4.9: the rescue job enters `active` through queue.claim, so the queue
    // protocol trigger admits it and the #219 rescue verdict is reached.
    const result = await runSmoke(['--sigkill-rescue']);
    expect(result.stderr).not.toContain('SMOKE FAIL');
    expect(result.code).toBe(0);
    expect(await jobRows()).toEqual(unrelated);
  }, 30_000);

  test('--wedge-rescue: the wall-clock sweep evicts the wedged probe (exit 0), and nothing is left', async () => {
    const unrelated = await seedUnrelated();
    const result = await runSmoke(['--wedge-rescue']);
    expect(result.stderr).not.toContain('SMOKE FAIL');
    expect(result.code).toBe(0);
    expect(await jobRows()).toEqual(unrelated);
  }, 30_000);

  test('both rescue cases in one run pass', async () => {
    const unrelated = await seedUnrelated();
    expect((await runSmoke(['--sigkill-rescue', '--wedge-rescue'])).code).toBe(0);
    expect(await jobRows()).toEqual(unrelated);
  }, 30_000);
});
