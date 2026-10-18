/**
 * #6303: `gbrain doctor --only <check>` for a check that a pre-gate entry only
 * emits with an engine must connect the engine. `onlyNeedsEngine` used to look
 * only past the DB-checks gate, so `--only dream_paid_loop` ran engine-free and
 * reported "Could not connect" / "Not run". Pre-gate entries now declare those
 * names in `engineChecks`; the drift guard below fails when a pre-gate entry
 * emits a name only with an engine and does not declare it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { DOCTOR_CHECK_REGISTRY, onlyNeedsEngine } from '../src/commands/doctor/registry.ts';
import { dbChecksGateEntry } from '../src/commands/doctor/checks/db-connection.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-only-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

const gate = DOCTOR_CHECK_REGISTRY.indexOf(dbChecksGateEntry);
const preGate = DOCTOR_CHECK_REGISTRY.slice(0, gate);
const postGate = new Set(DOCTOR_CHECK_REGISTRY.slice(gate + 1).flatMap((e) => e.emits));

describe('doctor --only engine need (#6303)', () => {
  test('engine-reading pre-gate checks need the engine', () => {
    for (const name of ['dream_paid_loop', 'connectors', 'extract_atoms_backlog', 'default_source_local_path', 'volunteer_channels']) {
      expect(`${name}:${onlyNeedsEngine(new Set([name]))}`).toBe(`${name}:true`);
    }
    expect(onlyNeedsEngine(new Set(['pglite_data_dir', 'supervisor', 'harness_wiring']))).toBe(false);
  });

  test('declared engine checks are names the entry emits', () => {
    for (const entry of DOCTOR_CHECK_REGISTRY) {
      for (const name of entry.engineChecks ?? []) expect(`${entry.name}:${entry.emits.includes(name)}`).toBe(`${entry.name}:true`);
    }
  });

  test('drift guard: every name a pre-gate entry emits only with an engine is declared', async () => {
    const names = preGate.flatMap((e) => e.emits).filter((n) => n !== 'connection');
    const args = ['--only', names.join(','), '--json'];
    const real = (checks: { name: string; message?: string }[]) => new Set(checks
      .filter((c) => !c.message?.startsWith('No finding') && !c.message?.startsWith('Not run'))
      .map((c) => c.name));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const without = real(await buildChecks(null, args));
      const withEngine = real(await buildChecks(engine, args));
      const undeclared = [...withEngine]
        .filter((n) => !without.has(n) && !postGate.has(n))
        .filter((n) => !onlyNeedsEngine(new Set([n])));
      expect(undeclared).toEqual([]);
    });
  });

  test('--only dream_paid_loop with an engine returns the real check', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const checks = await buildChecks(engine, ['--only', 'dream_paid_loop', '--json']);
      const check = checks.find((c) => c.name === 'dream_paid_loop')!;
      expect(check.status).toBe('ok');
      expect(check.message).not.toMatch(/^Not run|^No finding/);
    });
  });
});
