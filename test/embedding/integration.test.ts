import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetProvider } from '../../src/core/embedding/registry.ts';

describe('embedding integration (PGLite)', () => {
  let engine: PGLiteEngine;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetProvider();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    resetProvider();
    if (engine) await engine.disconnect();
  });

  test('initSchema stores provider config in DB', async () => {
    // Default provider (openai)
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;

    engine = new PGLiteEngine();
    await engine.connect({}); // in-memory
    await engine.initSchema();

    const provider = await engine.getConfig('embedding_provider');
    const model = await engine.getConfig('embedding_model');
    const dims = await engine.getConfig('embedding_dimensions');

    expect(provider).toBe('openai');
    expect(model).toBe('openai:text-embedding-3-large');
    expect(dims).toBe('1536');
  });

  test('initSchema reads DB config on second init (simulating restart)', async () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;

    engine = new PGLiteEngine();
    await engine.connect({}); // in-memory
    await engine.initSchema();

    // Simulate user running: gbrain config set embedding_provider gemini
    await engine.setConfig('embedding_provider', 'gemini');
    await engine.setConfig('embedding_model', 'gemini:gemini-embedding-2-preview');
    await engine.setConfig('embedding_dimensions', '1536');

    // Simulate restart — reset provider cache and re-init
    resetProvider();
    await engine.initSchema();

    // Provider should now resolve from DB config
    const { getProvider } = await import('../../src/core/embedding/registry.ts');
    const resolved = getProvider();
    expect(resolved.name).toBe('gemini');
    expect(resolved.model).toBe('gemini-embedding-2-preview');
  });

  test('migration v5 handles dimension change on real DB', async () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;

    engine = new PGLiteEngine();
    await engine.connect({}); // in-memory
    await engine.initSchema();

    // Verify initial state: vector(1536)
    const initialDims = await engine.getConfig('embedding_dimensions');
    expect(initialDims).toBe('1536');

    // Now simulate switching to voyage (1024 dims) via env var
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    resetProvider();

    // Re-init triggers migration v5
    await engine.initSchema();

    // Verify dimension was changed
    const newDims = await engine.getConfig('embedding_dimensions');
    expect(newDims).toBe('1024');

    const newProvider = await engine.getConfig('embedding_provider');
    expect(newProvider).toBe('voyage');

    // Verify we can insert a 1024-dim vector (would fail if ALTER didn't work)
    // First create a test page
    await engine.putPage('test-page', {
      type: 'concept',
      title: 'Test',
      compiled_truth: 'test content',
    });

    // Insert a chunk with 1024-dim embedding
    const embedding = new Float32Array(1024).fill(0.1);
    await engine.upsertChunks('test-page', [{
      chunk_index: 0,
      chunk_text: 'test chunk',
      chunk_source: 'compiled_truth',
      embedding,
      model: 'voyage:voyage-4-large',
    }]);

    // Verify it was stored
    const chunks = await engine.getChunks('test-page');
    expect(chunks.length).toBe(1);
    expect(chunks[0].model).toBe('voyage:voyage-4-large');
  });
});
