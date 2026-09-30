import { afterAll, beforeAll, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { createConnectorFixture } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const fixture = createConnectorFixture();
beforeAll(fixture.setup, 120_000);
afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await fixture.teardown();
});

test('legacy extraction deduplicates exact old facts without inferring their vector identity or crossing visibility', async () => withEnv({
  ...fixture.env, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
  GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined,
}, async () => {
  for (const engine of fixture.engines) {
    const model = 'openai:text-embedding-3-small';
    await runSchemaTransition(engine, 8);
    await engine.setConfig('embedding_model', model);
    await engine.setConfig('embedding_dimensions', '8');
    resetGateway();
    configureGateway({ embedding_model: model, embedding_dimensions: 8, env: { OPENAI_API_KEY: 'synthetic-only' } });
    __setEmbedTransportForTests(async ({ values }) => ({ values, warnings: [], embeddings: values.map(() => Array(8).fill(0.1)), usage: { tokens: 8 } }));
    const fact = 'Synthetic profile prefers reproducible local fixtures.';
    const entity = 'people/synthetic-profile';
    let extractedEntity: string | null = entity;
    __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: [{ fact, entity: extractedEntity, kind: 'fact', notability: 'high', confidence: 1 }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'synthetic:fixture', providerId: 'synthetic' }));
    await engine.putPage(entity, { type: 'person', title: 'Synthetic profile', compiled_truth: 'Synthetic entity.' });
    const old = await engine.insertFact({ entity_slug: entity, fact, source: 'synthetic', visibility: 'private', embedding: new Float32Array(8).fill(0.1) }, { source_id: 'default' });
    const before = await engine.executeRaw('SELECT embedding::text,embedding_model,embedded_text_hash FROM facts WHERE id=$1', [old.id]);
    expect(before[0]).toMatchObject({ embedding_model: null, embedded_text_hash: null });
    const result = await runFactsPipeline('Synthetic extraction input for a known profile.', { engine, sourceId: 'default', sessionId: null, source: 'mcp:extract_facts', visibility: 'private' });
    expect(result).toMatchObject({ inserted: 0, duplicate: 1, fact_ids: [old.id] });
    expect(await engine.executeRaw('SELECT embedding::text,embedding_model,embedded_text_hash FROM facts WHERE id=$1', [old.id])).toEqual(before);
    const visible = await runFactsPipeline('Synthetic extraction input for a known profile.', { engine, sourceId: 'default', sessionId: null, source: 'mcp:extract_facts', visibility: 'world' });
    expect(visible).toMatchObject({ inserted: 1, duplicate: 0 });
    expect(visible.fact_ids).not.toContain(old.id);
    extractedEntity = null;
    for (const sourceSlug of ['notes/first', 'notes/second']) {
      const unparented = await runFactsPipeline('Synthetic unparented extraction input.', { engine, sourceId: 'default', sessionId: null,
        source: 'mcp:extract_facts', sourceSlug, visibility: 'private' });
      expect(unparented).toMatchObject({ inserted: 1, duplicate: 0 });
    }
    expect(await engine.executeRaw('SELECT context FROM facts WHERE entity_slug IS NULL ORDER BY id')).toEqual([{ context: 'notes/first' }, { context: 'notes/second' }]);
  }
}), 120_000);
