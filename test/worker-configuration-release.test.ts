import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker, type UnhealthyReason } from '../src/core/minions/worker.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { ChildWorkerShutdownError } from '../src/core/minions/child-job-runner.ts';
import { assertWorkerDbReadiness } from '../src/core/minions/db-probe.ts';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function makeWorker() {
  return new MinionWorker(engine, { pollInterval: 5, healthCheckInterval: 0, stalledInterval: 60_000 });
}

function fault() {
  return new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture cancellation unavailable');
}

describe('configuration release ownership and accounting', () => {
  test('confirmed release preserves attempts and stalls and clears ownership', async () => {
    const job = await queue.add('fixture', {});
    await queue.claim('fixture-token', 30_000, 'default', ['fixture']);
    await engine.executeRaw('UPDATE minion_jobs SET stalled_counter = 2 WHERE id = $1', [job.id]);
    const before = await queue.getJob(job.id);
    expect(await queue.releaseConfigurationJob(job.id, 'fixture-token', new AbortController().signal)).toBe('released');
    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('delayed');
    expect(after?.attempts_made).toBe(before?.attempts_made);
    expect(after?.stalled_counter).toBe(2);
    expect(after?.lock_token).toBeNull();
    expect(after?.lock_until).toBeNull();
    expect(after?.delay_until!.getTime()).toBeGreaterThan(Date.now());
    expect(after?.delay_until!.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(await queue.releaseConfigurationJob(job.id, 'fixture-token', new AbortController().signal)).toBe('no_op');
  });

  test('stale tokens and terminal statuses are fenced no-ops', async () => {
    for (const status of ['active', 'cancelled', 'completed'] as const) {
      const job = await queue.add('fixture', {});
      const token = `token-${job.id}`;
      await queue.claim(token, 30_000, 'default', ['fixture']);
      if (status !== 'active') await engine.executeRaw('UPDATE minion_jobs SET status = $1 WHERE id = $2', [status, job.id]);
      const before = await queue.getJob(job.id);
      expect(await queue.releaseConfigurationJob(job.id, status === 'active' ? 'stale-token' : token, new AbortController().signal)).toBe('no_op');
      expect(await queue.getJob(job.id)).toEqual(before);
    }
  });

  test('cancelled SQL and late responses remain explicitly unconfirmed', async () => {
    const response = deferred<Array<{ id: number }>>();
    let seenSignal: AbortSignal | undefined;
    const isolated = new MinionQueue({
      executeRaw: (_sql: string, _params: unknown[], opts: { signal: AbortSignal }) => {
        seenSignal = opts.signal;
        return response.promise;
      },
    } as unknown as BrainEngine);
    const controller = new AbortController();
    const release = isolated.releaseConfigurationJob(1, 'token', controller.signal);
    controller.abort();
    expect(await release).toBe('unconfirmed');
    expect(seenSignal?.aborted).toBe(true);
    response.resolve([{ id: 1 }]);
    expect(await release).toBe('unconfirmed');
  });

  test('database loss reports fallback rather than protected release', async () => {
    const isolated = new MinionQueue({ executeRaw: async () => { throw new Error('fixture unavailable'); } } as unknown as BrainEngine);
    expect(await isolated.releaseConfigurationJob(1, 'token', new AbortController().signal)).toBe('unconfirmed');
  });
});

describe('worker configuration admission and actual execution', () => {
  test('ready fires once only after the final probe, schema and authority checks', async () => {
    const probeEntered = deferred<void>();
    const probeReady = deferred<void>();
    const schemaEntered = deferred<void>();
    const schemaReady = deferred<void>();
    const events: string[] = [];
    let probes = 0;
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (sql.trim() === 'SELECT 1') {
          probes++;
          if (probes === 2) throw new Error('fixture transient second probe');
          if (probes === 3) { probeEntered.resolve(); await probeReady.promise; }
        } else { events.push('authority'); }
        return [];
      },
    } as unknown as BrainEngine;
    await assertWorkerDbReadiness(engine);
    const worker = new MinionWorker(engine, { pollInterval: 1, healthCheckInterval: 0 });
    (worker as unknown as { queue: unknown }).queue = {
      ensureSchema: async () => { schemaEntered.resolve(); await schemaReady.promise; events.push('schema'); },
      promoteDelayed: async () => { events.push('promote'); },
      claim: async () => { events.push('claim'); worker.stop(); return null; },
    };
    worker.register('fixture', async () => {});
    worker.on('ready', () => { events.push('ready'); });
    const run = worker.start();
    await probeEntered.promise;
    expect(events).toEqual([]);
    probeReady.resolve();
    await schemaEntered.promise;
    expect(events).toEqual([]);
    schemaReady.resolve();
    await run;
    expect(events).toEqual(['schema', 'authority', 'ready', 'promote', 'claim']);
    expect(probes).toBe(3);
  });

  test('failed ready publication aborts startup before timers and claims', async () => {
    const statements: string[] = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => { statements.push(sql); return []; },
    } as unknown as BrainEngine;
    const worker = new MinionWorker(engine, { pollInterval: 1, healthCheckInterval: 1, stalledInterval: 1 });
    const events: string[] = [];
    (worker as unknown as { queue: unknown }).queue = {
      ensureSchema: async () => { events.push('schema'); },
      promoteDelayed: async () => { events.push('promote'); },
      claim: async () => { events.push('claim'); return null; },
    };
    worker.register('fixture', async () => {});
    worker.on('ready', () => { throw new Error('fixture status publication failed'); });
    await expect(worker.start()).rejects.toThrow('fixture status publication failed');
    await Bun.sleep(10);
    expect(events).toEqual(['schema']);
    expect(statements).toHaveLength(2);
    expect((worker as unknown as { running: boolean }).running).toBe(false);
  });

  test('Postgres startup faults block before schema recovery, claims, and timers', async () => {
    const error = fault();
    const statements: string[] = [];
    const worker = new MinionWorker({
      kind: 'postgres',
      executeRaw: async (sql: string) => { statements.push(sql); throw error; },
    } as unknown as BrainEngine, { healthCheckInterval: 1, stalledInterval: 1 });
    worker.register('fixture', async () => { throw new Error('handler must not run'); });
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(worker.configurationError).toBe(error);
    expect(statements).toEqual(['SELECT 1']);
  });

  test('Postgres readiness waits before any schema recovery or claims', async () => {
    const ready = deferred<void>();
    const entered = deferred<void>();
    const statements: string[] = [];
    const worker = new MinionWorker({
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        statements.push(sql);
        entered.resolve();
        await ready.promise;
        return [];
      },
    } as unknown as BrainEngine, { healthCheckInterval: 1, stalledInterval: 1 });
    worker.register('fixture', async () => {});
    const run = worker.start();
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(statements).toEqual(['SELECT 1']);
    worker.stop();
    ready.resolve();
    await run;
    expect(statements).toEqual(['SELECT 1']);
  });

  test('transient startup failure retries readiness before admitting work', async () => {
    const events: string[] = [];
    let probes = 0;
    const worker = new MinionWorker({
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (sql.trim() === 'SELECT 1') {
          events.push('probe');
          if (++probes === 1) throw new Error('fixture connection refused');
        }
        return [];
      },
    } as unknown as BrainEngine, { pollInterval: 1, healthCheckInterval: 0 });
    (worker as unknown as { queue: unknown }).queue = {
      ensureSchema: async () => { events.push('schema'); },
      promoteDelayed: async () => { events.push('promote'); },
      claim: async () => { events.push('claim'); worker.stop(); return null; },
    };
    worker.register('fixture', async () => {});
    await worker.start();
    expect(events).toEqual(['probe', 'probe', 'schema', 'promote', 'claim']);
    expect(worker.configurationError).toBeNull();
  });

  test('periodic typed faults bypass the ordinary database failure counter', async () => {
    const executeRaw = engine.executeRaw;
    const error = fault();
    let probes = 0;
    engine.executeRaw = (async (sql: string, ...args: unknown[]) => {
      if (sql.trim() === 'SELECT 1') { probes++; throw error; }
      return executeRaw.call(engine, sql, ...args as [unknown[]]);
    }) as typeof engine.executeRaw;
    try {
      const worker = new MinionWorker(engine, { pollInterval: 5, healthCheckInterval: 5, dbFailExitAfter: 100 });
      worker.register('fixture', async () => {});
      await worker.start();
      expect(worker.configurationError).toBe(error);
      expect(probes).toBe(1);
    } finally {
      engine.executeRaw = executeRaw;
    }
  });

  test('a late ordinary health failure cannot override a latched configuration block', async () => {
    const original = engine.executeRaw;
    const entered = deferred<void>();
    const resume = deferred<void>();
    engine.executeRaw = (async (sql: string, ...args: unknown[]) => {
      if (sql.trim() === 'SELECT 1') {
        entered.resolve();
        await resume.promise;
        throw new Error('fixture network failure');
      }
      return original.call(engine, sql, ...args as [unknown[]]);
    }) as typeof engine.executeRaw;
    try {
      const worker = new MinionWorker(engine, { pollInterval: 5, healthCheckInterval: 5, dbFailExitAfter: 1 });
      const events: UnhealthyReason[] = [];
      worker.on('unhealthy', event => events.push(event));
      worker.register('fixture', async () => {});
      const run = worker.start();
      await entered.promise;
      worker.blockForConfiguration(fault());
      await run;
      resume.resolve();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(events.map(event => event.reason)).toEqual(['client_misconfigured']);
    } finally {
      resume.resolve();
      engine.executeRaw = original;
    }
  });

  test('typed handler fault blocks before accounting and preserves the claimed job', async () => {
    const job = await queue.add('fixture', {}, { max_attempts: 1 });
    const second = await queue.add('fixture', {});
    const worker = makeWorker();
    const error = fault();
    const events: UnhealthyReason[] = [];
    let starts = 0;
    worker.register('fixture', async () => { starts++; throw error; });
    worker.on('unhealthy', info => {
      expect(worker.configurationError).toBe(error);
      events.push(info);
    });
    await worker.start();
    worker.blockForConfiguration(fault());
    expect(events).toEqual([{ reason: 'client_misconfigured', error }]);
    expect(starts).toBe(1);
    expect((await queue.getJob(job.id))?.status).toBe('delayed');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
    expect((await queue.getJob(job.id))?.stalled_counter).toBe(0);
    expect((await queue.getJob(second.id))?.status).toBe('waiting');
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
    await worker.start();
    expect(starts).toBe(1);
  });

  test('same error text without the type remains an ordinary job failure', async () => {
    const job = await queue.add('fixture', {}, { max_attempts: 1 });
    const worker = makeWorker();
    worker.register('fixture', async () => { worker.stop(); throw new Error(fault().message); });
    await worker.start();
    expect(worker.configurationError).toBeNull();
    expect((await queue.getJob(job.id))?.status).toBe('dead');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(1);
  });

  test('a typed recording fault blocks before execution tracking is discarded', async () => {
    const job = await queue.add('fixture', {});
    const worker = makeWorker();
    const error = fault();
    (worker as unknown as { queue: MinionQueue }).queue.failJob = async () => { throw error; };
    worker.register('fixture', async () => { throw new Error('fixture ordinary handler error'); });
    await worker.start();
    expect(worker.configurationError).toBe(error);
    expect((await queue.getJob(job.id))?.status).toBe('delayed');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
  });

  test('a paused late claim is registered and released without executing', async () => {
    const job = await queue.add('fixture', {});
    const worker = makeWorker();
    const claimed = deferred<void>();
    const resume = deferred<void>();
    const internals = worker as unknown as { queue: MinionQueue };
    const claim = internals.queue.claim.bind(internals.queue);
    internals.queue.claim = async (...args) => {
      const result = await claim(...args);
      claimed.resolve();
      await resume.promise;
      return result;
    };
    let starts = 0;
    worker.register('fixture', async () => { starts++; });
    const run = worker.start();
    await claimed.promise;
    worker.blockForConfiguration(fault());
    resume.resolve();
    await run;
    expect(starts).toBe(0);
    expect((await queue.getJob(job.id))?.status).toBe('delayed');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
  });

  test('scheduling eviction cannot authorize release of a live inline handler', async () => {
    const job = await queue.add('fixture', {});
    const worker = makeWorker();
    const started = deferred<void>();
    const settle = deferred<void>();
    const internals = worker as unknown as { inFlight: Map<number, unknown>; configurationDeadline: number };
    worker.register('fixture', async () => { started.resolve(); await settle.promise; throw fault(); });
    const run = worker.start();
    await started.promise;
    internals.inFlight.clear();
    worker.blockForConfiguration(fault());
    internals.configurationDeadline = performance.now() + 30;
    await run;
    expect((await queue.getJob(job.id))?.status).toBe('active');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['unconfirmed']);
    settle.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await queue.getJob(job.id))?.status).toBe('active');
  });

  test('cooperative inline shutdown releases only after execution has settled', async () => {
    const job = await queue.add('fixture', {});
    const worker = makeWorker();
    const started = deferred<void>();
    const settle = deferred<void>();
    worker.register('fixture', async () => { started.resolve(); await settle.promise; throw new Error('fixture stopped'); });
    const run = worker.start();
    await started.promise;
    worker.blockForConfiguration(fault());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await queue.getJob(job.id))?.status).toBe('active');
    settle.resolve();
    await run;
    expect((await queue.getJob(job.id))?.status).toBe('delayed');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
  });

  test('unconfirmed child cleanup cannot authorize delayed release', async () => {
    const job = await queue.add('fixture', {});
    const worker = makeWorker();
    const started = deferred<void>();
    const settle = deferred<void>();
    worker.register('fixture', async () => { started.resolve(); await settle.promise; throw new ChildWorkerShutdownError('fixture cleanup unconfirmed', false); });
    const run = worker.start();
    await started.promise;
    worker.blockForConfiguration(fault());
    (worker as unknown as { configurationDeadline: number }).configurationDeadline = performance.now() + 30;
    settle.resolve();
    await run;
    expect((await queue.getJob(job.id))?.status).toBe('active');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['unconfirmed']);
  });

  test('the 30-second eviction deadline cannot dead-letter or release live inline execution', async () => {
    const job = await queue.add('fixture', {}, { max_attempts: 1 });
    const worker = makeWorker();
    const started = deferred<void>();
    const settle = deferred<void>();
    worker.register('fixture', async () => { started.resolve(); await settle.promise; throw new Error('fixture stopped late'); });
    const run = worker.start();
    await started.promise;
    const internals = worker as unknown as { configurationDeadline: number };
    const blockedAt = performance.now();
    worker.blockForConfiguration(fault());
    expect(internals.configurationDeadline - blockedAt).toBeGreaterThanOrEqual(29_990);
    expect(internals.configurationDeadline - blockedAt).toBeLessThan(30_100);
    const began = performance.now();
    internals.configurationDeadline = began + 300;
    await run;
    expect(performance.now() - began).toBeGreaterThanOrEqual(290);
    expect(performance.now() - began).toBeLessThan(2_300);
    expect((await queue.getJob(job.id))?.status).toBe('active');
    expect((await queue.getJob(job.id))?.attempts_made).toBe(0);
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['unconfirmed']);
    settle.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await queue.getJob(job.id))?.status).toBe('active');
  }, 15_000);

  test('a claim still unknown at the global deadline reports lease-expiry fallback', async () => {
    const job = await queue.add('fixture', {});
    const worker = makeWorker();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const internals = worker as unknown as { queue: MinionQueue; configurationDeadline: number };
    const claim = internals.queue.claim.bind(internals.queue);
    internals.queue.claim = async (...args) => {
      const result = await claim(...args);
      entered.resolve();
      await resume.promise;
      return result;
    };
    let starts = 0;
    worker.register('fixture', async () => { starts++; });
    const run = worker.start();
    await entered.promise;
    worker.blockForConfiguration(fault());
    internals.configurationDeadline = performance.now() + 30;
    await run;
    expect(worker.configurationReleaseResults).toHaveLength(1);
    expect(worker.configurationReleaseResults[0]).toMatchObject({ jobId: null, outcome: 'unconfirmed' });
    resume.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(starts).toBe(0);
    expect(worker.configurationReleaseResults[0]).toMatchObject({ jobId: job.id, outcome: 'unconfirmed' });
    expect((await queue.getJob(job.id))?.status).toBe('active');
  });

  test('40 owned tokens share one deadline and at most four release queries', async () => {
    const worker = makeWorker();
    const internals = worker as unknown as {
      queue: MinionQueue;
      executions: Map<string, { job: { id: number }; lockToken: string; stopped: boolean }>;
      configurationDeadline: number;
      drainConfiguration(): Promise<void>;
    };
    for (let id = 1; id <= 40; id++) internals.executions.set(`token-${id}`, { job: { id }, lockToken: `token-${id}`, stopped: true });
    let active = 0;
    let peak = 0;
    internals.queue.releaseConfigurationJob = async (id, _token, signal) => {
      active++;
      peak = Math.max(peak, active);
      if (id === 1) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      else await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return signal.aborted ? 'unconfirmed' : 'released';
    };
    worker.blockForConfiguration(fault());
    internals.configurationDeadline = performance.now() + 250;
    const began = performance.now();
    await internals.drainConfiguration();
    expect(performance.now() - began).toBeLessThan(1000);
    expect(peak).toBeLessThanOrEqual(4);
    expect(worker.configurationReleaseResults).toHaveLength(40);
    expect(worker.configurationReleaseResults.filter(result => result.outcome === 'released')).toHaveLength(39);
    expect(worker.configurationReleaseResults.filter(result => result.outcome === 'unconfirmed')).toHaveLength(1);
  });
});
