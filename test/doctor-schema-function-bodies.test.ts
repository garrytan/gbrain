/**
 * schema_function_bodies doctor check (#7776): every function this gbrain's schema defines has this gbrain's body.
 * An older gbrain's initSchema replay reinstalls its superseded bodies over a newer schema; the check names each one.
 * Read-only. The cold replay that clears it is in test/init-schema-client-behind.test.ts; Postgres in
 * test/e2e/init-schema-client-behind-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { schemaFunctionBodiesEntry, schemaFunctionBodyDrift } from '../src/commands/doctor/checks/schema-function-bodies.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { installNewerBody } from './helpers/guard-body-drift.ts';

describe('schema_function_bodies doctor check (#7776)', () => {
  let engine: PGLiteEngine;
  const run = async () => ((await schemaFunctionBodiesEntry.run({ engine, progress: { heartbeat: () => {} } } as unknown as DoctorContext)) as Check[])[0]!;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('a fresh install matches every body', async () => {
    const drift = await schemaFunctionBodyDrift(engine);
    expect(drift.status).toBe('checked');
    if (drift.status !== 'checked') return;
    expect(drift.differing).toEqual([]);
    expect(drift.checked).toBeGreaterThanOrEqual(5);
    expect((await run()).status).toBe('ok');
  });

  test('a drifted guard body fails, names the function and points at the replay', async () => {
    await installNewerBody(engine, 'gbrain_guard_effect_protocol');
    await installNewerBody(engine, 'gbrain_count_git_canonical_sources');
    const check = await run();
    expect(check.status).toBe('fail');
    expect(check.message).toContain('gbrain_count_git_canonical_sources, gbrain_guard_effect_protocol');
    expect(check.details).toMatchObject({ differing: ['gbrain_count_git_canonical_sources', 'gbrain_guard_effect_protocol'] });
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'init', '--migrate-only'] });
  });

  test('skips when the brain is newer than this binary or has migrations pending', async () => {
    await engine.setConfig('version', String(LATEST_VERSION + 1));
    expect(await schemaFunctionBodyDrift(engine)).toEqual({ status: 'skipped', reason: 'client_behind', version: LATEST_VERSION + 1, latest: LATEST_VERSION });
    expect((await run()).status).toBe('ok');
    await engine.setConfig('version', String(LATEST_VERSION - 1));
    expect(await schemaFunctionBodyDrift(engine)).toEqual({ status: 'skipped', reason: 'migrations_pending', version: LATEST_VERSION - 1, latest: LATEST_VERSION });
    await engine.setConfig('version', String(LATEST_VERSION));
  });
});
