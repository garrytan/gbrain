import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { createConnectorFixture } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

for (const { table, version, index } of [
  { table: 'facts', version: 45, index: 'idx_facts_embedding_hnsw' },
  { table: 'query_cache', version: 55, index: 'idx_query_cache_embedding_hnsw' },
]) {
  for (const { type, dimensions, indexed } of [
    { type: 'vector', dimensions: 8, indexed: true },
    { type: 'halfvec', dimensions: 8, indexed: true },
    { type: 'vector', dimensions: 2048, indexed: false },
    { type: 'halfvec', dimensions: 4096, indexed: false },
  ]) {
    test(`migration ${version} replay preserves existing ${type}(${dimensions}) rows and physical index policy`, async () => {
      for (const engine of fixture.engines) {
        await engine.executeRaw(`DELETE FROM ${table}`);
        await engine.executeRaw(`DROP INDEX IF EXISTS ${index}`);
        await engine.executeRaw(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE ${type}(${dimensions}) USING NULL`);
        await engine.setConfig('embedding_dimensions', '16');
        const vector = `[${Array(dimensions).fill('0.125').join(',')}]`;
        if (table === 'facts') {
          await engine.executeRaw(`INSERT INTO facts(source_id,fact,source,embedding)
            VALUES('default','Synthetic retained fact','synthetic-replay',$1::${type})`, [vector]);
        } else {
          await engine.executeRaw(`INSERT INTO query_cache(id,query_text,source_id,embedding,results)
            VALUES('synthetic-cache','Synthetic retained query','default',$1::${type},'[]'::jsonb)`, [vector]);
        }
        const snapshot = () => engine.executeRaw(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
        const before = await snapshot();
        expect(before).toHaveLength(1);
        const migration = MIGRATIONS.find(entry => entry.version === version)!;
        await migration.handler!(engine);
        const indexState = () => engine.executeRaw<{ oid: string; definition: string }>(
          `SELECT c.oid::text AS oid,pg_get_indexdef(c.oid) AS definition
             FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname=$1`, [index]);
        const firstIndex = await indexState();
        expect(firstIndex).toHaveLength(indexed ? 1 : 0);
        if (indexed) expect(firstIndex[0].definition).toContain(`${type}_cosine_ops`);
        await migration.handler!(engine);
        expect(await indexState()).toEqual(firstIndex);
        expect(await snapshot()).toEqual(before);
        expect(await engine.getConfig('embedding_dimensions')).toBe('16');
        const shape = await engine.executeRaw<{ shape: string }>(
          `SELECT format_type(a.atttypid,a.atttypmod) AS shape
             FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
             JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname=$1 AND a.attname='embedding'
              AND a.attnum>0 AND NOT a.attisdropped`, [table]);
        expect(shape).toEqual([{ shape: `${type}(${dimensions})` }]);
      }
    }, 60_000);
  }
  for (const shape of ['missing', 'text', 'vector']) {
    test(`migration ${version} refuses an existing ${shape} embedding shape without changing retained rows`, async () => {
      for (const engine of fixture.engines) {
        await engine.executeRaw(`DROP INDEX IF EXISTS ${index}`);
        await engine.executeRaw(`ALTER TABLE ${table} DROP COLUMN embedding`);
        if (shape !== 'missing') await engine.executeRaw(`ALTER TABLE ${table} ADD COLUMN embedding ${shape}`);
        const snapshot = () => engine.executeRaw(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
        const before = await snapshot();
        const ledger = await engine.getConfig('version');
        await expect(MIGRATIONS.find(entry => entry.version === version)!.handler!(engine))
          .rejects.toThrow(`Cannot replay ${table} migration`);
        expect(await snapshot()).toEqual(before);
        expect(await engine.getConfig('version')).toBe(ledger);
        expect(await engine.getConfig('embedding_dimensions')).toBe('16');
        await engine.executeRaw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS embedding`);
        await engine.executeRaw(`ALTER TABLE ${table} ADD COLUMN embedding vector(8)`);
      }
    }, 60_000);
  }
}
