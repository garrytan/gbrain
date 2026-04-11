import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetProvider, getProvider } from '../../src/core/embedding/registry.ts';

// Helper: create a fresh in-memory PGLite engine
async function freshEngine(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  return engine;
}

// Helper: create a page with embedded chunks
async function seedChunks(engine: PGLiteEngine, dims: number) {
  await engine.putPage('test-page', {
    type: 'concept',
    title: 'Test',
    compiled_truth: 'test content',
  });
  const embedding = new Float32Array(dims).fill(0.1);
  await engine.upsertChunks('test-page', [{
    chunk_index: 0,
    chunk_text: 'test chunk',
    chunk_source: 'compiled_truth',
    embedding,
    model: 'test-model',
    token_count: 5,
  }]);
}

describe('embedding integration (PGLite)', () => {
  let engine: PGLiteEngine;
  const originalEnv = { ...process.env };

  function clearEmbeddingEnv() {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
  }

  beforeEach(() => {
    resetProvider();
    clearEmbeddingEnv();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    resetProvider();
    if (engine) {
      await engine.disconnect();
      engine = null as any;
    }
  });

  // ============================================================
  // A. Fresh init
  // ============================================================

  test('A1: fresh init with defaults stores openai config', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    expect(await engine.getConfig('embedding_provider')).toBe('openai');
    expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-large');
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');
  });

  test('A2: fresh init with GBRAIN_EMBEDDING_PROVIDER=voyage', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    engine = await freshEngine();
    await engine.initSchema();

    expect(await engine.getConfig('embedding_provider')).toBe('voyage');
    expect(await engine.getConfig('embedding_model')).toBe('voyage:voyage-4-large');
    expect(await engine.getConfig('embedding_dimensions')).toBe('1024');

    // Verify vector column is 1024
    await engine.putPage('v-test', {
      type: 'concept',
      title: 'Voyage Test',
      compiled_truth: 'content',
    });
    const embedding = new Float32Array(1024).fill(0.1);
    await engine.upsertChunks('v-test', [{
      chunk_index: 0,
      chunk_text: 'chunk',
      chunk_source: 'compiled_truth',
      embedding,
      model: 'voyage:voyage-4-large',
    }]);
    const chunks = await engine.getChunks('v-test');
    expect(chunks.length).toBe(1);
  });

  test('A3: fresh init with GBRAIN_EMBEDDING_PROVIDER=gemini', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    engine = await freshEngine();
    await engine.initSchema();

    expect(await engine.getConfig('embedding_provider')).toBe('gemini');
    expect(await engine.getConfig('embedding_model')).toBe('gemini:gemini-embedding-2-preview');
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');
  });

  // ============================================================
  // B. Restart (DB config persistence)
  // ============================================================

  test('B1: config set provider=gemini → restart → gemini used', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Simulate: gbrain config set embedding_provider gemini
    await engine.setConfig('embedding_provider', 'gemini');
    await engine.setConfig('embedding_model', 'gemini:gemini-embedding-2-preview');
    await engine.setConfig('embedding_dimensions', '1536');

    // Simulate restart
    resetProvider();
    await engine.initSchema();

    const resolved = getProvider();
    expect(resolved.name).toBe('gemini');
    expect(resolved.model).toBe('gemini-embedding-2-preview');
  });

  test('B2: config set model (same provider) → restart → new model used', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Change model within same provider
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');

    resetProvider();
    await engine.initSchema();

    const resolved = getProvider();
    expect(resolved.name).toBe('openai');
    expect(resolved.model).toBe('text-embedding-3-small');
  });

  test('B3: DB has gemini + env var sets voyage → voyage wins', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Set DB to gemini
    await engine.setConfig('embedding_provider', 'gemini');
    await engine.setConfig('embedding_model', 'gemini:gemini-embedding-2-preview');
    await engine.setConfig('embedding_dimensions', '1536');

    // But env var says voyage
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    resetProvider();
    await engine.initSchema();

    const resolved = getProvider();
    expect(resolved.name).toBe('voyage');
    expect(resolved.model).toBe('voyage-4-large');
    expect(resolved.dimensions).toBe(1024);
  });

  // ============================================================
  // C. Dimension change
  // ============================================================

  test('C1: openai(1536) → voyage(1024) — ALTER + INSERT success', async () => {
    engine = await freshEngine();
    await engine.initSchema();
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');

    // Switch to voyage
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    resetProvider();
    await engine.initSchema();

    expect(await engine.getConfig('embedding_dimensions')).toBe('1024');

    // Verify 1024-dim INSERT works
    await engine.putPage('c1-test', {
      type: 'concept',
      title: 'C1',
      compiled_truth: 'content',
    });
    const embedding = new Float32Array(1024).fill(0.1);
    await engine.upsertChunks('c1-test', [{
      chunk_index: 0,
      chunk_text: 'chunk',
      chunk_source: 'compiled_truth',
      embedding,
      model: 'voyage:voyage-4-large',
    }]);
    const chunks = await engine.getChunks('c1-test');
    expect(chunks.length).toBe(1);
  });

  test('C2: voyage(1024) → openai(1536) — reverse ALTER', async () => {
    // Start with voyage
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    engine = await freshEngine();
    await engine.initSchema();
    expect(await engine.getConfig('embedding_dimensions')).toBe('1024');

    // Switch back to openai via DB config (simulates: gbrain config set embedding_provider openai)
    await engine.setConfig('embedding_provider', 'openai');
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    await engine.setConfig('embedding_dimensions', '1536');
    clearEmbeddingEnv();
    resetProvider();
    await engine.initSchema();

    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');

    // Verify 1536-dim INSERT works
    await engine.putPage('c2-test', {
      type: 'concept',
      title: 'C2',
      compiled_truth: 'content',
    });
    const embedding = new Float32Array(1536).fill(0.1);
    await engine.upsertChunks('c2-test', [{
      chunk_index: 0,
      chunk_text: 'chunk',
      chunk_source: 'compiled_truth',
      embedding,
      model: 'openai:text-embedding-3-large',
    }]);
    const chunks = await engine.getChunks('c2-test');
    expect(chunks.length).toBe(1);
  });

  test('C3: dimension change NULLs existing embeddings', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Seed a page with 1536-dim embedding
    await seedChunks(engine, 1536);
    const before = await engine.getChunks('test-page');
    expect(before[0].embedded_at).not.toBeNull();

    // Switch to voyage (1024)
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    resetProvider();
    await engine.initSchema();

    // Embeddings should be NULL'd (stale)
    const after = await engine.getChunks('test-page');
    expect(after[0].embedded_at).toBeNull();
  });

  test('C4: dimension change on empty brain (no chunks)', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Switch to voyage (no data to ALTER, should not error)
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    resetProvider();
    await engine.initSchema();

    expect(await engine.getConfig('embedding_dimensions')).toBe('1024');
    expect(await engine.getConfig('embedding_provider')).toBe('voyage');
  });

  // ============================================================
  // D. Model change (same dimensions)
  // ============================================================

  test('D1: openai → gemini (both 1536) — stale marking only, no ALTER', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Seed with embeddings
    await seedChunks(engine, 1536);
    const before = await engine.getChunks('test-page');
    expect(before[0].embedded_at).not.toBeNull();

    // Switch to gemini (same dimensions)
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    resetProvider();
    await engine.initSchema();

    // Dimensions unchanged
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');
    // Provider updated
    expect(await engine.getConfig('embedding_provider')).toBe('gemini');
    // Model updated
    expect(await engine.getConfig('embedding_model')).toBe('gemini:gemini-embedding-2-preview');

    // 1536-dim INSERT should still work (no ALTER happened)
    const embedding = new Float32Array(1536).fill(0.2);
    await engine.upsertChunks('test-page', [{
      chunk_index: 0,
      chunk_text: 'updated chunk',
      chunk_source: 'compiled_truth',
      embedding,
      model: 'gemini:gemini-embedding-2-preview',
    }]);
    const chunks = await engine.getChunks('test-page');
    expect(chunks.length).toBe(1);
    expect(chunks[0].model).toBe('gemini:gemini-embedding-2-preview');
  });

  test('D2: same provider, different model (text-embedding-3-small)', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    await seedChunks(engine, 1536);

    // Change model via DB config (same provider, same dims)
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
    resetProvider();
    await engine.initSchema();

    const resolved = getProvider();
    expect(resolved.name).toBe('openai');
    expect(resolved.model).toBe('text-embedding-3-small');
    expect(resolved.dimensions).toBe(1536);
  });

  // ============================================================
  // E. Legacy / edge cases
  // ============================================================

  test('E1: legacy model format (no colon) gets normalized', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Simulate legacy DB state: model without provider prefix
    await engine.setConfig('embedding_model', 'text-embedding-3-large');

    resetProvider();
    await engine.initSchema();

    // Should still resolve correctly (registry strips provider prefix)
    const resolved = getProvider();
    expect(resolved.name).toBe('openai');
    expect(resolved.model).toBe('text-embedding-3-large');
  });

  test('E2: missing embedding_provider key in DB → auto-created', async () => {
    engine = await freshEngine();
    await engine.initSchema();

    // Delete the key to simulate old schema
    await engine.setConfig('embedding_provider', '');
    // Actually remove via direct SQL
    const db = (engine as any)._db;
    await db.exec("DELETE FROM config WHERE key = 'embedding_provider'");

    resetProvider();
    await engine.initSchema();

    // Should be auto-set
    const provider = await engine.getConfig('embedding_provider');
    expect(provider).toBe('openai');
  });

  test('E3: sequential provider changes (openai → voyage → gemini)', async () => {
    engine = await freshEngine();
    await engine.initSchema();
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');

    // Step 1: openai → voyage
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    resetProvider();
    await engine.initSchema();
    expect(await engine.getConfig('embedding_dimensions')).toBe('1024');
    expect(await engine.getConfig('embedding_provider')).toBe('voyage');

    // Verify 1024 INSERT works
    await engine.putPage('e3-test', {
      type: 'concept',
      title: 'E3',
      compiled_truth: 'content',
    });
    await engine.upsertChunks('e3-test', [{
      chunk_index: 0,
      chunk_text: 'chunk',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(1024).fill(0.1),
      model: 'voyage:voyage-4-large',
    }]);

    // Step 2: voyage → gemini (1024 → 1536)
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    resetProvider();
    await engine.initSchema();
    expect(await engine.getConfig('embedding_dimensions')).toBe('1536');
    expect(await engine.getConfig('embedding_provider')).toBe('gemini');

    // Previous embeddings should be NULL'd
    const chunks = await engine.getChunks('e3-test');
    expect(chunks[0].embedded_at).toBeNull();

    // Verify 1536 INSERT works
    await engine.upsertChunks('e3-test', [{
      chunk_index: 0,
      chunk_text: 'chunk',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(1536).fill(0.2),
      model: 'gemini:gemini-embedding-2-preview',
    }]);
    const updated = await engine.getChunks('e3-test');
    expect(updated[0].model).toBe('gemini:gemini-embedding-2-preview');
  });
});
