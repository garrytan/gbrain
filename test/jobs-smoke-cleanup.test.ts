/**
 * `gbrain jobs smoke` must not leave its probe job (or a rescue-case job)
 * non-terminal on the private `smoke` queue. Production workers never serve
 * that queue, so a leftover job waits forever and trips oldest-waiting-job
 * health checks.
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

async function smokeQueueRows(): Promise<Array<{ id: number; status: string }>> {
  return engine.executeRaw<{ id: number; status: string }>(
    `SELECT id, status FROM minion_jobs WHERE queue = 'smoke' ORDER BY id`,
  );
}

/** Run the smoke with process.exit and console captured; returns the exit code. */
async function runSmoke(args: string[], opts: { timeoutMs?: number } = {}): Promise<number> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never);
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runJobsSmoke({ args, engine, engineOrNull: engine, queue }, opts);
    throw new Error('expected process.exit');
  } catch (e) {
    const m = /^EXIT:(\d+)$/.exec((e as Error).message);
    if (!m) throw e;
    return Number(m[1]);
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  }
}

describe('gbrain jobs smoke cleanup', () => {
  test('a probe the worker never claims is removed before exiting 1', async () => {
    // A worker that never claims: the probe stays `waiting` until the timeout.
    const startSpy = spyOn(MinionWorker.prototype, 'start').mockImplementation(async () => {});
    try {
      const code = await runSmoke([], { timeoutMs: 300 });
      expect(code).toBe(1);
    } finally {
      startSpy.mockRestore();
    }
    expect(await smokeQueueRows()).toEqual([]);
  }, 30_000);

  test('a passing smoke leaves no job on the smoke queue', async () => {
    expect(await runSmoke([])).toBe(0);
    expect(await smokeQueueRows()).toEqual([]);
  }, 30_000);

  test('--sigkill-rescue leaves no rescue job behind, whether the case passes or throws', async () => {
    // The rescued job ends `waiting`, which removeJob (terminal-only) used to
    // skip; and a throw from the forged UPDATE used to strand it as well.
    let outcome: number | 'threw';
    try { outcome = await runSmoke(['--sigkill-rescue']); } catch { outcome = 'threw'; }
    expect(outcome).not.toBe(1);
    expect(await smokeQueueRows()).toEqual([]);
  }, 30_000);
});
