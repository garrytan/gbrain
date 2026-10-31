/**
 * #8114: `gbrain doctor --fast --only <db check>` stops before the database checks, so the
 * selected check does not run. Its not-run placeholder must mark the report incomplete
 * (unknown health); a run that executes the same check stays complete.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks, computeDoctorReport } from '../src/commands/doctor.ts';
import { doctorRunSummary, startDoctorDeadline } from '../src/commands/doctor/budget.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function report(db: PGLiteEngine | null, args: string[]) {
  const deadline = startDoctorDeadline(args);
  const checks = await buildChecks(db, args, undefined, undefined, deadline);
  return computeDoctorReport(checks, { run: doctorRunSummary(args, deadline) });
}

test('a selected check the --fast early stop skipped leaves the report incomplete', async () => {
  const r = await report(null, ['--fast', '--json', '--only', 'persistence_capacity', '--budget-ms', '30000']);
  const check = r.checks.find((c) => c.name === 'persistence_capacity');
  expect(check?.message).toContain('Not run');
  expect(r.complete).toBe(false);
  expect(r.unknown_sections).toEqual(['persistence_capacity']);
});

test('control: the same selected check, run, keeps the report complete', async () => {
  const r = await report(engine, ['--json', '--only', 'persistence_capacity', '--budget-ms', '30000']);
  const check = r.checks.find((c) => c.name === 'persistence_capacity');
  expect(check?.message ?? '').not.toContain('Not run');
  expect(r.complete).toBe(true);
  expect(r.unknown_sections).toEqual([]);
});
