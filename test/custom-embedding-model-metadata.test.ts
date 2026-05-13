import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'llama-server:nomic-embed',
    embedding_dimensions: 768,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  resetGateway();
  await resetPgliteState(engine);
});

describe('content chunk embedding model metadata', () => {
  test('defaults missing chunk.model to the currently configured embedding model', async () => {
    configureGateway({
      embedding_model: 'llama-server:nomic-embed',
      embedding_dimensions: 768,
      env: {},
    });

    const page = await engine.putPage('docs/custom-embedding-model', {
      type: 'concept',
      title: 'Custom embedding model',
      compiled_truth: 'A page embedded by a local OpenAI-compatible provider.',
      timeline: '',
    });

    await engine.upsertChunks(page.slug, [
      {
        chunk_index: 0,
        chunk_text: 'Local embedding provider metadata should be auditable.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array(768),
      },
    ]);

    const rows = await engine.executeRaw(
      'SELECT model, vector_dims(embedding) AS dims FROM content_chunks WHERE page_id = $1',
      [page.id],
    );

    expect(rows).toEqual([{ model: 'nomic-embed', dims: 768 }]);
  });

  test('preserves an explicit chunk.model override', async () => {
    configureGateway({
      embedding_model: 'llama-server:nomic-embed',
      embedding_dimensions: 768,
      env: {},
    });

    const page = await engine.putPage('docs/explicit-embedding-model', {
      type: 'concept',
      title: 'Explicit embedding model',
      compiled_truth: 'A page with explicit chunk model metadata.',
      timeline: '',
    });

    await engine.upsertChunks(page.slug, [
      {
        chunk_index: 0,
        chunk_text: 'Explicit model metadata wins.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array(768),
        model: 'manual-model-id',
      },
    ]);

    const rows = await engine.executeRaw(
      'SELECT model FROM content_chunks WHERE page_id = $1',
      [page.id],
    );

    expect(rows).toEqual([{ model: 'manual-model-id' }]);
  });
});
