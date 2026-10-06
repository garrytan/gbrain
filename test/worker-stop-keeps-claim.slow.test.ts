/**
 * #5062 follow-up: the 30 s shutdown drain hands still-running claims back to
 * the queue only when shutdown was requested (signal, `jobs work` signal
 * owner, watchdog), because the process is about to exit. A cooperative
 * `worker.stop()` (inline remediation, `jobs submit --follow`) keeps the
 * process and the handler alive, so its claim must stay `active` and the job
 * must complete once, not be re-queued and run again.
 * Slow lane: each case waits out the real 30 s drain; both run concurrently.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';

const engines: PGLiteEngine[] = [];
beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    engines.push(engine);
  }
}, 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); });

async function runCase(engine: PGLiteEngine, mode: 'stop' | 'shutdown') {
  {
    const queue = new MinionQueue(engine);
    const worker = new MinionWorker(engine, { pollInterval: 25, lockDuration: 60_000, healthCheckInterval: 0 });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let runs = 0;
    worker.register('slow-probe', async () => { runs++; await gate; return 'ran'; });
    const job = await queue.add('slow-probe', {}, {}, { allowProtectedSubmit: true });
    const running = worker.start();
    for (let i = 0; i < 400 && (await queue.getJob(job.id))?.status !== 'active'; i++) await new Promise(r => setTimeout(r, 25));
    if (mode === 'stop') worker.stop();
    else worker.requestShutdown();
    await running;
    const afterDrain = await queue.getJob(job.id);
    finish();
    let final = afterDrain;
    for (let i = 0; i < 200 && mode === 'stop' && final?.status === 'active'; i++) {
      await new Promise(r => setTimeout(r, 25));
      final = await queue.getJob(job.id);
    }
    return { afterDrain, final, drainForced: worker.drainForced, runs };
  }
}

test('stop() keeps a running claim through the drain and the job completes once; requestShutdown() hands it back', async () => {
  const [stopped, shutdown] = await Promise.all([runCase(engines[0]!, 'stop'), runCase(engines[1]!, 'shutdown')]);
  expect(stopped.afterDrain?.status).toBe('active');
  expect(stopped.drainForced).toBe(false);
  expect(stopped.final?.status).toBe('completed');
  expect(stopped.runs).toBe(1);
  expect(shutdown.afterDrain?.status).toBe('waiting');
  expect(shutdown.afterDrain?.error_text).toBe('worker_shutdown');
  expect(shutdown.drainForced).toBe(true);
}, 90_000);
