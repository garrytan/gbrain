import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker, type UnhealthyReason } from '../src/core/minions/worker.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

test.each([
  { name: 'typed primary renewal', faultAt: 1, typed: true, network: false },
  { name: 'typed deadline verification', faultAt: 2, typed: true, network: false },
  { name: 'same-text ordinary renewal failure', faultAt: 1, typed: false, network: false },
  { name: 'ordinary network renewal failure', faultAt: 1, typed: false, network: true },
])('$name preserves configuration provenance and execution ownership', async ({ faultAt, typed, network }) => {
  const job = await queue.add('fixture', {});
  const next = await queue.add('fixture', {});
  const worker = new MinionWorker(engine, { pollInterval: 5, healthCheckInterval: 0, stalledInterval: 60_000, lockDuration: 200 });
  const internals = worker as unknown as { queue: MinionQueue; running: boolean };
  const error = typed
    ? new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture cancellation unavailable')
    : new Error(network ? 'Connection terminated' : 'fixture cancellation unavailable');
  const originalRenew = internals.queue.renewLock.bind(internals.queue);
  const originalClaim = internals.queue.claim.bind(internals.queue);
  let renewals = 0;
  let claims = 0;
  let ready = false;
  let handlerSignal: AbortSignal | undefined;
  let settle!: () => void;
  const stopped = new Promise<void>(resolve => { settle = resolve; });
  const events: UnhealthyReason[] = [];
  internals.queue.claim = async (...args) => { claims++; return originalClaim(...args); };
  internals.queue.renewLock = async (...args) => {
    renewals++;
    if (renewals === faultAt) throw error;
    if (renewals < faultAt) throw new Error('fixture temporary renewal failure');
    return originalRenew(...args);
  };
  worker.on('ready', () => { ready = true; });
  worker.on('unhealthy', event => { events.push(event); });
  worker.register('fixture', async context => {
    handlerSignal = context.signal;
    await stopped;
    if (context.signal.aborted) throw context.signal.reason;
    return { fixture: true };
  });
  const run = worker.start();
  try {
    const deadline = performance.now() + 1_500;
    while (performance.now() < deadline && (typed ? !worker.configurationError : renewals <= faultAt)) await Bun.sleep(5);
    expect(ready).toBe(true);
    expect((await engine.executeRaw<{ n: number }>('SELECT 1::int AS n'))[0].n).toBe(1);
    expect((await queue.getJob(next.id))?.status).toBe('waiting');
    if (error instanceof LocalConfigurationError) {
      expect(worker.configurationError).toBe(error);
      expect(events).toEqual([{ reason: 'client_misconfigured', error }]);
      expect(internals.running).toBe(false);
      expect(handlerSignal?.reason).toBe(error);
      expect(renewals).toBe(faultAt);
      expect((await queue.getJob(job.id))?.status).toBe('active');
      expect(worker.configurationReleaseResults).toHaveLength(0);
      settle();
      await run;
      expect((await queue.getJob(job.id))?.status).toBe('delayed');
      expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
      expect((await queue.getJob(job.id))?.stalled_counter).toBe(0);
      expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
      expect(claims).toBe(1);
    } else {
      expect(worker.configurationError).toBeNull();
      expect(events).toEqual([]);
      expect(internals.running).toBe(true);
      expect(handlerSignal?.aborted).toBe(false);
      expect(renewals).toBeGreaterThan(faultAt);
    }
  } finally {
    worker.stop();
    settle();
    await run;
  }
}, 10_000);
