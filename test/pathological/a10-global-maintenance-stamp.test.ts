/**
 * GBRA-130 A-10 + C-6 (#6837): one maintenance phase that fails every pass
 * used to withhold `autopilot.last_global_at` forever, with no streak, no
 * back-off and nothing in doctor or `gbrain autopilot --status`.
 *
 * Authoring gate:
 * 1. Protects: a pass stamps past a phase that failed with the same code in
 *    three earlier passes (budget, deferral and child blockers never do), the
 *    failing phase backs off, the back-off resets on a version change, a new
 *    blocker key and `gbrain autopilot --retry-global`, doctor reports
 *    `global_maintenance_stalled`, and `autopilot --status` exits 1 on it.
 * 2. Fails if the stamp gate goes back to "any fail blocks", if streaks count
 *    a systemic or run-scoped run, or if the stall stops reaching doctor or
 *    the status exit code.
 * 3. test/autopilot-global-maintenance*.test.ts pin one pass; none runs the
 *    same failing phase across passes or reads the stall from doctor/status.
 * 4. One seam: `makeAutopilotGlobalMaintenanceHandler(engine, { runCycle })`,
 *    so a phase fails with a chosen code without depending on how any one
 *    phase fails today.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { LAST_GLOBAL_AT_KEY, MAINTENANCE_PHASES, type CycleReport, type PhaseResult } from '../../src/core/cycle.ts';
import {
  GLOBAL_MAINTENANCE_PROGRESS_KEY,
  makeAutopilotGlobalMaintenanceHandler,
  readGlobalMaintenanceProgress,
} from '../../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { DOCTOR_CHECK_REGISTRY } from '../../src/commands/doctor/registry.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { runCli } from '../helpers/cli-spawn.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems,
} from './harness.ts';

const SOURCE = 'default';
const HEALTHY = 'notes/healthy-example';
const BYSTANDER = 'notes/bystander-example';
const PHASES = ['orphans', 'purge'];
type Outcome = Partial<PhaseResult> | (() => never);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`global maintenance phase streaks (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let outcomes: Record<string, Outcome>;
    let calls: string[];
    let jobId = 9000;

    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      outcomes = {};
      calls = [];
      await resetState();
      for (const slug of [HEALTHY, BYSTANDER]) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `seed ${slug}` }, { sourceId: SOURCE, allowEmptyOverwrite: true });
      }
    });

    const resetState = async () => {
      await engine.executeRaw(`DELETE FROM config WHERE key IN ($1, $2, 'autopilot.global_floor_min')`, [LAST_GLOBAL_AT_KEY, GLOBAL_MAINTENANCE_PROGRESS_KEY]);
      await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'autopilot-global-maintenance'`);
    };
    const fail = (code: string): Outcome => ({ status: 'fail', summary: `${code} on one row`, details: {}, error: { class: 'InternalError', code, message: `${code} on one row` } });

    const runCycle = async (_engine: BrainEngine, opts: { phases?: string[] }): Promise<CycleReport> => {
      const phase = opts.phases![0]!;
      calls.push(phase);
      const outcome = outcomes[phase];
      if (typeof outcome === 'function') outcome();
      const result = { phase, status: 'ok', duration_ms: 1, summary: 'ok', details: {}, ...(outcome ?? {}) } as PhaseResult;
      if (result.status === 'ok' && phase === 'orphans') {
        await engine.putPage(HEALTHY, { type: 'note', title: HEALTHY, compiled_truth: `pass ${calls.length}` }, { sourceId: SOURCE, allowEmptyOverwrite: true });
      }
      return { schema_version: '1', timestamp: new Date().toISOString(), duration_ms: 1, status: result.status === 'fail' ? 'failed' : 'ok',
        phases: [result], totals: {} } as unknown as CycleReport;
    };
    const pass = (phases = PHASES) => makeAutopilotGlobalMaintenanceHandler(engine, { runCycle: runCycle as never })(
      { id: ++jobId, attempts_made: 0, signal: undefined, deadlineAtMs: null, data: { phases, repoPath: null } } as never) as Promise<any>;
    const stamped = () => engine.getConfig(LAST_GLOBAL_AT_KEY);
    const progress = () => readGlobalMaintenanceProgress(engine) as Promise<any>;
    const purgeRuns = () => calls.filter(p => p === 'purge').length;
    const stalledCheck = async () => {
      const entry = DOCTOR_CHECK_REGISTRY.find(e => e.name === 'global_maintenance_stalled');
      expect(entry).toBeDefined();
      const checks = await entry!.run({ engine, args: [], jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'all', orphanRatioSourceId: undefined } as unknown as DoctorContext);
      return (checks as Check[]).find(c => c.name === 'global_maintenance_stalled')!;
    };
    const patchStreak = async (phase: string, patch: Record<string, unknown>) => {
      const p = await progress();
      p.failures[phase] = { ...p.failures[phase], ...patch };
      await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify(p));
    };

    test('a phase failing the same way in three passes stops withholding the stamp; the healthy phase keeps landing', async () => {
      outcomes.purge = fail('invalid_data');
      const before = await snapshotItems(engine, SOURCE);
      for (let n = 1; n <= 3; n++) {
        const result = await expectUnitNotAborted(() => pass());
        expect({ n, stamped: await stamped(), bypassed: result.pass_completed_with_failing_phase ?? null }).toEqual({ n, stamped: null, bypassed: null });
      }
      const fourth = await expectUnitNotAborted(() => pass());
      expect(await stamped()).not.toBeNull();
      expect(fourth.pass_completed_with_failing_phase).toEqual([expect.objectContaining({ phase: 'purge', key: 'fail:invalid_data', count: 3 })]);
      const streak = (await progress()).failures.purge;
      expect(streak).toMatchObject({ key: 'fail:invalid_data', count: 3 });
      expectItemFailure({ key: 'purge', code: streak.key.slice('fail:'.length), fix: fourth.phase_streaks[0].fix },
        { key: 'purge', code: 'invalid_data', fix: /gbrain autopilot --retry-global --phase purge/ });
      expect(Date.parse(streak.retry_at)).toBeGreaterThan(Date.now());
      expect(fourth.report.phases.find((p: PhaseResult) => p.phase === 'purge'))
        .toMatchObject({ status: 'skipped', details: { reason: 'phase_backoff', blocker: 'fail:invalid_data' } });
      expect(purgeRuns()).toBe(3);
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: [HEALTHY] });

      const check = await stalledCheck();
      expect(check.status).toBe('warn');
      expect(check.message).toContain('purge');
      expect(check.message).toContain('invalid_data');
      expect(JSON.stringify(check.fix)).toContain('"dream","--phase","purge"');

      const home = mkdtempSync(join(tmpdir(), 'gbrain-stall-status-'));
      expect((await runCli(['autopilot', '--status', '--json'], { home })).exitCode).toBe(0);
      const { recordGlobalMaintenanceStallStatus } = await import('../../src/core/minions/global-maintenance-stall.ts');
      await withEnv({ GBRAIN_HOME: home }, () => recordGlobalMaintenanceStallStatus(engine));
      const status = await runCli(['autopilot', '--status', '--json'], { home });
      expect({ exit: status.exitCode, stall: JSON.parse(status.stdout).global_maintenance?.status }).toEqual({ exit: 1, stall: 'warn' });
    }, 120_000);

    test('after the back-off elapses the phase is retried; a pass that still fails stamps and doubles the back-off', async () => {
      outcomes.purge = fail('invalid_data');
      for (let n = 0; n < 3; n++) await pass();
      await patchStreak('purge', { retry_at: new Date(Date.now() - 1000).toISOString() });
      const fifth = await pass();
      expect(purgeRuns()).toBe(4);
      expect(await stamped()).not.toBeNull();
      expect(fifth.pass_completed_with_failing_phase[0]).toMatchObject({ phase: 'purge', count: 4 });
      const streak = (await progress()).failures.purge;
      expect(Date.parse(streak.retry_at) - Date.parse(streak.last_at)).toBe(4 * 60 * 60_000);
    }, 120_000);

    test('budget, deferral and child blockers never stop withholding the stamp', async () => {
      const cases: Array<[string, Outcome, string]> = [
        ['synthesize', { status: 'ok', details: { reason: 'insufficient_cycle_budget' } }, 'budget'],
        ['synthesize', { status: 'ok', details: { triage: { deferred: 2 } } }, 'deferred'],
        ['patterns', { status: 'warn', details: { child_outcome: 'timeout' } }, 'child:timeout'],
      ];
      for (const [phase, outcome, key] of cases) {
        await resetState();
        outcomes = { [phase]: outcome };
        for (let n = 0; n < 5; n++) {
          const result = await expectUnitNotAborted(() => pass(['orphans', phase]));
          expect({ key, n, stamped: await stamped(), bypassed: result.pass_completed_with_failing_phase ?? null }).toEqual({ key, n, stamped: null, bypassed: null });
        }
        expect((await progress()).failures[phase]).toMatchObject({ key });
      }
    }, 120_000);

    test('a run-scoped failure at the phase loop stops the job and records no streak', async () => {
      for (const { name, error } of runScopedErrors()) {
        await resetState();
        outcomes = { purge: () => { throw error(); } };
        await expect(pass()).rejects.toBeDefined();
        expect({ name, streaks: (await progress()).failures ?? {}, stamped: await stamped() }).toEqual({ name, streaks: {}, stamped: null });
      }
      for (const code of ['08006', '25P02']) {
        await resetState();
        outcomes = { purge: fail(code) };
        await expect(pass()).rejects.toBeDefined();
        expect({ code, streaks: (await progress()).failures ?? {}, stamped: await stamped() }).toEqual({ code, streaks: {}, stamped: null });
      }
    }, 120_000);

    test('most phases failing in one job trips item_failures_systemic and persists no streak', async () => {
      const phases = MAINTENANCE_PHASES.slice(0, 6) as string[];
      outcomes = Object.fromEntries(phases.map(p => [p, fail('phase_exploded')]));
      await expect(pass(phases)).rejects.toMatchObject({ code: 'item_failures_systemic' });
      expect({ streaks: (await progress()).failures ?? {}, stamped: await stamped() }).toEqual({ streaks: {}, stamped: null });
    }, 120_000);

    test('the back-off resets on a gbrain version change, and the retried phase lands', async () => {
      outcomes.purge = fail('invalid_data');
      for (let n = 0; n < 3; n++) await pass();
      await patchStreak('purge', { version: '0.0.1' });
      delete outcomes.purge;
      await pass();
      expect(purgeRuns()).toBe(4);
      expect({ streak: (await progress()).failures.purge ?? null, stamped: (await stamped()) !== null }).toEqual({ streak: null, stamped: true });
    }, 120_000);

    test('the back-off resets when the blocker key changes', async () => {
      outcomes.purge = fail('invalid_data');
      for (let n = 0; n < 3; n++) await pass();
      await patchStreak('purge', { retry_at: new Date(Date.now() - 1000).toISOString() });
      outcomes.purge = fail('page_not_found');
      const result = await pass();
      const streak = (await progress()).failures.purge;
      expect({ key: streak.key, count: streak.count, retry_at: streak.retry_at ?? null }).toEqual({ key: 'fail:page_not_found', count: 1, retry_at: null });
      expect({ stamped: await stamped(), bypassed: result.pass_completed_with_failing_phase ?? null }).toEqual({ stamped: null, bypassed: null });
    }, 120_000);

    test('gbrain autopilot --retry-global --phase ends the back-off and keeps the streak count', async () => {
      outcomes.purge = fail('invalid_data');
      for (let n = 0; n < 3; n++) await pass();
      const { runAutopilotRetryGlobal } = await import('../../src/commands/autopilot-retry-global.ts');
      await runAutopilotRetryGlobal(engine, ['--retry-global', '--phase', 'purge']);
      const streak = (await progress()).failures.purge;
      expect({ count: streak.count, retry_at: streak.retry_at ?? null }).toEqual({ count: 3, retry_at: null });
      delete outcomes.purge;
      await pass();
      expect(purgeRuns()).toBe(4);
      expect({ streak: (await progress()).failures.purge ?? null, stamped: (await stamped()) !== null }).toEqual({ streak: null, stamped: true });
    }, 120_000);

    test('doctor global_maintenance_stalled: a stale stamp with failed dispatches warns, then fails after a week', async () => {
      expect((await stalledCheck()).status).toBe('ok');
      await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString());
      expect((await stalledCheck()).status).toBe('ok');
      const queue = new MinionQueue(engine);
      for (let i = 0; i < 5; i++) {
        const job = await queue.add('autopilot-global-maintenance', {}, { idempotency_key: `stalled-${i}` });
        await engine.executeRaw(`UPDATE minion_jobs SET status = 'dead', error_text = 'SYNTH_PHASE_FAIL synthesize postprocess refused',
          finished_at = now() - make_interval(mins => $1::int) WHERE id = $2`, [60 - i, job.id]);
      }
      const warn = await stalledCheck();
      expect(warn.status).toBe('warn');
      expect(warn.message).toContain('SYNTH_PHASE_FAIL');
      expect(JSON.stringify(warn.fix)).toContain('"jobs","get"');
      await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString());
      expect((await stalledCheck()).status).toBe('fail');
      await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date().toISOString());
      expect((await stalledCheck()).status).toBe('ok');
    }, 120_000);
  });
}
