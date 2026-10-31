/**
 * #7854: `gbrain autopilot --status` reads the global-maintenance verdict file the daemon writes on a full-cycle
 * tick. A clean pass that stamps `autopilot.last_global_at` must refresh that file, or --status keeps reporting
 * `stalled` (exit 1) until the next full-cycle tick, which on a healthy brain can be hours away.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LAST_GLOBAL_AT_KEY, type CycleReport, type PhaseResult } from '../src/core/cycle.ts';
import { makeAutopilotGlobalMaintenanceHandler } from '../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { recordGlobalMaintenanceStallStatus } from '../src/core/minions/global-maintenance-stall.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-7854-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('a clean pass after a stalled verdict clears what autopilot --status reports', async () => {
  let purge: 'ok' | 'fail' = 'fail';
  const runCycle = async (_engine: unknown, opts: { phases?: string[] }): Promise<CycleReport> => {
    const phase = opts.phases![0]!;
    const result = (phase === 'purge' && purge === 'fail'
      ? { phase, status: 'fail', duration_ms: 1, summary: 'invalid_data', details: {}, error: { class: 'InternalError', code: 'invalid_data', message: 'invalid_data' } }
      : { phase, status: 'ok', duration_ms: 1, summary: 'ok', details: {} }) as PhaseResult;
    return { schema_version: '1', timestamp: new Date().toISOString(), duration_ms: 1, status: result.status === 'fail' ? 'failed' : 'ok', phases: [result], totals: {} } as unknown as CycleReport;
  };
  let jobId = 7854;
  const pass = () => withEnv({ GBRAIN_HOME: home }, () => makeAutopilotGlobalMaintenanceHandler(engine, { runCycle: runCycle as never })(
    { id: ++jobId, attempts_made: 0, signal: undefined, deadlineAtMs: null, data: { phases: ['orphans', 'purge'], repoPath: null } } as never));

  await engine.setConfig('autopilot.global_floor_min', '60');
  await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date(Date.now() - 5 * 60 * 60_000).toISOString());
  await pass();
  await withEnv({ GBRAIN_HOME: home }, () => recordGlobalMaintenanceStallStatus(engine));
  const stalled = await runCli(['autopilot', '--status', '--json'], { home });
  expect({ exit: stalled.exitCode, reason: JSON.parse(stalled.stdout).global_maintenance?.reason }).toEqual({ exit: 1, reason: 'stalled' });

  purge = 'ok';
  const before = await engine.getConfig(LAST_GLOBAL_AT_KEY);
  await pass();
  expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBe(before);
  const cleared = await runCli(['autopilot', '--status', '--json'], { home });
  const verdict = JSON.parse(cleared.stdout).global_maintenance;
  expect({ exit: cleared.exitCode, status: verdict?.status, last_global_at: verdict?.last_global_at })
    .toEqual({ exit: 0, status: 'ok', last_global_at: await engine.getConfig(LAST_GLOBAL_AT_KEY) });
}, 120_000);
