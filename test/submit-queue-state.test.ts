/**
 * Minions-visibility wave — submit-time queue-state probe (amendments 24/25,
 * ENG-18 dead-lane suite).
 *
 * Covers `probeQueueState` (src/core/minions/supervisor.ts) directly plus the
 * `submit_job` wiring:
 *   - workerless queue → worker_alive: false + warning
 *   - autopilot pause marker → paused: true + "paused for migration" warning
 *   - depth over GBRAIN_QUEUE_WAITING_THRESHOLD → warning
 *   - probe throws / hangs → {probe_failed: true}, and a throwing probe NEVER
 *     errors a successful submission (fail-open contract)
 *
 * All filesystem probes (pause marker, worker registry) run under a scratch
 * GBRAIN_HOME so a dev machine's real ~/.gbrain state can't flake assertions.
 * PGLite only; the probe's SQL is engine-neutral executeRaw (the wedge-signal
 * query is already parity-pinned by test/supervisor-wedge.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { probeQueueState } from '../src/core/minions/supervisor.ts';
import { autopilotPausedMarkerPath } from '../src/core/autopilot-paths.ts';
import { operationsByName } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '85');
});

async function seedJob(opts: {
  status?: string;
  queue?: string;
  name?: string;
  createdAtSql?: string;
  lockUntilSql?: string;
} = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at, lock_until)
     VALUES ($1, $2, '{}'::jsonb, $3, 0, ${opts.createdAtSql ?? 'now()'}, ${opts.lockUntilSql ?? 'NULL'})`,
    [opts.name ?? 'embed', opts.status ?? 'waiting', opts.queue ?? 'default'],
  );
}

describe('probeQueueState — dead/degraded lane signals', () => {
  it('workerless queue: worker_alive false + a start-a-worker warning', async () => {
    await seedJob({ createdAtSql: "now() - interval '2 hours'" });
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const state = await probeQueueState(engine, 'default', ['embed']);
      expect(state.probe_failed).toBeUndefined();
      expect(state.depth).toBe(1);
      expect(state.worker_alive).toBe(false);
      expect(state.oldest_waiting_age_seconds).toBeGreaterThanOrEqual(7000);
      expect(state.warning).toContain("no live worker detected for queue 'default'");
      expect(state.warning).toContain('gbrain jobs work --queue default');
    });
  });

  it('a live-lock active job counts as worker evidence (worker_alive true, no worker warning)', async () => {
    await seedJob({ status: 'active', lockUntilSql: "now() + interval '5 minutes'" });
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const state = await probeQueueState(engine, 'default', ['embed']);
      expect(state.worker_alive).toBe(true);
      expect(state.warning).toBeUndefined();
    });
  });

  it('pause marker: paused true + the migration warning (amendment 25)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      // Seed the marker the way `gbrain migrate` does (see
      // test/autopilot-pause-marker.test.ts) — path resolves under the
      // scratch GBRAIN_HOME at call time.
      const marker = autopilotPausedMarkerPath();
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, `paused by gbrain migrate (pid ${process.pid})\n`);

      const state = await probeQueueState(engine, 'default', ['embed']);
      expect(state.paused).toBe(true);
      expect(state.warning).toContain('system paused for migration — job will not start until the pause clears');
    });
  });

  it('depth over GBRAIN_QUEUE_WAITING_THRESHOLD → depth warning (doctor knob reused)', async () => {
    for (let i = 0; i < 4; i++) await seedJob({});
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_QUEUE_WAITING_THRESHOLD: '2' }, async () => {
      const state = await probeQueueState(engine, 'default', ['embed']);
      expect(state.depth).toBe(4);
      expect(state.warning).toContain('waiting depth 4 exceeds GBRAIN_QUEUE_WAITING_THRESHOLD (2)');
    });
  });

  it('empty queue: depth 0, oldest age null', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const state = await probeQueueState(engine, 'default', ['embed']);
      expect(state.depth).toBe(0);
      expect(state.oldest_waiting_age_seconds).toBeNull();
    });
  });

  it('probe throw → {probe_failed: true} (fail-open, amendment 24)', async () => {
    const throwing: any = {
      kind: 'pglite',
      executeRaw: async () => {
        throw new Error('db exploded');
      },
    };
    const state = await probeQueueState(throwing, 'default', ['embed']);
    expect(state).toEqual({ probe_failed: true });
  });

  it('probe hang → {probe_failed: true} within the time bound', async () => {
    const hanging: any = {
      kind: 'pglite',
      executeRaw: () => new Promise(() => {}), // never resolves
    };
    const started = Date.now();
    const state = await probeQueueState(hanging, 'default', ['embed'], { timeoutMs: 60 });
    expect(state).toEqual({ probe_failed: true });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('submit_job wiring — probe never blocks a successful enqueue', () => {
  const submit_job = operationsByName['submit_job'];

  function makeCtx(eng: any): any {
    return {
      engine: eng,
      config: {},
      logger: console,
      dryRun: false,
      remote: true,
    };
  }

  it('attaches queue_state to a successful submission (workerless PGLite → warning)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const result = (await submit_job.handler(makeCtx(engine), { name: 'embed' })) as any;
      expect(result.id).toBeGreaterThan(0);
      expect(result.queue_state).toBeDefined();
      expect(result.queue_state.probe_failed).toBeUndefined();
      // The probe runs post-enqueue: depth counts the job just submitted.
      expect(result.queue_state.depth).toBeGreaterThanOrEqual(1);
      expect(result.queue_state.worker_alive).toBe(false);
      expect(result.queue_state.warning).toContain('no live worker');
    });
  });

  it('a throwing probe degrades to queue_state {probe_failed: true} — the enqueue still succeeds', async () => {
    // Delegate everything to the real engine EXCEPT the wedge-signal query
    // (identified by its waiting_claimable alias), which the probe — and only
    // the probe — runs.
    const throwOnWedge: any = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'executeRaw') {
          return async (sql: string, ...rest: unknown[]) => {
            if (typeof sql === 'string' && sql.includes('waiting_claimable')) {
              throw new Error('probe-only failure');
            }
            return (target as any).executeRaw(sql, ...rest);
          };
        }
        const v = Reflect.get(target as object, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const result = (await submit_job.handler(makeCtx(throwOnWedge), { name: 'embed' })) as any;
      expect(result.id).toBeGreaterThan(0);
      expect(result.status).toBe('waiting');
      expect(result.queue_state).toEqual({ probe_failed: true });
      // The row really persisted — the probe failure cost nothing.
      const rows = await engine.executeRaw<{ n: number | string }>(
        `SELECT count(*)::int AS n FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('pause marker surfaces through submit_job (paused + warning, enqueue unblocked)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const marker = autopilotPausedMarkerPath();
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, `paused by gbrain migrate (pid ${process.pid})\n`);

      const result = (await submit_job.handler(makeCtx(engine), { name: 'embed' })) as any;
      expect(result.id).toBeGreaterThan(0);
      expect(result.queue_state.paused).toBe(true);
      expect(result.queue_state.warning).toContain('system paused for migration');
    });
  });
});
