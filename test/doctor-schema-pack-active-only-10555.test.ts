/**
 * #10555: the local doctor registry had no entry for schema_pack_active (only the remote run_doctor report ran it), so
 * `gbrain doctor --only schema_pack_active` returned the "No finding" placeholder instead of running the check.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { doctorCheckNames } from '../src/commands/doctor/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-10555-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('doctor --only schema_pack_active (#10555)', () => {
  test('the local registry emits it', () => {
    expect(doctorCheckNames().has('schema_pack_active')).toBe(true);
  });

  test('selecting it runs the check instead of the no-finding placeholder', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const checks = await buildChecks(engine, ['--only', 'schema_pack_active', '--json']);
      const check = checks.find(c => c.name === 'schema_pack_active');
      expect(check?.message).not.toMatch(/^No finding|^Not run/);
      expect(check).toMatchObject({ status: 'ok' });
      expect(check!.message).toStartWith('Active pack: ');
    });
  }, 60_000);
});
