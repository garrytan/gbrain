import { describe, test, expect, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const ENV_KEYS = [
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'GBRAIN_EMBEDDING_BASE_URL',
  'GBRAIN_EMBEDDING_API_KEY',
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function basis(dim: number): Float32Array {
  const v = new Float32Array(dim);
  v[0] = 1;
  return v;
}

describe('PGLite embedding dimension configuration', () => {
  test('initializes a 2560-dimension Perplexity brain without HNSW index', async () => {
    process.env.GBRAIN_EMBEDDING_MODEL = 'pplx-embed-context-v1-4b';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '2560';
    process.env.GBRAIN_EMBEDDING_BASE_URL = 'http://127.0.0.1:8790/v1';

    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();

      const typeRows = await (engine as any).db.query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS typ
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname = 'content_chunks'
            AND a.attname = 'embedding'
            AND NOT a.attisdropped`,
      );
      expect(typeRows.rows[0].typ).toBe('vector(2560)');

      const indexRows = await (engine as any).db.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'content_chunks' AND indexname = 'idx_chunks_embedding'`,
      );
      expect(indexRows.rows).toHaveLength(0);

      const configRows = await (engine as any).db.query(
        `SELECT key, value FROM config WHERE key IN ('embedding_model', 'embedding_dimensions', 'embedding_base_url')`,
      );
      const config = Object.fromEntries(configRows.rows.map((r: any) => [r.key, r.value]));
      expect(config.embedding_model).toBe('pplx-embed-context-v1-4b');
      expect(config.embedding_dimensions).toBe('2560');
      expect(config.embedding_base_url).toBe('http://127.0.0.1:8790/v1');

      await engine.putPage('perplexity/test', {
        type: 'concept',
        title: 'Perplexity Test',
        compiled_truth: 'Perplexity embeddings are 2560 dimensional.',
      });
      await engine.upsertChunks('perplexity/test', [{
        chunk_index: 0,
        chunk_text: 'Perplexity embeddings are 2560 dimensional.',
        chunk_source: 'compiled_truth',
        embedding: basis(2560),
        model: 'pplx-embed-context-v1-4b',
        token_count: 8,
      }]);

      const results = await engine.searchVector(basis(2560), { limit: 5 });
      expect(results[0]?.slug).toBe('perplexity/test');
    } finally {
      await engine.disconnect();
    }
  });
});
