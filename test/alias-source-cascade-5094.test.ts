/**
 * #5094: alias rows follow their source.
 *
 * Protects: removing a source removes its page_aliases and slug_aliases rows
 * (ON DELETE CASCADE), and the upgrade that adds the foreign key first deletes
 * alias rows whose source is already gone, including on a managed brain whose
 * managed_writer_guard refuses ungranted deletes; live aliases survive.
 * Fails when: the alias tables have no FK to sources, or the orphan GC runs
 * without granting the orphan sources (writer_coordinator_required aborts
 * the upgrade).
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const aliasRows = async (engine: BrainEngine) => ({
  page: (await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM page_aliases ORDER BY source_id')).map(r => r.source_id),
  slug: (await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM slug_aliases ORDER BY source_id')).map(r => r.source_id),
});
const fks = (engine: BrainEngine) => engine.executeRaw<{ conname: string; convalidated: boolean; confdeltype: string }>(
  `SELECT conname, convalidated, confdeltype FROM pg_constraint WHERE conname IN ('page_aliases_source_fk', 'slug_aliases_source_fk') ORDER BY conname`);

async function insertAliases(engine: BrainEngine, sourceId: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify([sourceId])]);
    await tx.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ($1, 'context compiler', 'concepts/target')`, [sourceId]);
    await tx.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, 'concepts/old-target', 'concepts/target')`, [sourceId]);
  });
}

describe('unmanaged brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('removing a source cascades to its alias rows', async () => {
    expect(await fks(engine)).toEqual([
      { conname: 'page_aliases_source_fk', convalidated: true, confdeltype: 'c' },
      { conname: 'slug_aliases_source_fk', convalidated: true, confdeltype: 'c' },
    ]);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alias-probe', 'alias-probe')`);
    await insertAliases(engine, 'alias-probe');
    await insertAliases(engine, 'default');
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'alias-probe'`);
    expect(await aliasRows(engine)).toEqual({ page: ['default'], slug: ['default'] });
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`${backend}: a managed brain with orphan alias rows upgrades cleanly`, async () => {
    await managedBrain(async ({ engine }) => {
      for (const table of ['page_aliases', 'slug_aliases']) await engine.executeRaw(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_source_fk`);
      await insertAliases(engine, 'removed-source');
      await insertAliases(engine, 'default');
      const cascade = MIGRATIONS.find(m => m.name === 'alias_source_cascade')!.version;
      await engine.setConfig('version', String(cascade - 1));

      const { applied } = await runMigrations(engine);
      expect(applied).toBe(MIGRATIONS.filter(m => m.version >= cascade).length);
      expect(await aliasRows(engine)).toEqual({ page: ['default'], slug: ['default'] });
      expect((await fks(engine)).map(r => [r.conname, r.convalidated])).toEqual([['page_aliases_source_fk', true], ['slug_aliases_source_fk', true]]);
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    }, { databaseUrl });
  }, 120_000);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`${backend}: managed source removal takes its alias rows with it`, async () => {
    await managedBrain(async ({ engine, root }) => {
      const probe = join(root, '..', 'alias-probe'); mkdirSync(probe);
      await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'alias-probe', path: probe });
      await insertAliases(engine, 'alias-probe');
      await insertAliases(engine, 'default');
      expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'alias-probe', confirmDestructive: true })).toMatchObject({ state: 'committed' });
      expect(await aliasRows(engine)).toEqual({ page: ['default'], slug: ['default'] });
    }, { databaseUrl });
  }, 120_000);
}
