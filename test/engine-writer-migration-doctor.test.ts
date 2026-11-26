/**
 * v332 (engine_writer_observations) on a brain that never turns on shadow mode.
 *
 * Protects: `gbrain doctor --json` on a fresh brain with no shadow does not flag the three empty evidence tables or
 * gbrain_note_writer() (no check that names engine_writer_* or the function reports anything but ok); the
 * pinned Postgres doctor golden says the same. Fails when a doctor check starts reading the unused tables as drift,
 * an orphan or a missing hook. Postgres migration locks and idempotency: test/e2e/engine-writer-migration.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDoctorHome, runGbrain, type DoctorHome } from './helpers/doctor-json-golden.ts';

const homes: DoctorHome[] = [];
afterAll(() => { for (const h of homes) h.cleanup(); });

interface Check { name?: string; status?: string; message?: string; detail?: unknown }

function flagged(checks: Check[]): Check[] {
  return checks.filter(c => /engine_writer|gbrain_note_writer|gbrain_writer_note/.test(JSON.stringify(c)) && c.status !== 'ok' && c.status !== 'pass' && c.status !== 'skip' && c.status !== 'not_applicable');
}

describe('doctor on a brain with no shadow', () => {
  test('the filter can find a positive: a warning naming an evidence table is flagged, an ok one is not', () => {
    expect(flagged([{ name: 'x', status: 'warn', message: 'engine_writer_sessions is missing' }])).toHaveLength(1);
    expect(flagged([{ name: 'x', status: 'fail', detail: { function: 'gbrain_note_writer' } }])).toHaveLength(1);
    expect(flagged([{ name: 'x', status: 'ok', message: 'engine_writer_sessions present' }, { name: 'y', status: 'warn', message: 'something else' }])).toEqual([]);
  });

  test('no check names the empty writer evidence tables as a warning or failure (live PGLite brain)', async () => {
    const h = makeDoctorHome('writer-migration-doctor');
    homes.push(h);
    const init = await runGbrain(h, ['init', '--pglite', '--no-embedding']);
    expect(init.exitCode).toBe(0);
    const run = await runGbrain(h, ['doctor', '--json', '--skills-dir', h.skillsDir]);
    const report = run.json as { checks?: Check[] } | null;
    expect(Array.isArray(report?.checks)).toBe(true);
    expect(report!.checks!.length).toBeGreaterThan(10);
    expect(flagged(report!.checks!)).toEqual([]);
  }, 180_000);

  test('the pinned Postgres doctor golden has no such check either', () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/goldens/doctor/json-postgres-fresh.json'), 'utf8')) as { golden: { report: { checks: Check[] } } };
    expect(golden.golden.report.checks.length).toBeGreaterThan(10);
    expect(flagged(golden.golden.report.checks)).toEqual([]);
  });
});
