/**
 * #6855: the hot-check doctor goldens (PGLite + Postgres twins) must carry the
 * `apple_permissions` entry in the position `buildChecks` renders it, with the
 * structural fields `buildChecks` renders for a brain without Apple sources.
 *
 * Narrow on purpose: it does not re-pin the volatile or environment-bound
 * parts of the goldens (timings, byte counts, timezone offsets); the goldens'
 * own tests do that. Zero-network, synthetic data, in-memory PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks, computeDoctorReport } from '../src/commands/doctor.ts';

type GoldenCheck = { name: string; category?: string; status: string; message?: string; details?: unknown; elapsed_ms?: unknown };
const GOLDENS = ['hot-checks-pglite-json', 'hot-checks-postgres-json'] as const;

function goldenChecks(file: string, run: 'first' | 'second'): GoldenCheck[] {
  const path = join(import.meta.dir, 'fixtures/goldens/doctor', `${file}.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { golden: Record<'first' | 'second', { report: { checks: GoldenCheck[] } }> };
  return parsed.golden[run].report.checks;
}

const withoutTiming = ({ elapsed_ms: _timing, ...rest }: GoldenCheck & Record<string, unknown>) => rest;

let engine: PGLiteEngine;
let rendered: GoldenCheck[] = [];
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  rendered = computeDoctorReport(await buildChecks(engine, [])).checks as GoldenCheck[];
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('hot-check doctor goldens carry the rendered apple_permissions entry', () => {
  test('buildChecks renders apple_permissions once, between google_calendar_readable and atom_retirements_restorable', () => {
    const names = rendered.map((c) => c.name);
    expect(names.filter((n) => n === 'apple_permissions')).toHaveLength(1);
    const at = names.indexOf('apple_permissions');
    expect(names[at - 1]).toBe('google_calendar_readable');
    expect(names[at + 1]).toBe('atom_retirements_restorable');
  });

  for (const file of GOLDENS) {
    for (const run of ['first', 'second'] as const) {
      test(`${file} (${run} run): one apple_permissions entry, same neighbours and same fields as buildChecks`, () => {
        const checks = goldenChecks(file, run);
        const names = checks.map((c) => c.name);
        expect(names.filter((n) => n === 'apple_permissions')).toHaveLength(1);
        const at = names.indexOf('apple_permissions');
        expect(names[at - 1]).toBe('google_calendar_readable');
        expect(names[at + 1]).toBe('atom_retirements_restorable');

        const live = rendered.find((c) => c.name === 'apple_permissions') as GoldenCheck & Record<string, unknown>;
        expect(live).toBeDefined();
        expect(checks[at]).toMatchObject({ category: 'ops', status: 'ok', details: { count: 0, services: [] } });
        expect(withoutTiming(checks[at] as GoldenCheck & Record<string, unknown>)).toEqual(withoutTiming(live));
      });
    }
  }
});
