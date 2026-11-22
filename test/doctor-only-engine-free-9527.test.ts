/**
 * #9527: an engine-free `doctor --only` run stops at the database gate by design, so a requested check that emits
 * nothing reads "No finding", and no connection row claims a connect that was never tried. A connect that really
 * failed still marks the requested checks as stopped early and keeps its connection row.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChecks } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-9527-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

const rows = (engineArg: BrainEngine | null) => withEnv({ GBRAIN_HOME: home, GBRAIN_SKILLS_DIR: undefined, OPENCLAW_WORKSPACE: undefined },
  async () => (await buildChecks(engineArg, ['--only', 'skill_resolver'], 'config-file')).map(c => ({ name: c.name, message: c.message })));

test('engine-free --only: no connection row, and the empty check reads No finding', async () => {
  const checks = await rows(null);
  expect(checks.map(c => c.name)).toEqual(['skill_resolver']);
  expect(checks[0]!.message).toContain('No finding');
});

test('a connect that failed still reports the connection and the checks it stopped', async () => {
  const failing = new Proxy(engine, {
    get(target, key) {
      if (key === 'getStats') return async () => { throw new Error('connection terminated unexpectedly'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
  const checks = await rows(failing);
  expect(checks.map(c => c.name)).toEqual(['connection', 'skill_resolver']);
  expect(checks[1]!.message).toContain('stopped early');
});
