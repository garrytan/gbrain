/** A completed maintenance pass must update the engine-free status cache (#7854).
 * The existing injected cycle boundary chooses outcomes; the database, handler,
 * progress row and verdict file remain real. Failed passes must not clear it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LAST_GLOBAL_AT_KEY, type CycleReport } from '../src/core/cycle.ts';
import { autopilotGlobalMaintenanceVerdictPath } from '../src/core/autopilot-paths.ts';
import { recordGlobalMaintenanceStallStatus, readGlobalMaintenanceVerdict } from '../src/core/minions/global-maintenance-stall.ts';
import { makeAutopilotGlobalMaintenanceHandler } from '../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const runPass = (failed = false) => makeAutopilotGlobalMaintenanceHandler(engine, {
  runCycle: (async () => ({ schema_version: '1', timestamp: new Date().toISOString(), duration_ms: 1,
    status: failed ? 'failed' : 'clean', phases: [{ phase: 'orphans', status: failed ? 'fail' : 'ok', duration_ms: 1,
      summary: 'synthetic phase', details: {}, ...(failed ? { error: { code: 'invalid_data', message: 'synthetic failure' } } : {}) }], totals: {} })) as never,
})({ id: 7854, attempts_made: 0, signal: undefined, deadlineAtMs: null, data: { phases: ['orphans'], repoPath: null } } as never);

async function withStalledVerdict(fn: (oldStamp: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-verdict-refresh-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const oldStamp = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
      await engine.setConfig(LAST_GLOBAL_AT_KEY, oldStamp);
      const job = await new MinionQueue(engine).add('autopilot-global-maintenance', {}, { idempotency_key: 'previous-failure' });
      await engine.executeRaw("UPDATE minion_jobs SET status = 'failed', finished_at = now() WHERE id = $1", [job.id]);
      expect((await recordGlobalMaintenanceStallStatus(engine)).reason).toBe('stalled');
      await fn(oldStamp);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('maintenance completion refreshes cached status', () => {
  test('a successful pass replaces the stalled verdict with its new stamp', async () => withStalledVerdict(async oldStamp => {
    await runPass();
    const stamp = await engine.getConfig(LAST_GLOBAL_AT_KEY);
    expect(stamp).not.toBe(oldStamp);
    expect(readGlobalMaintenanceVerdict()).toMatchObject({ status: 'ok', reason: 'fresh', last_global_at: stamp, failed_jobs_since: 0, phases: [] });
  }));

  test('a failed pass keeps the old stamp and stalled verdict', async () => withStalledVerdict(async oldStamp => {
    await runPass(true);
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBe(oldStamp);
    expect(readGlobalMaintenanceVerdict()).toMatchObject({ status: 'warn', reason: 'stalled', last_global_at: oldStamp });
  }));

  test('a cache write failure cannot undo a completed pass', async () => withStalledVerdict(async oldStamp => {
    const path = autopilotGlobalMaintenanceVerdictPath();
    rmSync(path);
    mkdirSync(path);
    const result = await runPass() as { partial: boolean; status: CycleReport['status'] };
    expect(result).toMatchObject({ partial: false, status: 'clean' });
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBe(oldStamp);
  }));
});
