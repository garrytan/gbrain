import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { runSchemaTransition } from '../../src/core/embedding-migration.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { getEngine, hasDatabase, setupDB, setupLegacyEmbeddingDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('PostgreSQL fixture reset lifecycle', () => {
  beforeAll(async () => { await setupLegacyEmbeddingDB(); }, 120_000);
  afterAll(teardownDB);

  test('ordinary reset clears data, operator config and source sync identity without replaying a current ledger', async () => {
    const original = getEngine();
    await original.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('fixture-other','fixture-other','/fixture-other')");
    await original.executeRaw("UPDATE sources SET local_path='/fixture-default',last_commit='fixture-commit',last_sync_at=now() WHERE id='default'");
    await original.putPage('fixture-page', { type: 'note', title: 'Fixture', compiled_truth: 'Fixture content' });
    await original.addTag('fixture-page', 'fixture-tag');
    await original.setConfig('fixture.operator-setting', 'must-not-survive');
    const migrations = spyOn(PostgresEngine.prototype, 'runMigration');
    try {
      const reset = await setupDB();
      expect(migrations).not.toHaveBeenCalled();
      expect(await reset.getConfig('version')).toBe(String(LATEST_VERSION));
      expect(await reset.getConfig('fixture.operator-setting')).toBeNull();
      expect(await reset.getPage('fixture-page')).toBeNull();
      expect(await reset.executeRaw('SELECT tag FROM tags')).toEqual([]);
      expect(await reset.executeRaw("SELECT id FROM sources WHERE id<>'default'")).toEqual([]);
      expect(await reset.executeRaw("SELECT local_path,last_commit,last_sync_at FROM sources WHERE id='default'"))
        .toEqual([{ local_path: null, last_commit: null, last_sync_at: null }]);
    } finally { migrations.mockRestore(); }
  });

  test('explicit replay runs the cold migration chain and warm reset preserves its seeded defaults', async () => {
    const migrations = spyOn(PostgresEngine.prototype, 'runMigration');
    try {
      const reset = await setupDB({ replayMigrations: true });
      expect(migrations.mock.calls.length).toBeGreaterThan(0);
      expect(await reset.getConfig('version')).toBe(String(LATEST_VERSION));
      const defaults = async (engine: PostgresEngine) => ({
        config: await engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config ORDER BY key'),
        source: await engine.executeRaw("SELECT id,name,config,incarnation,chunker_version FROM sources WHERE id='default'"),
        persistence: await engine.executeRaw('SELECT singleton,brain_id,enabled FROM persistence_brain'),
        skills: await engine.executeRaw('SELECT singleton,serving_epoch,length(token_secret) AS secret_length FROM shared_skill_state'),
        clock: await engine.executeRaw('SELECT id,value FROM page_generation_clock'),
      });
      const seeded = await defaults(reset);
      expect(Object.fromEntries(seeded.config.map(row => [row.key, row.value]))).toMatchObject({
        version: String(LATEST_VERSION), schema_version: '1', chunk_strategy: 'semantic',
      });
      expect(seeded.source).toHaveLength(1);
      expect(seeded.persistence).toHaveLength(1);
      expect(seeded.skills).toHaveLength(1);
      expect(seeded.clock).toHaveLength(1);
      migrations.mockClear();
      expect(await defaults(await setupDB())).toEqual(seeded);
      expect(migrations).not.toHaveBeenCalled();
    } finally { migrations.mockRestore(); }
  });

  test('a missing ledger cannot be mistaken for an already-migrated fixture', async () => {
    await getEngine().unsetConfig('version');
    const migrations = spyOn(PostgresEngine.prototype, 'runMigration');
    try {
      const reset = await setupDB();
      expect(migrations.mock.calls.length).toBeGreaterThan(0);
      expect(await reset.getConfig('version')).toBe(String(LATEST_VERSION));
    } finally { migrations.mockRestore(); }
  });

  test('ordinary reset preserves custom vector shape while legacy reset deliberately restores it', async () => {
    const dimensions = (engine: PostgresEngine) => engine.executeRaw<{ dims: number }>(
      `SELECT a.atttypmod AS dims FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
        AND c.relname IN ('content_chunks','query_cache','facts','takes') AND a.attname='embedding'
        AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname`);
    try {
      await runSchemaTransition(getEngine(), 64);
      await getEngine().executeRaw('ALTER TABLE takes ALTER COLUMN embedding TYPE vector(64) USING NULL');
      expect((await dimensions(await setupDB())).map(row => row.dims)).toEqual([64, 64, 64, 64]);
      expect((await dimensions(await setupLegacyEmbeddingDB())).map(row => row.dims))
        .toEqual(Array(4).fill(LEGACY_EMBEDDING_CONFIG.embedding_dimensions));
    } finally { await setupLegacyEmbeddingDB(); }
  });

  test('legacy reset aligns stored embedding identity with its columns and later ordinary resets', async () => {
    const state = async (engine: PostgresEngine) => ({
      model: await engine.getConfig('embedding_model'),
      dimensions: await engine.getConfig('embedding_dimensions'),
      columns: (await engine.executeRaw<{ dims: number }>(
        `SELECT a.atttypmod AS dims FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
          AND c.relname IN ('content_chunks','query_cache','facts','takes') AND a.attname='embedding'
          AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname`)).map(row => row.dims),
    });
    try {
      await runSchemaTransition(getEngine(), 1024);
      await getEngine().executeRaw('ALTER TABLE takes ALTER COLUMN embedding TYPE vector(1024) USING NULL');
      await getEngine().setConfig('embedding_model', 'voyage:voyage-4');
      await getEngine().setConfig('embedding_dimensions', '1024');
      expect(await state(await setupDB())).toEqual({
        model: 'voyage:voyage-4', dimensions: '1024', columns: [1024, 1024, 1024, 1024],
      });
      const expected = {
        model: LEGACY_EMBEDDING_CONFIG.embedding_model,
        dimensions: String(LEGACY_EMBEDDING_CONFIG.embedding_dimensions),
        columns: Array(4).fill(LEGACY_EMBEDDING_CONFIG.embedding_dimensions),
      };
      expect(await state(await setupLegacyEmbeddingDB())).toEqual(expected);
      expect(await state(await setupDB())).toEqual(expected);
    } finally { await setupLegacyEmbeddingDB(); }
  });
});
