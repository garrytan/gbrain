import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ensureEmbeddingSchema } from '../src/core/embedding-config.ts';

async function getEmbeddingColumnType(engine: PGLiteEngine): Promise<string> {
  const result = await engine.db.query(`
    SELECT format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'content_chunks'
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `);
  return (result.rows[0] as { type: string }).type;
}

describe('ensureEmbeddingSchema', () => {
  test('migrates the vector column when config dimensions changed ahead of the schema', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    expect(await getEmbeddingColumnType(engine)).toBe('vector(1536)');

    await engine.setConfig('embedding_provider', 'ollama');
    await engine.setConfig('embedding_model', 'nomic-embed-text');
    await engine.setConfig('embedding_dimensions', '768');
    await engine.setConfig('embedding_base_url', 'http://127.0.0.1:11434');

    await ensureEmbeddingSchema(engine);

    expect(await getEmbeddingColumnType(engine)).toBe('vector(768)');

    await engine.disconnect();
  });
});
