/**
 * autopilot-global-maintenance fails CLOSED on an empty phase intersection
 * (outside-voice finding OV3). Pre-fix, jobs.ts substituted the FULL
 * MAINTENANCE_PHASES list whenever a payload's phases had no maintenance
 * phase in them, so a bogus or source-scoped payload silently ran every
 * mixed and global phase (LLM phases included) through the global lane.
 * The full list remains the default only when NO phases were requested.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { MAINTENANCE_PHASES } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let gbrainHome: string;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-global-phases-home-'));
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-global-phases-repo-'));
});
afterEach(() => {
  rmSync(gbrainHome, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

async function globalHandler() {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
  await registerBuiltinHandlers(fakeWorker as never, engine);
  const h = handlers.get('autopilot-global-maintenance');
  if (!h) throw new Error('autopilot-global-maintenance not registered');
  return h;
}

describe('autopilot-global-maintenance phase gating', () => {
  test('a payload with only bogus / source-scoped phases is skipped with no_valid_phases and the rejected list', async () => {
    const handler = await globalHandler();
    const result = await handler({ id: 1, data: { phases: ['bogus_phase', 'lint', 'sync'], repoPath }, signal: undefined });
    expect(result.status).toBe('skipped');
    expect(result.partial).toBe(false);
    expect(result.report.reason).toBe('no_valid_phases');
    expect(result.report.rejected).toEqual(['bogus_phase', 'lint', 'sync']);
    expect(result.report.requested).toEqual(['bogus_phase', 'lint', 'sync']);
    // Nothing ran: no last_global_at stamp.
    expect(await engine.getConfig('autopilot.last_global_at')).toBeNull();
  });

  test('an explicitly empty phase list is the same explicit no-op', async () => {
    const handler = await globalHandler();
    const result = await handler({ id: 2, data: { phases: [], repoPath }, signal: undefined });
    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('no_valid_phases');
    expect(result.report.rejected).toEqual([]);
  });

  test('a mixed payload runs only the maintenance subset and surfaces what it rejected', async () => {
    const handler = await globalHandler();
    const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      handler({ id: 3, data: { phases: ['orphans', 'lint'], repoPath }, signal: undefined }));
    expect(result.status).not.toBe('skipped');
    expect(result.report.phases.map((p: any) => p.phase)).toEqual(['orphans']);
    expect(result.phases_rejected).toEqual(['lint']);
    expect(result.brain_dir_reason).toBe('explicit');
  });

  test('a payload with no phases key still runs the full maintenance list', async () => {
    const handler = await globalHandler();
    const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      handler({ id: 4, data: { repoPath }, signal: undefined }));
    expect(result.status).not.toBe('skipped');
    const ran = result.report.phases.map((p: any) => p.phase);
    for (const p of MAINTENANCE_PHASES) expect(ran).toContain(p);
    expect(result.phases_rejected).toBeUndefined();
  });

  test('an explicit repoPath that does not exist fails the job with the reason', async () => {
    const handler = await globalHandler();
    await expect(handler({ id: 5, data: { repoPath: '/nonexistent/gbrain-global-phases' }, signal: undefined }))
      .rejects.toThrow(/explicit_missing/);
  });
});
