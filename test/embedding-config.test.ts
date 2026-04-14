import { describe, test, expect } from 'bun:test';
import { buildEmbeddingMigrationSql, resolveEmbeddingSettingsFromSources } from '../src/core/embedding-config.ts';

describe('resolveEmbeddingSettingsFromSources', () => {
  test('defaults to OpenAI settings when no overrides are present', () => {
    const settings = resolveEmbeddingSettingsFromSources({ env: {} });

    expect(settings).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      baseURL: undefined,
    });
  });

  test('uses Ollama defaults when provider is ollama', () => {
    const settings = resolveEmbeddingSettingsFromSources({
      env: { GBRAIN_EMBEDDING_PROVIDER: 'ollama' },
    });

    expect(settings).toEqual({
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 768,
      baseURL: 'http://127.0.0.1:11434',
    });
  });

  test('engine config overrides provider/model/dimensions/base URL', () => {
    const settings = resolveEmbeddingSettingsFromSources({
      env: {},
      engineConfig: {
        embedding_provider: 'ollama',
        embedding_model: 'mxbai-embed-large',
        embedding_dimensions: '1024',
        embedding_base_url: 'http://localhost:11434/',
      },
    });

    expect(settings).toEqual({
      provider: 'ollama',
      model: 'mxbai-embed-large',
      dimensions: 1024,
      baseURL: 'http://localhost:11434',
    });
  });

  test('environment variables win over engine config', () => {
    const settings = resolveEmbeddingSettingsFromSources({
      env: {
        GBRAIN_EMBEDDING_PROVIDER: 'openai',
        GBRAIN_EMBEDDING_MODEL: 'text-embedding-3-small',
        GBRAIN_EMBEDDING_DIMENSIONS: '512',
        GBRAIN_OPENAI_BASE_URL: 'https://example.com/v1/',
      },
      engineConfig: {
        embedding_provider: 'ollama',
        embedding_model: 'nomic-embed-text',
        embedding_dimensions: '768',
        embedding_base_url: 'http://localhost:11434',
      },
    });

    expect(settings).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 512,
      baseURL: 'https://example.com/v1',
    });
  });
});

describe('buildEmbeddingMigrationSql', () => {
  test('rebuilds the embedding column and clears stale vectors', () => {
    const sql = buildEmbeddingMigrationSql(768);

    expect(sql).toContain('DROP INDEX IF EXISTS idx_chunks_embedding');
    expect(sql).toContain('UPDATE content_chunks SET embedding = NULL, embedded_at = NULL');
    expect(sql).toContain('ALTER TABLE content_chunks');
    expect(sql).toContain('ALTER COLUMN embedding TYPE vector(768) USING NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding');
  });
});
