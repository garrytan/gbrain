/**
 * v0.28.5 (A4) — Existing-brain dimension-mismatch detection unit tests.
 *
 * Pairs with `gbrain init` and `gbrain doctor`'s loud-failure paths. Validates
 * that:
 *   1. readContentChunksEmbeddingDim correctly reports null on a fresh brain.
 *   2. After initSchema, it returns the actual templated dim (1536 default).
 *   3. embeddingMismatchMessage produces a recipe that explicitly drops the
 *      HNSW index, alters the column, wipes embeddings, and conditionally
 *      reindexes — codex's #8 finding from plan review.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  readContentChunksEmbeddingDim,
  embeddingMismatchMessage,
  resolveSchemaEmbeddingDim,
  resolveSchemaMultimodalDim,
  PGVECTOR_COLUMN_MAX_DIMS,
} from '../src/core/embedding-dim-check.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

// Canonical pattern: single engine per file, init once, disconnect once.
// The two tests below diverge in whether they want a migrated brain or a
// pre-initSchema brain — handled by inline reset / second-engine instead of
// resetting in beforeEach (keeps the migrated state cached for the LATEST case).
let engine: PGLiteEngine;

beforeAll(async () => {
  // Hermeticity guard (cross-file gateway-state leak class — see CLAUDE.md
  // "Test-isolation lint and helpers"). initSchema builds the
  // content_chunks vector column at the gateway's configured dim. The
  // bunfig preload pins OpenAI/1536, but its beforeEach only re-applies
  // legacy when the gateway was RESET (throws) — it does NOT correct a
  // sibling that configured a different LIVE dim (e.g. ZE/1280) and never
  // reset. Under weight-based shard bin-packing, such a sibling can run
  // first, so pin 1536 explicitly here BEFORE initSchema (this is exactly
  // the "call configureGateway() in your own beforeAll" escape hatch the
  // preload documents). Reset in afterAll so we don't leak 1536 onward.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('readContentChunksEmbeddingDim', () => {
  test('returns dims from a migrated brain (1536d via legacy-embedding preload)', async () => {
    // v0.37 fix wave: the canonical gateway default is now 1280 (ZE).
    // However, `bunfig.toml` preloads `test/helpers/legacy-embedding-preload.ts`
    // which configures the gateway to OpenAI/1536 BEFORE any test runs.
    // This preserves the 20+ test files with hardcoded 1536-d
    // Float32Array fixtures. So initSchema() under tests produces a
    // 1536-d column.
    //
    // New v0.37 tests that need to assert the ZE/1280 default can call
    // configureGateway() explicitly in their own beforeAll, which
    // overrides the preload.
    const result = await readContentChunksEmbeddingDim(engine);
    expect(result.exists).toBe(true);
    expect(result.dims).toBe(1536);
  }, 30000);

  test('returns { exists: false, dims: null } on a fresh brain (no initSchema)', async () => {
    // One-off engine for the fresh-brain case. Never call initSchema so
    // content_chunks doesn't exist yet. Cleaned up at end of test.
    const fresh = new PGLiteEngine();
    await fresh.connect({});
    try {
      const result = await readContentChunksEmbeddingDim(fresh);
      expect(result.exists).toBe(false);
      expect(result.dims).toBeNull();
    } finally {
      await fresh.disconnect();
    }
  }, 30000);
});

describe('embeddingMismatchMessage', () => {
  test('Postgres branch inlines all four recipe steps for HNSW-eligible dims', () => {
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 768,
      requestedModel: 'nomic-embed-text',
      source: 'init',
      engineKind: 'postgres',
    });
    expect(msg).toContain('vector(1536)');
    expect(msg).toContain('vector(768)');
    expect(msg).toContain('DROP INDEX IF EXISTS idx_chunks_embedding');
    expect(msg).toContain('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(768)');
    expect(msg).toContain('UPDATE content_chunks SET embedding = NULL');
    expect(msg).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding');
    expect(msg).toContain('docs/embedding-migrations.md');
  });

  test('Postgres recipe NULLs embeddings BEFORE the column alter (pgvector refuses cross-dim casts)', () => {
    // pgvector aborts `ALTER COLUMN TYPE vector(N)` with "expected N
    // dimensions, not M" while rows still hold old-width vectors — which is
    // every brain running this recipe. The UPDATE must precede the ALTER
    // (NULLs cast fine). Order pinned so the printed recipe can't drift from
    // the corrected docs/embedding-migrations.md again.
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 768,
      requestedModel: 'nomic-embed-text',
      source: 'init',
      engineKind: 'postgres',
    });
    const nullIdx = msg.indexOf('UPDATE content_chunks SET embedding = NULL');
    const alterIdx = msg.indexOf('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(768)');
    expect(nullIdx).toBeGreaterThan(-1);
    expect(alterIdx).toBeGreaterThan(-1);
    expect(nullIdx).toBeLessThan(alterIdx);
  });

  test('Postgres branch skips HNSW recreate when requested dims exceed pgvector cap', () => {
    // Codex finding #8: 2048d (Voyage 4 Large) cannot be HNSW-indexed in pgvector.
    // The recipe must NOT instruct a CREATE INDEX HNSW for that dim.
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 2048,
      requestedModel: 'voyage-4-large',
      source: 'init',
      engineKind: 'postgres',
    });
    expect(msg).toContain('vector(2048)');
    expect(msg).toContain('Skip reindex');
    expect(msg).toContain("exceeds pgvector's HNSW cap");
    // The HNSW CREATE INDEX line must NOT appear in the 2048d recipe.
    expect(msg).not.toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding\n  ON content_chunks USING hnsw');
  });

  test('source: doctor uses a different header than source: init', () => {
    const initMsg = embeddingMismatchMessage({ currentDims: 1536, requestedDims: 768, source: 'init', engineKind: 'postgres' });
    const doctorMsg = embeddingMismatchMessage({ currentDims: 1536, requestedDims: 768, source: 'doctor', engineKind: 'postgres' });
    expect(initMsg).toContain('Refusing to silently re-template');
    expect(doctorMsg).toContain('Embedding dimension mismatch detected');
  });

  // v0.37 fix wave Lane D.1: PGLite branch uses wipe-and-reinit recipe
  // because PGLite can't ALTER vector column types.
  test('PGLite branch uses wipe-and-reinit, not ALTER COLUMN', () => {
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 1280,
      requestedModel: 'zeroentropyai:zembed-1',
      source: 'init',
      engineKind: 'pglite',
      databasePath: '/tmp/test-brain.pglite',
    });
    expect(msg).toContain('vector(1536)');
    expect(msg).toContain('vector(1280)');
    expect(msg).toContain('mv /tmp/test-brain.pglite /tmp/test-brain.pglite.bak');
    expect(msg).toContain('gbrain init --pglite --embedding-model zeroentropyai:zembed-1 --embedding-dimensions 1280');
    expect(msg).toContain('PGLite cannot ALTER vector column types');
    // Must NOT contain the Postgres-only SQL recipe.
    expect(msg).not.toContain('ALTER TABLE content_chunks ALTER COLUMN');
    expect(msg).not.toContain('DROP INDEX IF EXISTS idx_chunks_embedding');
  });

  test('PGLite branch falls back to default database path when omitted', () => {
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 1280,
      source: 'init',
      engineKind: 'pglite',
    });
    // Default falls back to gbrainPath('brain.pglite').
    expect(msg).toMatch(/mv .+brain\.pglite .+brain\.pglite\.bak/);
  });

  test('PGLite branch must NOT recommend `gbrain config set embedding_model` (no-op after Lane C.2)', () => {
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 1280,
      requestedModel: 'zeroentropyai:zembed-1',
      source: 'doctor',
      engineKind: 'pglite',
    });
    // The pre-v0.37 recipe pointed at `gbrain config set embedding_model X`
    // which is a no-op after C.2. Recipe must point at init instead.
    expect(msg).not.toContain('gbrain config set embedding_model');
    expect(msg).not.toContain('gbrain config set embedding_dimensions');
  });
});

// ============================================================================
// v0.37.x — D11 + D12 preflight resolvers
// ============================================================================

describe('resolveSchemaEmbeddingDim', () => {
  test('OpenAI text-embedding-3-large resolves at default 1536', () => {
    const got = resolveSchemaEmbeddingDim({ embedding_model: 'openai:text-embedding-3-large' });
    expect(got).toEqual({
      ok: true,
      dim: 1536,
      model: 'openai:text-embedding-3-large',
      provider: 'openai',
      recipeDefault: 1536,
    });
  });

  test('ZeroEntropy zembed-1 resolves at recipe default', () => {
    const got = resolveSchemaEmbeddingDim({ embedding_model: 'zeroentropyai:zembed-1' });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.provider).toBe('zeroentropyai');
      expect(got.model).toBe('zeroentropyai:zembed-1');
      expect(got.dim).toBeGreaterThan(0);
    }
  });

  test('ZeroEntropy Matryoshka explicit dim (1280) accepted', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
    });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.dim).toBe(1280);
  });

  test('ZeroEntropy Matryoshka invalid dim (1024) rejected — 1024 is Voyage step, not ZE', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1024,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/does not support custom dimensions 1024|only emits/);
  });

  test('OpenAI text-3-large rejects 2048 (not in declared dims_options)', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 2048,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/rejects custom dimensions 2048|does not support custom dimensions/);
  });

  test('OpenAI text-3-large accepts 768 (declared in recipe dims_options)', () => {
    // text-embedding-3-large declares dims_options including 768.
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 768,
    });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.dim).toBe(768);
  });

  test('unknown provider rejected with provider list hint', () => {
    const got = resolveSchemaEmbeddingDim({ embedding_model: 'notarealprovider:foo' });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/unknown provider/i);
  });

  test('missing colon rejected', () => {
    const got = resolveSchemaEmbeddingDim({ embedding_model: 'openai' });
    expect(got.ok).toBe(false);
  });

  test('negative dim rejected', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: -100,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/positive integer/);
  });

  test('zero dim rejected', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 0,
    });
    expect(got.ok).toBe(false);
  });

  test('non-integer dim rejected', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536.5,
    });
    expect(got.ok).toBe(false);
  });

  test('dim exceeding pgvector column cap rejected', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: PGVECTOR_COLUMN_MAX_DIMS + 1,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/exceed pgvector's column cap/);
  });

  test('regression: bug-reporter scenario — OpenAI auto-pick resolves at 1536', () => {
    const got = resolveSchemaEmbeddingDim({ embedding_model: 'openai:text-embedding-3-large' });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.dim).toBe(1536);
      expect(got.model).toBe('openai:text-embedding-3-large');
    }
  });
});

describe('resolveSchemaMultimodalDim', () => {
  test('voyage voyage-multimodal-3 accepted', () => {
    const got = resolveSchemaMultimodalDim({ embedding_multimodal_model: 'voyage:voyage-multimodal-3' });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.provider).toBe('voyage');
      expect(got.dim).toBeGreaterThan(0);
    }
  });

  test('OpenAI text-embedding-3-large rejected — not multimodal', () => {
    const got = resolveSchemaMultimodalDim({
      embedding_multimodal_model: 'openai:text-embedding-3-large',
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/does not support multimodal/);
  });

  test('voyage text-only model (voyage-3-large) rejected via allow-list', () => {
    const got = resolveSchemaMultimodalDim({
      embedding_multimodal_model: 'voyage:voyage-3-large',
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/not in provider "voyage"'s multimodal allow-list/);
  });

  test('unknown provider rejected', () => {
    const got = resolveSchemaMultimodalDim({
      embedding_multimodal_model: 'notarealprovider:foo',
    });
    expect(got.ok).toBe(false);
  });

  test('dim above pgvector cap rejected', () => {
    const got = resolveSchemaMultimodalDim({
      embedding_multimodal_model: 'voyage:voyage-multimodal-3',
      embedding_multimodal_dimensions: PGVECTOR_COLUMN_MAX_DIMS + 1,
    });
    expect(got.ok).toBe(false);
  });
});
