import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { planEmbeddingMigration, runSchemaTransition } from '../src/core/embedding-migration.ts';
import { planMigrationWorstCase } from '../src/core/embedding-migration-worst-case.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

const GEMMA = 'ollama:embeddinggemma';
const OPENAI = 'openai:text-embedding-3-small';
const DIMS = 8;
const title = '東京'.repeat(150);

describe('embedding migration title ceilings', () => {
  let engine: BrainEngine;

  const worstCase = (model: string) => withEnv({ GBRAIN_EMBED_MAX_BATCH_TOKENS: '500' }, () =>
    planEmbeddingMigration(engine, { to: model, dim: DIMS }).then(plan => planMigrationWorstCase(engine, plan)));

  beforeAll(async () => {
    const pglite = new PGLiteEngine();
    engine = pglite;
    await pglite.connect({});
    await pglite.initSchema();
    await runSchemaTransition(engine, DIMS);
    await engine.setConfig('embedding_model', GEMMA);
    await engine.setConfig('embedding_dimensions', String(DIMS));
  }, 120_000);

  afterAll(async () => { await engine.disconnect(); });

  test('uses persisted and projected page titles for Gemma ceilings, preserving other providers and partitions', async () => {
    const staleGemmaBase = await worstCase(GEMMA);
    const staleOpenAIBase = await worstCase(OPENAI);
    const staleBodies = Array.from({ length: 17 }, (_, i) => `Stale chunk ${i} with UTF-8 content.`);
    await engine.putPage('migration/stale-title', { type: 'note', title, compiled_truth: '' });
    await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode='title' WHERE slug='migration/stale-title'");
    await installFixtureChunks(engine, 'migration/stale-title', staleBodies.map((chunk_text, chunk_index) => ({
      chunk_index,
      chunk_source: chunk_index === 16 ? 'fenced_code' as const : 'compiled_truth' as const,
      chunk_text,
    })));

    const staleGemma = await worstCase(GEMMA);
    const staleOpenAI = await worstCase(OPENAI);
    const storedBodies = staleBodies.map((body, i) => i === 16 ? body : `<context>${title}\n</context>\n${body}`);
    expect(staleGemma.input_tokens - staleGemmaBase.input_tokens).toBe(
      storedBodies.reduce((sum, body) => sum + Buffer.byteLength(`title: ${title} | text: ${body}`), 0));
    expect(staleGemma.requests - staleGemmaBase.requests).toBeGreaterThan(staleOpenAI.requests - staleOpenAIBase.requests);
    expect(staleOpenAI.input_tokens - staleOpenAIBase.input_tokens).toBe(
      storedBodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0));

    const projectedGemmaBase = staleGemma;
    const projectedOpenAIBase = staleOpenAI;
    const projectedBody = 'A rebuilt projection paragraph with enough content to embed.';
    await engine.putPage('migration/reprojected-title', { type: 'note', title, compiled_truth: projectedBody });
    await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode='title', text_projection_revision=NULL WHERE slug='migration/reprojected-title'");

    const projectedGemma = await worstCase(GEMMA);
    const projectedOpenAI = await worstCase(OPENAI);
    expect(projectedGemma.input_tokens - projectedGemmaBase.input_tokens
      - (projectedOpenAI.input_tokens - projectedOpenAIBase.input_tokens)).toBe(Buffer.byteLength(`title: ${title} | text: `));
    expect(projectedGemma.requests - projectedGemmaBase.requests).toBe(projectedOpenAI.requests - projectedOpenAIBase.requests);
  });
});
