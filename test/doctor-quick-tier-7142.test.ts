/**
 * #7142: on a large brain most doctor checks reported unknown at the 90 s non-interactive budget, every run.
 *
 * - `--tier quick` runs only the ops and quick entries under a 10 s deadline and never a standard-only entry.
 * - Every other check reports its last known result with its age (a recorded fail stays a fail); a check with no
 *   result from the last 24 h is named, with the others like it, in one doctor_last_known warning, so the report is
 *   never healthy or complete on it.
 * - A standard entry that runs out of its budget reports its fresh last known checks instead of an unknown.
 * - Only brain-wide runs read or write the results (`--only` and source-scoped runs do neither).
 * - The doctor-refresh job records every standard database entry and no filesystem entry, and queues nothing;
 *   a quick run on Postgres queues one refresh per hour for the entries it could not report.
 *
 * Postgres arm: test/e2e/doctor-quick-tier-7142-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeDoctorReport, type Check } from '../src/commands/doctor.ts';
import { runDoctorRegistry, DOCTOR_CHECK_REGISTRY, doctorRefreshRegistry } from '../src/commands/doctor/registry.ts';
import { DOCTOR_TIERS, QUICK_BUDGET_MS_DEFAULT, entryRunsAt, parseBudgetMs, startDoctorDeadline } from '../src/commands/doctor/budget.ts';
import { LAST_KNOWN_OP, REFRESH_JOB, runDoctorRefresh } from '../src/commands/doctor/last-known.ts';
import { resolverHealthEntry } from '../src/commands/doctor/checks/skill-group.ts';
import { graphCoverageEntry } from '../src/commands/doctor/checks/graph-health.ts';
import type { DoctorContext, DoctorEntry, DoctorTier } from '../src/commands/doctor/context.ts';
import { help } from '../src/cli/help/doctor.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const noProgress = new Proxy({}, { get: () => () => undefined }) as DoctorContext['progress'];

function ctxFor(engine: BrainEngine, tier: DoctorTier, extra: Partial<DoctorContext> = {}): DoctorContext {
  const args = ['--json', '--tier', tier];
  return {
    engine, args, jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined,
    progress: noProgress, skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null, schemaVersion: 0,
    connectionFailed: false, only: null, tier, deadline: startDoctorDeadline(args), lastKnown: 'cli', ...extra,
  };
}

const ok = (name: string, message = 'fine'): Check => ({ name, status: 'ok', message });
let standardRuns = 0;
let slowStatus: Check['status'] = 'fail';
let slowDelayMs = 0;
const opsEntry: DoctorEntry = { name: 'ops_a', emits: ['ops_a'], tier: 'ops', run: async () => [ok('ops_a')] };
const quickEntry: DoctorEntry = { name: 'quick_a', emits: ['quick_a'], tier: 'quick', run: async () => [ok('quick_a')] };
const standardEntry: DoctorEntry = { name: 'slow_a', emits: ['slow_a', 'slow_b'], run: async () => {
  standardRuns++;
  if (slowDelayMs) await new Promise((r) => setTimeout(r, slowDelayMs));
  return [{ name: 'slow_a', status: slowStatus, message: 'two pages broke' }];
} };
const entries = [opsEntry, quickEntry, standardEntry];
const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name);

test('the CLI accepts every tier and --tier quick defaults to a 10 s deadline', () => {
  const tierFlag = help.flags?.find((f) => f.name === '--tier') as { values?: string[] } | undefined;
  expect(tierFlag?.values).toEqual([...DOCTOR_TIERS]);
  expect(parseBudgetMs(['--tier', 'quick'], 'quick')).toBe(QUICK_BUDGET_MS_DEFAULT);
  expect([entryRunsAt('quick', 'quick'), entryRunsAt('ops', 'quick'), entryRunsAt(undefined, 'quick'), entryRunsAt('quick', 'standard'), entryRunsAt('quick', 'ops')]).toEqual([true, true, false, true, false]);
});

for (const kind of testBackends()) {
  describe(`#7142 doctor quick tier and last known results (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => undefined;

    beforeAll(async () => {
      if (kind === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; close = pg.close;
      }
    }, 120_000);
    afterAll(async () => { await close(); });

    const clear = () => engine.executeRaw('DELETE FROM op_checkpoints WHERE op = $1', [LAST_KNOWN_OP]);
    const recorded = async () => (await engine.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op = $1 ORDER BY fingerprint', [LAST_KNOWN_OP])).map((r) => r.fingerprint);

    test('quick runs never run a standard entry; unmeasured checks are one unknown warning, then last known results with their status and age', async () => {
      await clear();
      standardRuns = 0; slowStatus = 'fail'; slowDelayMs = 0;
      const first = await runDoctorRegistry(ctxFor(engine, 'quick'), entries);
      expect(standardRuns).toBe(0);
      expect(first.map((c) => c.name)).toEqual(['ops_a', 'quick_a', 'doctor_last_known']);
      const unmeasured = byName(first, 'doctor_last_known')!;
      expect(unmeasured.status).toBe('warn');
      expect(unmeasured.details).toMatchObject({ health: 'unknown', unknown_checks: ['slow_a', 'slow_b'] });
      expect(unmeasured.message).toContain('never measured');
      const firstReport = computeDoctorReport(first, { run: { tier: 'quick', startedAt: Date.now(), budgetMs: QUICK_BUDGET_MS_DEFAULT } });
      expect(firstReport.status).not.toBe('healthy');
      expect(firstReport.complete).toBe(false);
      expect(firstReport.unknown_sections).toEqual(['slow_a', 'slow_b']);
      expect(await recorded()).toEqual([]);

      await runDoctorRegistry(ctxFor(engine, 'standard'), entries);
      expect(standardRuns).toBe(1);
      expect(await recorded()).toEqual(['ops_a', 'quick_a', 'slow_a']);

      const second = await runDoctorRegistry(ctxFor(engine, 'quick'), entries);
      expect(standardRuns).toBe(1);
      const served = byName(second, 'slow_a')!;
      expect(served.status).toBe('fail');
      expect(served.message).toMatch(/^Last known, under a minute ago \(not run by the quick tier\): two pages broke/);
      expect(served.details?.last_known).toMatchObject({ reason: 'not_in_tier' });
      expect(byName(second, 'doctor_last_known')).toBeUndefined();
      const secondReport = computeDoctorReport(second, { run: { tier: 'quick', startedAt: Date.now(), budgetMs: QUICK_BUDGET_MS_DEFAULT } });
      expect(secondReport.status).toBe('unhealthy');
      expect(secondReport.complete).toBe(false);
      expect(secondReport.last_known_sections).toEqual(['slow_a']);

      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,measured_at}', '"2020-01-01T00:00:00.000Z"') WHERE op = $1`, [LAST_KNOWN_OP]);
      const stale = await runDoctorRegistry(ctxFor(engine, 'quick'), entries);
      expect(byName(stale, 'slow_a')).toBeUndefined();
      expect(byName(stale, 'doctor_last_known')!.message).toContain('their last results are too old');
    }, 60_000);

    test('a standard entry that runs out of its budget reports its fresh last known checks instead of an unknown', async () => {
      await clear();
      slowStatus = 'warn'; slowDelayMs = 0;
      await runDoctorRegistry(ctxFor(engine, 'standard'), entries);
      slowDelayMs = 800;
      const checks = await runDoctorRegistry(ctxFor(engine, 'standard', { entryBudgetOverrideMs: 200 }), entries);
      const slow = checks.filter((c) => c.name === 'slow_a' || c.name === 'slow_b');
      expect(slow).toHaveLength(1);
      expect(slow[0]!.status).toBe('warn');
      expect(slow[0]!.details?.last_known).toMatchObject({ reason: 'budget' });
      expect(slow[0]!.message).toContain('not finished within this run\'s budget');
      slowDelayMs = 0;
    }, 60_000);

    test('a check a later release added to an entry is never hidden behind that entry\'s older last known result', async () => {
      await clear();
      slowStatus = 'warn'; slowDelayMs = 0;
      await runDoctorRegistry(ctxFor(engine, 'standard'), entries);
      // The recorded result predates slow_new (an older release, which also stored no emits list).
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_build_array((completed_keys->0) - 'emits') WHERE op = $1 AND fingerprint = 'slow_a'`, [LAST_KNOWN_OP]);
      const grown: DoctorEntry = { ...standardEntry, emits: [...standardEntry.emits, 'slow_new'] };
      slowDelayMs = 800;
      const checks = await runDoctorRegistry(ctxFor(engine, 'standard', { entryBudgetOverrideMs: 200 }), [opsEntry, quickEntry, grown]);
      slowDelayMs = 0;
      expect(byName(checks, 'slow_a')!.details?.last_known).toMatchObject({ reason: 'budget' });
      expect(byName(checks, 'slow_new')).toMatchObject({ status: 'warn', details: { health: 'unknown', reason: 'budget' } });
      expect(byName(checks, 'slow_b')).toMatchObject({ details: { health: 'unknown', reason: 'budget' } });

      const quick = await runDoctorRegistry(ctxFor(engine, 'quick'), [opsEntry, quickEntry, grown]);
      expect(byName(quick, 'slow_a')!.details?.last_known).toMatchObject({ reason: 'not_in_tier' });
      expect(byName(quick, 'doctor_last_known')!.details).toMatchObject({ unknown_checks: ['slow_b', 'slow_new'] });

      await runDoctorRegistry(ctxFor(engine, 'standard'), [opsEntry, quickEntry, grown]);
      slowDelayMs = 800;
      const recordedNow = await runDoctorRegistry(ctxFor(engine, 'standard', { entryBudgetOverrideMs: 200 }), [opsEntry, quickEntry, grown]);
      slowDelayMs = 0;
      expect(recordedNow.filter(c => c.name.startsWith('slow_')).map(c => c.name)).toEqual(['slow_a']);
    }, 60_000);

    test('a check a later release moved to another entry is never served from the old entry\'s last known result', async () => {
      await clear();
      let moverDelayMs = 0;
      const before: DoctorEntry = { name: 'mover_a', emits: ['mover_a', 'mover_b'], run: async () => [ok('mover_a'), { name: 'mover_b', status: 'fail', message: 'old result' }] };
      await runDoctorRegistry(ctxFor(engine, 'standard'), [opsEntry, quickEntry, before]);
      const shrunk: DoctorEntry = { name: 'mover_a', emits: ['mover_a'], run: async () => {
        if (moverDelayMs) await new Promise((r) => setTimeout(r, moverDelayMs));
        return [ok('mover_a')];
      } };
      const moved: DoctorEntry = { name: 'mover_b', emits: ['mover_b'], run: async () => [ok('mover_b', 'fresh result')] };
      moverDelayMs = 800;
      const checks = await runDoctorRegistry(ctxFor(engine, 'standard', { entryBudgetOverrideMs: 200 }), [opsEntry, quickEntry, shrunk, moved]);
      moverDelayMs = 0;
      expect(byName(checks, 'mover_a')!.details?.last_known).toMatchObject({ reason: 'budget' });
      expect(checks.filter(c => c.name === 'mover_b')).toEqual([ok('mover_b', 'fresh result')].map(c => expect.objectContaining(c)));
      expect(byName(checks, 'mover_b')!.details?.last_known).toBeUndefined();
    }, 60_000);

    test('--only and source-scoped runs neither read nor write last known results', async () => {
      await clear();
      await runDoctorRegistry(ctxFor(engine, 'standard', { only: new Set(['slow_a']) }), entries);
      await runDoctorRegistry(ctxFor(engine, 'standard', { sourceIds: ['default'] }), entries);
      await runDoctorRegistry(ctxFor(engine, 'standard', { orphanRatioSourceId: 'default' }), entries);
      expect(await recorded()).toEqual([]);
      const scoped = await runDoctorRegistry(ctxFor(engine, 'quick', { sourceIds: ['default'] }), entries);
      expect(byName(scoped, 'doctor_last_known')).toBeUndefined();
    }, 60_000);

    test('the doctor-refresh job records every standard database entry, no filesystem entry, and queues nothing', async () => {
      await clear();
      const jobsBefore = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs WHERE name = $1', [REFRESH_JOB]))[0]!.n;
      const result = await runDoctorRefresh(engine);
      const rows = await recorded();
      expect(rows).toContain(graphCoverageEntry.name);
      expect(rows).not.toContain(resolverHealthEntry.name);
      const refreshNames = new Set(doctorRefreshRegistry().map((e) => e.name));
      expect(rows.every((r) => refreshNames.has(r))).toBe(true);
      expect(DOCTOR_CHECK_REGISTRY.indexOf(resolverHealthEntry)).toBeGreaterThanOrEqual(0);
      expect(result.recorded).toBeGreaterThan(0);
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs WHERE name = $1', [REFRESH_JOB]))[0]!.n).toBe(jobsBefore);
    }, 180_000);

    if (kind === 'postgres') {
      test('a quick run queues one background refresh per hour for the checks it could not report', async () => {
        await clear();
        await engine.executeRaw('DELETE FROM minion_jobs WHERE name = $1', [REFRESH_JOB]);
        const first = await runDoctorRegistry(ctxFor(engine, 'quick'), entries);
        await runDoctorRegistry(ctxFor(engine, 'quick'), entries);
        const jobs = await engine.executeRaw<{ id: number }>('SELECT id FROM minion_jobs WHERE name = $1', [REFRESH_JOB]);
        expect(jobs).toHaveLength(1);
        expect(byName(first, 'doctor_last_known')!.details?.refresh_job).toBe(Number(jobs[0]!.id));
      }, 60_000);
    }
  });
}
