import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { waitForValue } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(() => engine.disconnect());

test('a committed claim with a lost reply runs once under its original token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-claim-readback-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: '0' }, async () => {
      const queue = new MinionQueue(engine);
      const submitted = await queue.add('readback-fixture', {}, { queue: 'readback', max_stalled: 1, max_attempts: 1 });
      const execute = engine.executeRawDirect.bind(engine);
      let lostToken: string | undefined;
      engine.executeRawDirect = async <T>(...args: Parameters<PGLiteEngine['executeRawDirect']>) => {
        const [sql, params] = args;
        const rows = await execute<T>(...args);
        if (!lostToken && params?.[2] === 'readback' && sql.includes('claim_generation = claim_generation + 1') && rows.length) {
          lostToken = String(params[0]);
          expect((await queue.getJob(submitted.id))?.status).toBe('active');
          throw Object.assign(new Error('fixture: claim reply lost after commit'), { code: 'CONNECTION_STUCK' });
        }
        return rows;
      };
      const worker = new MinionWorker(engine, {
        queue: 'readback', pollInterval: 20, stalledInterval: 80, lockDuration: 1000, healthCheckInterval: 0,
      });
      const observedTokens: Array<string | null> = [];
      worker.register('readback-fixture', async job => {
        observedTokens.push((await queue.getJob(job.id))?.lock_token ?? null);
        return {};
      });
      const running = worker.start();
      try {
        const settled = await Promise.race([
          waitForValue(async () => {
            const row = await queue.getJob(submitted.id);
            return row?.status === 'completed' || row?.status === 'dead' ? row : null;
          }, { label: 'worker settles the recovered claim' }),
          running.then(() => { throw new Error('Worker stopped before the claim settled'); }),
        ]);
        expect(lostToken).toBeDefined();
        expect(observedTokens).toEqual([lostToken ?? null]);
        expect(settled).toMatchObject({ status: 'completed', attempts_started: 1, attempts_made: 0, stalled_counter: 0 });
      } finally {
        worker.stop();
        try {
          await running;
        } finally {
          engine.executeRawDirect = execute;
        }
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
