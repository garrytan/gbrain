/**
 * #7776: initSchema replays the binary's whole schema (CREATE OR REPLACE FUNCTION ...) before runMigrations. On a
 * database a newer gbrain migrated, an older binary's replay reinstalled its own superseded function bodies (the
 * writer-fence guards among them) and then applied nothing. initSchema now refuses with client_behind before anything
 * in the schema runs; apply-migrations refuses the same way before any orchestrator and before a forced schema run
 * (whose drift repairs would otherwise rewrite the newer schema's links_link_source_check). PGLite (the default keyless, repo-less brain); a cold on-disk engine, because a loaded test
 * snapshot skips the replay. Postgres: test/e2e/init-schema-client-behind-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { schemaAheadRefusal } from '../src/commands/apply-migrations-schema.ts';
import { schemaFunctionBodyDrift } from '../src/commands/doctor/checks/schema-function-bodies.ts';
import { forceSchemaRun, functionBody, installNewerBody, installNewerLinkSourceCheck, linkSourceCheckDef, NEWER_BODY_MARKER } from './helpers/guard-body-drift.ts';

const GUARD = 'gbrain_require_managed_writer';

describe('initSchema on a database newer than the binary (#7776, PGLite)', () => {
  let dir: string;
  let engine: PGLiteEngine;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-client-behind-'));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(dir, 'brain.pglite') });
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await engine?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('refuses client_behind and leaves the newer guard body and the version alone', async () => {
    await installNewerBody(engine, GUARD);
    await engine.setConfig('version', String(LATEST_VERSION + 1));
    const error = await engine.initSchema().then(() => null, (e: unknown) => e as { code?: string; fix?: { argv?: string[]; actor?: string } });
    expect(await functionBody(engine, GUARD)).toContain(NEWER_BODY_MARKER);
    expect(error?.code).toBe('client_behind');
    expect(error?.fix).toMatchObject({ argv: ['gbrain', 'upgrade'], actor: 'host_admin' });
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION + 1));
  }, 60_000);

  test('apply-migrations reads the closed datastore and refuses before any orchestrator runs', async () => {
    await engine.disconnect();
    try {
      const refusal = await schemaAheadRefusal({ engine: 'pglite', database_path: join(dir, 'brain.pglite') } as GBrainConfig, null);
      expect(refusal?.code).toBe('client_behind');
      expect(await schemaAheadRefusal({ engine: 'postgres' } as GBrainConfig, LATEST_VERSION)).toBeNull();
    } finally {
      await engine.connect({ database_path: join(dir, 'brain.pglite') });
    }
  }, 60_000);

  test('apply-migrations --force-schema refuses client_behind and its drift repair leaves the newer constraint alone', async () => {
    await installNewerLinkSourceCheck(engine);
    const before = await linkSourceCheckDef(engine);
    await engine.disconnect();
    try {
      const home = join(dir, 'home');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'brain.pglite') }));
      const run = await forceSchemaRun(home);
      expect(run.doc?.code ?? run.out).toBe('client_behind');
      expect(run.exitCode).not.toBe(0);
    } finally {
      await engine.connect({ database_path: join(dir, 'brain.pglite') });
    }
    expect(await linkSourceCheckDef(engine)).toBe(before);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION + 1));
  }, 120_000);

  test('at head the doctor check names the drifted body, and the replay of this binary clears it', async () => {
    await engine.setConfig('version', String(LATEST_VERSION));
    expect(await schemaFunctionBodyDrift(engine)).toMatchObject({ status: 'checked', differing: [GUARD] });
    await engine.initSchema();
    expect(await functionBody(engine, GUARD)).not.toContain(NEWER_BODY_MARKER);
    expect(await schemaFunctionBodyDrift(engine)).toMatchObject({ status: 'checked', differing: [] });
  }, 60_000);
});
