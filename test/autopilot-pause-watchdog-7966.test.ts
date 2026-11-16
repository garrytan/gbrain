/**
 * #7966: an autopilot pause (the operator pause or the cooperative migrate marker) stops the worker's claims, so the
 * worker's own no-progress watchdog must not read the hold as a stall, and doctor must not prescribe a worker restart
 * for a queue that the pause is holding. Real database liveness checks stay on, and a real stall is still detected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { computeWedgedQueueCheck } from '../src/commands/doctor.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

const OPERATOR = 'autopilot-operator-paused';
const COOPERATIVE = 'autopilot-paused';

function brainHome(...markers: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-pause-7966-'));
  dirs.push(home);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  for (const m of markers) writeFileSync(join(home, '.gbrain', m), 'test hold\n');
  return home;
}

function probeEngine(opts: { waiting: number; probe?: () => Promise<unknown> }) {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]): Promise<unknown[]> => {
          if (/^\s*SELECT\s+1\s*$/i.test(sql)) return [await (opts.probe ?? (async () => ({ ok: 1 })))()];
          if (/count\(\*\).*minion_jobs.*WHERE\s+status\s*=\s*'waiting'/is.test(sql)) return [{ cnt: String(opts.waiting) }];
          return target.executeRaw(sql, params);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PGLiteEngine;
}

function worker(e: PGLiteEngine, stall: { warn: number; exit: number }) {
  const w = new MinionWorker(e, {
    queue: 'default', concurrency: 1, healthCheckInterval: 30, stallWarnAfterMs: stall.warn, stallExitAfterMs: stall.exit,
    dbFailExitAfter: 3, pollInterval: 20, stalledInterval: 10_000, maxRssMb: 0,
  });
  w.register('noop', async () => {});
  const events: Array<{ reason: string }> = [];
  w.on('unhealthy', info => { events.push(info); });
  return { w, events };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('worker watchdog under an autopilot pause (#7966)', () => {
  for (const [label, markers] of [['operator pause', [OPERATOR]], ['cooperative pause', [COOPERATIVE]], ['both markers', [OPERATOR, COOPERATIVE]]] as const) {
    test(`${label}: waiting jobs and no progress are not a stall`, async () => {
      const home = brainHome(...markers);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SUPERVISED: undefined }, async () => {
        const { w, events } = worker(probeEngine({ waiting: 5 }), { warn: 50, exit: 100 });
        const run = w.start();
        await sleep(500);
        w.stop();
        await run;
        expect(events.filter(e => e.reason === 'stalled')).toHaveLength(0);
      });
    }, 10_000);
  }

  test('a long pause does not trip the watchdog right after resume, and a real stall afterwards still does', async () => {
    const home = brainHome(COOPERATIVE);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SUPERVISED: undefined }, async () => {
      const { w, events } = worker(probeEngine({ waiting: 5 }), { warn: 500, exit: 1_000 });
      const run = w.start();
      await sleep(1_500);
      rmSync(join(home, '.gbrain', COOPERATIVE));
      await sleep(400);
      const stalledSoonAfterResume = events.filter(e => e.reason === 'stalled').length;
      await waitFor(() => events.some(e => e.reason === 'stalled'), { timeoutMs: 5_000, label: 'real stall after resume' });
      w.stop();
      await run;
      expect(stalledSoonAfterResume).toBe(0);
    });
  }, 15_000);

  test('removing one of two markers keeps the hold', async () => {
    const home = brainHome(OPERATOR, COOPERATIVE);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SUPERVISED: undefined }, async () => {
      const { w, events } = worker(probeEngine({ waiting: 5 }), { warn: 50, exit: 100 });
      const run = w.start();
      await sleep(150);
      rmSync(join(home, '.gbrain', COOPERATIVE));
      await sleep(400);
      w.stop();
      await run;
      expect(events.filter(e => e.reason === 'stalled')).toHaveLength(0);
    });
  }, 10_000);

  test('a dead database is still reported while paused', async () => {
    const home = brainHome(OPERATOR);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SUPERVISED: undefined }, async () => {
      const { w, events } = worker(probeEngine({ waiting: 5, probe: async () => { throw new Error('connection terminated unexpectedly'); } }), { warn: 50, exit: 100 });
      const run = w.start();
      await waitFor(() => events.some(e => e.reason === 'db_dead'), { timeoutMs: 5_000, label: 'db_dead while paused' });
      w.stop();
      await run;
    });
  }, 10_000);

  test('the watchdog reads the markers and leaves them in place', async () => {
    const home = brainHome(OPERATOR, COOPERATIVE);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SUPERVISED: undefined }, async () => {
      const { w } = worker(probeEngine({ waiting: 5 }), { warn: 50, exit: 100 });
      const run = w.start();
      await sleep(200);
      w.stop();
      await run;
    });
    expect(Bun.file(join(home, '.gbrain', OPERATOR)).size).toBeGreaterThan(0);
    expect(Bun.file(join(home, '.gbrain', COOPERATIVE)).size).toBeGreaterThan(0);
  }, 10_000);
});

describe('doctor wedged_queue under an autopilot pause (#7966)', () => {
  const pgLike = () => ({ kind: 'postgres', executeRaw: engine.executeRaw.bind(engine) }) as unknown as BrainEngine;
  async function seedWedged(): Promise<void> {
    for (const [status, updated] of [['waiting', 'now()'], ['completed', "now() - interval '20 min'"]] as const) {
      await engine.executeRaw(
        `INSERT INTO minion_jobs (submission_authority, name, queue, status, updated_at) VALUES ('{"version":1,"kind":"application"}'::jsonb, 'cycle', 'default', $1, ${updated})`,
        [status],
      );
    }
  }
  const liveWorker = () => [{ queue: 'default' }];

  test('an operator pause reports the held queue as a warning that names the resume, never a restart', async () => {
    await seedWedged();
    const check = await withEnv({ GBRAIN_HOME: brainHome(OPERATOR) }, () => computeWedgedQueueCheck(pgLike(), { readWorkers: liveWorker }));
    expect(check.status).toBe('warn');
    expect(check.message).toContain("'default'");
    expect(check.message).toContain('gbrain autopilot resume');
    expect(check.message).not.toContain('supervisor stop');
    expect(check.details).toMatchObject({ paused: 'operator', wedged_queues: 1 });
  });

  test('a cooperative (migrate) pause reports the hold without a restart either', async () => {
    await seedWedged();
    const check = await withEnv({ GBRAIN_HOME: brainHome(COOPERATIVE) }, () => computeWedgedQueueCheck(pgLike(), { readWorkers: liveWorker }));
    expect(check.status).toBe('warn');
    expect(check.message).not.toContain('supervisor stop');
    expect(check.details).toMatchObject({ paused: 'cooperative' });
  });

  test('without a pause the wedged queue still fails with the restart advice', async () => {
    await seedWedged();
    const check = await withEnv({ GBRAIN_HOME: brainHome() }, () => computeWedgedQueueCheck(pgLike(), { readWorkers: liveWorker }));
    expect(check.status).toBe('fail');
    expect(check.message).toContain('supervisor stop');
  });
});
