/**
 * GBRA-541 4a/4b: the upgrade-migration ledger lives under GBRAIN_HOME, so an empty one is a fresh brain only when the
 * brain's schema is new too. A brain an older release last opened, reopened with an empty ledger, gets doctor's
 * minions_migration warn naming the upgrade migrations; a brain created in this run, or one whose schema is already
 * current (a new or rebuilt GBRAIN_HOME), does not. Real PGLite engines on data dirs, isolated GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { MIGRATION_VERSIONS } from '../src/core/migration-ledger.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-ledger-'));
const olderDir = join(dir, 'older.pglite');
const currentDir = join(dir, 'current.pglite');

beforeAll(async () => {
  for (const dataDir of [olderDir, currentDir]) {
    const created = new PGLiteEngine();
    await created.connect({ database_path: dataDir });
    await created.initSchema();
    if (dataDir === olderDir) await created.setConfig('version', String(LATEST_SCHEMA_VERSION - 1));
    await created.disconnect();
  }
}, 240_000);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

async function minionsRow(engine: PGLiteEngine) {
  const home = mkdtempSync(join(dir, 'home-'));
  return withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () =>
    (await buildChecks(engine, ['--fast', '--json'])).find(c => c.name === 'minions_migration'));
}

describe('doctor on an existing brain with an empty upgrade ledger', () => {
  test('a brain an older release last opened gets the upgrade migrations that have not run on it', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: olderDir });
    try {
      expect(await hasPendingMigrations(engine)).toBe(true);
      const row = await minionsRow(engine);
      expect(row?.status).toBe('warn');
      expect(row?.message).toContain('have not run on this brain yet');
      expect((row?.details as { pending: string[] }).pending).toContain(MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1]!);
    } finally { await engine.disconnect(); }
  }, 120_000);

  test('a brain whose schema is already current stays quiet', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: currentDir });
    try {
      expect(await hasPendingMigrations(engine)).toBe(false);
      const row = await minionsRow(engine);
      expect(row?.message ?? '').not.toContain('have not run on this brain yet');
    } finally { await engine.disconnect(); }
  }, 120_000);

  test('a brain created in this run stays quiet', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const row = await minionsRow(engine);
      expect(row?.message ?? '').not.toContain('have not run on this brain yet');
    } finally { await engine.disconnect(); }
  }, 120_000);
});
