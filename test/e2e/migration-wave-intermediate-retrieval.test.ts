import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runSchemaTransition, readMigrationState } from '../../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow } from '../../src/commands/migrate-embeddings.ts';
import { migrationWaveFixture } from '../helpers/migration-wave-fixture.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';

const model = 'openai:text-embedding-3-small';
const oldModel = 'openai:text-embedding-3-large';
const vector = new Float32Array(8).fill(0.25);
for (const kind of ['pglite', 'postgres'] as const) {
  test.skipIf(kind === 'postgres' && !process.env.DATABASE_URL)(`${kind}: partial failed migration, reopened readers and resumed completion never mix vector generations`, async () => {
    const fixture = await migrationWaveFixture(kind);
    const engine = fixture.engine;
    const home = mkdtempSync(join(tmpdir(), 'migration-wave-retrieval-home-')); mkdirSync(join(home, '.gbrain'));
    try {
      await runSchemaTransition(engine, 8);
      await engine.setConfig('embedding_model', oldModel); await engine.setConfig('embedding_dimensions', '8');
      configureGateway({ embedding_model: oldModel, embedding_dimensions: 8, env: { OPENAI_API_KEY: 'synthetic-only' } });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: oldModel, embedding_dimensions: 8, openai_api_key: 'synthetic-only' }));
      for (const slug of ['synthetic-good-page', 'synthetic-failed-page']) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} canonical retained text` });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `${slug} canonical retained text`, model: oldModel, embedding: vector }]);
        await engine.setPageEmbeddingSignature(slug, { sourceId: 'default', signature: `${oldModel}:8` });
      }
      await engine.insertFact({ fact: 'synthetic-good-fact retained claim', entity_slug: 'synthetic-entity', source: 'synthetic', visibility: 'world', embedding: vector, embedding_model: oldModel }, { source_id: 'default' });
      const pages = async (identity: string) => (await engine.searchVector(vector, { sourceId: 'default', embeddingColumn: { name: 'embedding', type: 'vector', dimensions: 8, embeddingModel: identity } })).map(r => r.slug).sort();
      const duplicates = async (identity?: string) => (await engine.findCandidateDuplicates('default', 'synthetic-entity', 'unrelated cosine query', { embedding: vector, embeddingModel: identity })).map(r => r.fact).sort();
      expect(await pages(oldModel)).toHaveLength(2);
      expect(await pages(model)).toEqual([]);
      let added = false, failed = false;
      __setEmbedTransportForTests(async ({ values }) => {
        if (!added && values.some(v => v.includes('synthetic-good-fact'))) {
          added = true;
          await engine.insertFact({ fact: 'synthetic-late-fact retained claim', entity_slug: 'synthetic-entity', source: 'synthetic', visibility: 'world' }, { source_id: 'default' });
        }
        const embeddings = values.map(v => {
          if (v.includes('synthetic-failed-page')) { failed = true; return [0.25]; }
          return Array.from(vector);
        });
        return { values, warnings: [], embeddings, usage: { tokens: values.length * 8 } };
      });
      const flow = () => withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined }, async () => {
        const opts = { to: model, dim: 8, reranker: 'off', maxCostUsd: 1, quiet: true };
        return executeMigrationFlow(engine, await planMigrationFlow(engine, opts), opts);
      });
      const first = await flow();
      expect(first.status).toBe('incomplete'); expect(added).toBe(true); expect(failed).toBe(true);
      const checkpoint = async () => {
        expect(await pages(model)).toEqual(['synthetic-good-page']);
        expect(await pages(oldModel)).toEqual([]);
        expect(await duplicates(model)).toEqual(['synthetic-good-fact retained claim']);
        expect(await duplicates(oldModel)).toEqual([]);
        expect(await duplicates()).toEqual([]);
        expect((await engine.listFactsByEntity('default', 'synthetic-entity', { visibility: ['world'] })).map(f => f.fact).sort()).toEqual(['synthetic-good-fact retained claim', 'synthetic-late-fact retained claim']);
        expect((await readMigrationState(engine)).state).not.toBeNull();
        expect(await engine.getConfig('embedding_migration.completed')).toBeNull();
      };
      await checkpoint();
      const goodState = () => engine.executeRaw(`SELECT 'page' AS kind,c.embedding::text,c.embedded_at::text,c.embedded_text_hash FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug='synthetic-good-page'
        UNION ALL SELECT 'fact',embedding::text,embedded_at::text,embedded_text_hash FROM facts WHERE fact='synthetic-good-fact retained claim' ORDER BY kind`);
      const before = await goodState();
      const budget = (await readMigrationState(engine)).state!.budget!;
      await engine.disconnect();
      await engine.connect(kind === 'pglite' ? { database_path: fixture.database } : { database_url: fixture.database });
      resetGateway(); configureGateway({ embedding_model: model, embedding_dimensions: 8, env: { OPENAI_API_KEY: 'synthetic-only' } });
      await checkpoint();
      expect((await readMigrationState(engine)).state!.budget).toEqual(budget);
      __setEmbedTransportForTests(async ({ values }) => ({ values, warnings: [], embeddings: values.map(() => Array.from(vector)), usage: { tokens: values.length * 8 } }));
      expect((await flow()).status).toBe('completed');
      expect(await goodState()).toEqual(before);
      expect(await pages(model)).toEqual(['synthetic-failed-page', 'synthetic-good-page']);
      expect(await pages(oldModel)).toEqual([]);
      expect(await duplicates(model)).toEqual(['synthetic-good-fact retained claim', 'synthetic-late-fact retained claim']);
      expect(await duplicates(oldModel)).toEqual([]);
      expect((await readMigrationState(engine)).state).toBeNull();
    } finally { __setEmbedTransportForTests(null); resetGateway(); await fixture.close(); rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
}
