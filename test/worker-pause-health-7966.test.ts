import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { autopilotOperatorPauseMarkerPath } from '../src/core/autopilot-paths.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('worker pause health watchdog (#7966)', () => {
  test('keeps probing while operator pause explains a waiting queue', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const marker = autopilotOperatorPauseMarkerPath();
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, 'operator hold');
      let probes = 0;
      const engine = {
        kind: 'postgres',
        executeRaw: async (sql: string) => {
          if (sql.trim() === 'SELECT 1') { probes++; return []; }
          if (sql.includes("status = 'waiting'")) return [{ cnt: '1' }];
          return [];
        },
      } as unknown as BrainEngine;
      const worker = new MinionWorker(engine, {
        pollInterval: 2, healthCheckInterval: 5, stallWarnAfterMs: 5, stallExitAfterMs: 10,
      });
      (worker as unknown as { queue: unknown }).queue = {
        ensureSchema: async () => {}, promoteDelayed: async () => {}, claim: async () => null,
      };
      worker.register('held-job', async () => {});
      const unhealthy: unknown[] = [];
      worker.on('unhealthy', event => unhealthy.push(event));
      const running = worker.start();
      try {
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(probes).toBeGreaterThan(1);
        expect(unhealthy).toEqual([]);
      } finally {
        worker.stop();
        await running;
        rmSync(marker, { force: true });
      }
    });
  });
});
