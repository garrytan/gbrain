import { afterEach, beforeEach, describe, test, expect, mock } from 'bun:test';

const originalEnv = { ...process.env };

beforeEach(() => {
  mock.restore();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  mock.restore();
});

async function importEmbeddingDimensionsModule(suffix: string) {
  return import(`../src/core/embedding-dimensions.ts?${suffix}`) as Promise<typeof import('../src/core/embedding-dimensions.ts')>;
}

async function importEmbeddingSchemaModule(suffix: string) {
  return import(`../src/core/embedding-schema.ts?${suffix}`) as Promise<typeof import('../src/core/embedding-schema.ts')>;
}

async function importMigrateModule(suffix: string) {
  return import(`../src/core/migrate.ts?${suffix}`) as Promise<typeof import('../src/core/migrate.ts')>;
}

async function importPgliteEngineModule(suffix: string) {
  return import(`../src/core/pglite-engine.ts?${suffix}`) as Promise<typeof import('../src/core/pglite-engine.ts')>;
}

describe('embedding dimensions schema support', () => {
  test('migration realigns content_chunks.embedding to configured dimensions', async () => {
    const { MIGRATIONS } = await importMigrateModule('migration-shape');
    const migration = MIGRATIONS.find(m => m.name === 'embedding_dimension_realign');

    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("format('vector(%s)', configured_dimensions)");
    expect(migration!.sql).toContain("current_setting('gbrain.embedding_dimensions', true)");
    expect(migration!.sql).toContain('DROP INDEX IF EXISTS idx_chunks_embedding');
    expect(migration!.sql).toContain('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector');
    expect(migration!.sql).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding');
    expect(migration!.sql).toContain('embedding_model');
    expect(migration!.sql).toContain('embedding_dimensions');
  });

  test('PGLite initSchema uses configured embedding dimensions for new brains', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'copilot';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '1024';
    process.env.GBRAIN_EMBEDDING_MODEL = 'metis-1024-I16-Binary';

    const { PGLiteEngine } = await importPgliteEngineModule('pglite-1024');
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const [column] = await engine.executeRaw<{ formatted_type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS formatted_type
         FROM pg_attribute
         WHERE attrelid = 'content_chunks'::regclass
           AND attname = 'embedding'`,
      );

      expect(column.formatted_type).toBe('vector(1024)');
      expect(await engine.getConfig('embedding_model')).toBe('metis-1024-I16-Binary');
      expect(await engine.getConfig('embedding_dimensions')).toBe('1024');
    } finally {
      await engine.disconnect();
    }
  });

  test('upsertChunks fails fast when embedded vector length does not match configured dimensions', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'copilot';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '1024';

    const { PGLiteEngine } = await importPgliteEngineModule('pglite-guard');
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      await engine.putPage('test/dimensions', {
        type: 'concept',
        title: 'Dimensions',
        compiled_truth: 'dimension guard test',
      });

      await expect(engine.upsertChunks('test/dimensions', [{
        chunk_index: 0,
        chunk_text: 'wrong vector length',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array(1536),
      }])).rejects.toThrow('does not match configured embedding dimension 1024');
    } finally {
      await engine.disconnect();
    }
  });

  test('embedding schema settings SQL uses current provider config', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '768';

    const { schemaEmbeddingSettingsSql } = await importEmbeddingSchemaModule('schema-settings-768');
    const sql = schemaEmbeddingSettingsSql();

    expect(sql).toContain("SET gbrain.embedding_dimensions = '768'");
    expect(sql).toContain("SET gbrain.embedding_model = 'nomic-embed-text'");
  });

  test('dimension guard uses current provider config', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '768';

    const { validateChunkEmbeddingDimensions } = await importEmbeddingDimensionsModule('guard-768');

    expect(() => validateChunkEmbeddingDimensions([{
      chunk_index: 0,
      chunk_text: 'wrong vector length',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(1024),
    }])).toThrow('does not match configured embedding dimension 768');
  });
});
