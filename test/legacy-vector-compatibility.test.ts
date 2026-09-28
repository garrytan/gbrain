import { afterAll, beforeAll, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow } from '../src/commands/migrate-embeddings.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { createConnectorFixture } from './helpers/connector-fixture.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

const fixture = createConnectorFixture();
const model = 'openai:text-embedding-3-small';
const dimensions = 8;
beforeAll(fixture.setup, 120_000);
afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await fixture.teardown();
});

test('legacy same-model NULL hashes stay searchable through failed migrations without trusting wrong generations or stale hashes', async () => withEnv({
  ...fixture.env, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
  GBRAIN_EMBEDDING_MODEL: model, GBRAIN_EMBEDDING_DIMENSIONS: String(dimensions),
}, async () => {
  for (const engine of fixture.engines) {
    await runSchemaTransition(engine, dimensions);
    await engine.setConfig('embedding_model', model);
    await engine.setConfig('embedding_dimensions', String(dimensions));
    resetGateway();
    configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
    const vector = new Float32Array(dimensions).fill(0.1);
    let providerDown = false;
    __setEmbedTransportForTests(async ({ values }) => {
      if (providerDown) throw new Error('Synthetic provider unavailable');
      return { values, warnings: [], embeddings: values.map(() => Array.from(vector)), usage: { tokens: 8 } };
    });
    for (const slug of ['current', 'legacy', 'wrong-model', 'unknown-model', 'stale-text']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Synthetic body for ${slug}.` });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Synthetic body for ${slug}.`, embedding: vector, model }]);
    }
    await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash=NULL WHERE page_id=(SELECT id FROM pages WHERE slug='legacy')");
    await engine.executeRaw("UPDATE content_chunks SET model='other:synthetic' WHERE page_id=(SELECT id FROM pages WHERE slug='wrong-model')");
    await engine.executeRaw("UPDATE content_chunks SET model='' WHERE page_id=(SELECT id FROM pages WHERE slug='unknown-model')");
    await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash=md5('obsolete synthetic text') WHERE page_id=(SELECT id FROM pages WHERE slug='stale-text')");
    const before = await engine.executeRaw('SELECT id,embedding::text,model,embedded_text_hash FROM content_chunks ORDER BY id');
    expect(await engine.searchKeyword('nonlexicalsaffronquery', { limit: 10 })).toEqual([]);
    expect((await engine.searchVector(vector, { embeddingColumn: { name: 'embedding', type: 'vector', dimensions, embeddingModel: model }, limit: 10 })).map(row => row.slug).sort())
      .toEqual(['current', 'legacy']);
    const query = async () => {
      const rows = await hybridSearch(engine, 'nonlexicalsaffronquery', { expansion: false, limit: 10 });
      return rows.map(row => row.slug).sort();
    };
    expect(await query()).toEqual(['current', 'legacy']);
    providerDown = true;
    const options = { to: model, dim: dimensions, reranker: 'off', maxCostUsd: 1, quiet: true };
    const attempted = await executeMigrationFlow(engine, await planMigrationFlow(engine, options), options);
    expect(attempted.status).toBe('probe_failed');
    expect(await engine.getConfig('embedding_migration.state')).toBeTruthy();
    providerDown = false;
    expect(await query()).toEqual(['current', 'legacy']);
    await engine.setConfig('embedding_migration.state', JSON.stringify({ to_model: model, to_dims: dimensions }));
    expect(await query()).toEqual(['current', 'legacy']);
    await engine.executeRaw("DELETE FROM config WHERE key='embedding_migration.state'");
    expect(await query()).toEqual(['current', 'legacy']);
    expect(await engine.executeRaw('SELECT id,embedding::text,model,embedded_text_hash FROM content_chunks ORDER BY id')).toEqual(before);
  }
}), 120_000);
