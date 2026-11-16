/**
 * GBRA-541 4a/4b: the upgrade-migration ledger lives under GBRAIN_HOME, so an empty one is a fresh brain only when the
 * brain's schema is new too. An existing brain reopened with an empty ledger (a new machine, or a brain used only through
 * `gbrain serve`) gets doctor's minions_migration warn naming the upgrade migrations; a brain created in this run does not.
 * Real PGLite engines on one data dir, isolated GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { MIGRATION_VERSIONS } from '../src/core/migration-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-ledger-'));
const dataDir = join(dir, 'brain.pglite');

beforeAll(async () => {
  const created = new PGLiteEngine();
  await created.connect({ database_path: dataDir });
  await created.initSchema();
  await created.disconnect();
}, 120_000);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

async function minionsRow(engine: PGLiteEngine) {
  const home = mkdtempSync(join(dir, 'home-'));
  return withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () =>
    (await buildChecks(engine, ['--fast', '--json'])).find(c => c.name === 'minions_migration'));
}

describe('doctor on an existing brain with an empty upgrade ledger', () => {
  test('reports the upgrade migrations that have not run on it', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    try {
      expect(await hasPendingMigrations(engine)).toBe(false);
      const row = await minionsRow(engine);
      expect(row?.status).toBe('warn');
      expect(row?.message).toContain('have not run on this brain yet');
      expect((row?.details as { pending: string[] }).pending).toContain(MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1]!);
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
