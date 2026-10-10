/**
 * #4578: brain-wide maintenance on a large brain died at its fixed 30-minute
 * deadline and restarted every phase on each run, so late phases never ran.
 * The handler now stops starting phases the deadline would cut off, resumes
 * at the next phase on the following run, skips a phase that killed an
 * earlier job, and the deadline is configurable. Doctor names the phase and
 * the command that runs it without the job deadline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LAST_GLOBAL_AT_KEY } from '../src/core/cycle.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  GLOBAL_MAINTENANCE_PROGRESS_KEY,
  makeAutopilotGlobalMaintenanceHandler,
  readGlobalMaintenanceProgress,
} from '../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { dispatchGlobalMaintenance, resolveGlobalMaintenanceTimeoutMs } from '../src/commands/autopilot-fanout.ts';
import { globalMaintenanceTimeoutsCheck } from '../src/commands/doctor/checks/global-maintenance-timeouts.ts';

let engine: PGLiteEngine;
let repoPath: string;
let schemaVersion: string;
const phases = ['orphans', 'purge'];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-global-resume-'));
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const run = (job: Record<string, unknown>) => makeAutopilotGlobalMaintenanceHandler(engine)(
  { id: 7001, attempts_made: 0, signal: undefined, deadlineAtMs: null, data: { phases, repoPath }, ...job } as never) as Promise<any>;

describe('autopilot-global-maintenance resumes across jobs (#4578)', () => {
  test('a phase the deadline would cut off is deferred to the next job, which resumes there and completes the pass', async () => {
    await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ durations: { purge: 20 * 60_000 } }));
    const first = await run({ deadlineAtMs: Date.now() + 5 * 60_000 });
    expect(first.report.phases.map((p: { phase: string }) => p.phase)).toEqual(['orphans']);
    expect(first.report.deferred_phases).toEqual(['purge']);
    expect(first.report.status).toBe('partial');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    expect((await readGlobalMaintenanceProgress(engine)).next_phase).toBe('purge');

    const second = await run({ id: 7002 });
    expect(second.report.phases.map((p: { phase: string }) => p.phase)).toEqual(['purge']);
    expect(second.report.deferred_phases).toBeUndefined();
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
    expect((await readGlobalMaintenanceProgress(engine)).next_phase).toBeUndefined();
  }, 60_000);

  test('a phase that was running when an earlier job died is skipped for the pass; later phases still run', async () => {
    await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ running_phase: 'orphans', running_job: '6999:0', next_phase: 'orphans' }));
    const result = await run({});
    expect(result.report.phases.find((p: { phase: string }) => p.phase === 'orphans'))
      .toMatchObject({ status: 'skipped', details: { reason: 'timed_out_previous_job', recovery: 'gbrain dream --phase orphans' } });
    expect(result.report.phases.find((p: { phase: string }) => p.phase === 'purge')?.status).not.toBe('skipped');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const progress = await readGlobalMaintenanceProgress(engine);
    expect(progress.timeouts?.orphans?.count).toBe(1);
    expect(progress.running_phase).toBeUndefined();
  }, 60_000);

  test('the job deadline follows env > config > the autopilot default', async () => {
    expect(await resolveGlobalMaintenanceTimeoutMs(engine, 1_800_000)).toBe(1_800_000);
    await engine.setConfig('autopilot.global_maintenance_timeout_ms', '7200000');
    expect(await resolveGlobalMaintenanceTimeoutMs(engine, 1_800_000)).toBe(7_200_000);
    await withEnv({ GBRAIN_GLOBAL_MAINTENANCE_TIMEOUT_MS: '5400000' }, async () => {
      expect(await resolveGlobalMaintenanceTimeoutMs(engine, 1_800_000)).toBe(5_400_000);
    });
    const added: Array<{ opts: { timeout_ms: number } }> = [];
    const queue = { add: async (_n: string, _d: unknown, opts: { timeout_ms: number }) => { added.push({ opts }); return { id: 1 }; } } as never;
    await dispatchGlobalMaintenance(engine, queue, { repoPath, slot: 's', timeoutMs: 1_800_000, jsonMode: true, emit: () => {} });
    expect(added[0]!.opts.timeout_ms).toBe(7_200_000);
  });
});

describe('global_maintenance_timeouts doctor check (#4578)', () => {
  async function deadJobs(n: number, error = 'timeout exceeded') {
    const queue = new MinionQueue(engine);
    for (let i = 0; i < n; i++) {
      const job = await queue.add('autopilot-global-maintenance', {}, { idempotency_key: `dead-${error}-${i}` });
      await engine.executeRaw(`UPDATE minion_jobs SET status = 'dead', error_text = $2, finished_at = now() + ($1 || ' seconds')::interval WHERE id = $3`,
        [String(i), error, job.id]);
    }
  }

  test('ok with no deaths; warns after three consecutive timeout deaths and names the phase and its command', async () => {
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
    await deadJobs(2);
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
    await deadJobs(1, 'timeout exceeded');
    await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ timeouts: { embed: { count: 3, last_at: '2026-10-01T00:00:00Z' } } }));
    const check = await globalMaintenanceTimeoutsCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({
      code: 'global_maintenance_timeouts',
      fix: { kind: 'run_command', argv: ['gbrain', 'dream', '--phase', 'embed'] },
      docs: 'docs/guides/troubleshooting.md#global-maintenance-timeouts',
      phases: [{ phase: 'embed', consecutive_deaths: 3 }],
    });
    expect(check.message).toContain('gbrain dream --phase embed');
    expect(check.message).toContain('autopilot.global_maintenance_timeout_ms');
  });

  test('a completed job after timeout deaths clears the warning', async () => {
    await deadJobs(3);
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('warn');
    const job = await new MinionQueue(engine).add('autopilot-global-maintenance', {}, { idempotency_key: 'completed-after' });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now() + interval '1 hour' WHERE id = $1`, [job.id]);
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
  });
  test('#6303: three dead patterns children at their own timeout warn while the jobs complete', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('autopilot-global-maintenance', {}, { idempotency_key: 'completed-partial' });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`, [job.id]);
    const child = async (i: number, error: string, key = `dream:patterns:k${i}`) => {
      const sub = await queue.add('subagent', {}, { idempotency_key: key }, { allowProtectedSubmit: true });
      await engine.executeRaw(`UPDATE minion_jobs SET status = 'dead', error_text = $2, finished_at = now() + ($1 || ' seconds')::interval WHERE id = $3`,
        [String(i), error, sub.id]);
    };
    await child(0, 'timeout exceeded');
    await child(1, 'wall-clock timeout exceeded');
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
    await child(2, 'timeout exceeded');
    await child(3, 'prompt_too_long: 1', 'dream:synth-v2:default:filename:a.md:0123456789abcdef');
    const check = await globalMaintenanceTimeoutsCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('dream.patterns.subagent_timeout_ms');
    expect(check.message).toContain('autopilot.global_maintenance_timeout_ms');
    expect(check.message).toContain('gbrain dream --phase patterns');
    expect(check.message).toContain('paid');
    expect(check.details).toMatchObject({ child_timeouts: [{ phase: 'patterns', consecutive_deaths: 3 }] });
    expect(check.message).not.toContain('synthesize');
  });

  test('#6303: a completed patterns child after timeouts clears the child warning', async () => {
    const queue = new MinionQueue(engine);
    for (let i = 0; i < 4; i++) {
      const sub = await queue.add('subagent', {}, { idempotency_key: `dream:patterns:c${i}` }, { allowProtectedSubmit: true });
      await engine.executeRaw(`UPDATE minion_jobs SET status = $4, error_text = $2, finished_at = now() + ($1 || ' seconds')::interval WHERE id = $3`,
        [String(i), i < 3 ? 'timeout exceeded' : null, sub.id, i < 3 ? 'dead' : 'completed']);
    }
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
  });
});
