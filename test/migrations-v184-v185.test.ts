import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { getFtsLanguage } from '../src/core/fts-language.ts';
import { verifyEmbeddedHashStatistics } from '../src/core/search/embedded-hash-statistics.ts';
import { createConnectorFixture } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

describe('search planner migrations v184/v185', () => {
  test('generated vector search SQL uses the statistics-aware IS TRUE predicate', async () => {
    for (const engine of fixture.engines) {
      const queries: string[] = [];
      const [column] = await engine.executeRaw<{ dimensions: number }>(
        `SELECT atttypmod AS dimensions FROM pg_attribute
         WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
      );
      const search = () => engine.searchVector(new Float32Array(column.dimensions).fill(0.1), {
        embeddingColumn: { name: 'embedding', type: 'vector', dimensions: column.dimensions, embeddingModel: 'synthetic:model' },
        requireSafeChunks: true,
      });
      if (engine instanceof PGLiteEngine) {
        const transaction = engine.db.transaction;
        engine.db.transaction = callback => transaction(tx => callback(new Proxy(tx, {
          get(target, key) {
            if (key === 'query') return (sql: string, ...args: unknown[]) => {
              queries.push(sql);
              return Reflect.apply(target.query, target, [sql, ...args]);
            };
            return Reflect.get(target, key, target);
          },
        })));
        try { await search(); }
        finally { engine.db.transaction = transaction; }
      } else if (engine instanceof PostgresEngine) {
        const debug = engine.sql.options.debug;
        engine.sql.options.debug = (_connection, query) => { queries.push(query); };
        try { await search(); }
        finally { engine.sql.options.debug = debug; }
      }
      const query = queries.find(sql => /WITH\s+hnsw_candidates AS/.test(sql));
      expect(query).toBeDefined();
      expect(query).toContain('((cc.embedded_text_hash = md5(cc.chunk_text)) IS TRUE OR cc.embedded_text_hash IS NULL)');
    }
  }, 60_000);

  test('registered migrations declare bounded statistics SQL and an online index build', () => {
    const statistics = MIGRATIONS.find(m => m.version === 184);
    const index = MIGRATIONS.find(m => m.version === 185);
    expect(statistics?.name).toBe('embedded_hash_planner_statistics');
    expect(statistics?.idempotent).toBe(true);
    expect(statistics?.sql).toContain('CREATE STATISTICS IF NOT EXISTS content_chunks_embedded_hash_current_stats');
    expect(statistics?.sqlFor?.postgres).toContain("SET LOCAL statement_timeout = '30s'");
    expect(statistics?.sqlFor?.postgres).toContain("SET LOCAL lock_timeout = '2s'");
    expect(index?.name).toBe('pages_title_fts_index');
    expect(index?.idempotent).toBe(true);
    expect(index?.transaction).toBe(false);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(185);
  });

  test('fresh initialization, existing objects and replay all converge without duplicate indexes', async () => {
    for (const engine of fixture.engines) {
      await verifyEmbeddedHashStatistics(engine);
      await engine.setConfig('version', '183');
      const result = await runMigrations(engine);
      expect(result.applied).toBe(MIGRATIONS.filter(m => m.version > 183).length);
      expect(result.current).toBe(LATEST_VERSION);
      expect((await runMigrations(engine)).applied).toBe(0);
      await verifyEmbeddedHashStatistics(engine);
      const rows = await engine.executeRaw<{ definition: string; valid: boolean }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
         FROM pg_index i WHERE i.indexrelid = to_regclass($1)`, [`idx_pages_title_fts_${getFtsLanguage()}`],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].valid).toBe(true);
      expect(rows[0].definition).toContain(`to_tsvector('${getFtsLanguage()}'::regconfig, COALESCE(title, ''::text))`);
    }
  }, 60_000);

  test('wrong statistics never advance the migration ledger; retry repairs missing objects', async () => {
    for (const engine of fixture.engines) {
      await engine.executeRaw('DROP STATISTICS content_chunks_embedded_hash_current_stats');
      await engine.executeRaw(`CREATE STATISTICS content_chunks_embedded_hash_current_stats
        ON ((embedded_text_hash IS NULL)) FROM content_chunks`);
      await engine.setConfig('version', '183');
      await expect(runMigrations(engine)).rejects.toThrow('wrong definition');
      expect(await engine.getConfig('version')).toBe('183');
      await engine.executeRaw('DROP STATISTICS content_chunks_embedded_hash_current_stats');
      await engine.executeRaw(`DROP INDEX idx_pages_title_fts_${getFtsLanguage()}`);
      await runMigrations(engine);
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      await verifyEmbeddedHashStatistics(engine);
    }
  }, 60_000);
});
