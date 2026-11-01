/**
 * Protects report completeness when --only requests a check skipped by the
 * actual fast-mode database gate. The positive control runs the selected
 * synthetic entry without the gate; the regression runs the same registry
 * with the gate and expects its not-run result to be marked unknown.
 * This exercises registry and report behavior without an engine or environment
 * changes.
 */
import { expect, test } from 'bun:test';
import { computeDoctorReport } from '../src/commands/doctor.ts';
import { dbChecksGateEntry } from '../src/commands/doctor/checks/db-connection.ts';
import type { DoctorContext, DoctorEntry } from '../src/commands/doctor/context.ts';
import { runDoctorRegistry } from '../src/commands/doctor/registry.ts';
import { createProgress } from '../src/core/progress.ts';

function context(fastMode: boolean): DoctorContext {
  return {
    engine: null,
    args: ['--fast', '--only', 'persistence_capacity'],
    jsonOutput: true,
    fastMode,
    doFix: false,
    dryRun: false,
    scope: 'brain',
    orphanRatioSourceId: undefined,
    progress: createProgress({ mode: 'quiet' }),
    skillsDirResolution: { dir: null, source: 'none' },
    skillsDir: null,
    autoFixReport: null,
    schemaVersion: 0,
    connectionFailed: false,
    only: new Set(['persistence_capacity']),
    tier: 'standard',
  };
}

const selectedCheck: DoctorEntry = {
  name: 'persistence_capacity',
  emits: ['persistence_capacity'],
  run: async () => [{ name: 'persistence_capacity', status: 'ok', message: 'Synthetic measurement completed.' }],
};

test('a selected check skipped by the fast gate makes the doctor report incomplete', async () => {
  const run = { tier: 'standard' as const, startedAt: Date.now(), budgetMs: null };

  const control = await runDoctorRegistry(context(false), [selectedCheck]);
  const complete = computeDoctorReport(control, { run });
  expect(complete.complete).toBe(true);
  expect(complete.unknown_sections).toEqual([]);

  let error: unknown;
  let checks: Awaited<ReturnType<typeof runDoctorRegistry>> = [];
  try {
    checks = await runDoctorRegistry(context(true), [dbChecksGateEntry, selectedCheck]);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeUndefined();
  expect(checks).toHaveLength(1);
  expect(checks[0].message).toStartWith('Not run:');

  const report = computeDoctorReport(checks, { run });
  expect(report.complete).toBe(false);
  expect(report.unknown_sections).toContain('persistence_capacity');
});
