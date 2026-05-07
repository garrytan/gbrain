import { describe, test, expect } from 'bun:test';
import { getPGLiteSchema, PGLITE_SCHEMA_SQL } from '../../src/core/pglite-schema.ts';
import { getPostgresSchema } from '../../src/core/postgres-engine.ts';

describe('getPGLiteSchema', () => {
  test('default produces v0.13-compatible schema (1536d + text-embedding-3-large)', () => {
    const sql = getPGLiteSchema();
    expect(sql).toMatch(/vector\(1536\)/);
    expect(sql).toMatch(/'text-embedding-3-large'/);
    expect(sql).not.toMatch(/__EMBEDDING_DIMS__/);
    expect(sql).not.toMatch(/__EMBEDDING_MODEL__/);
  });

  test('Gemini 768d substitution', () => {
    const sql = getPGLiteSchema(768, 'gemini-embedding-001');
    expect(sql).toMatch(/vector\(768\)/);
    expect(sql).toMatch(/'gemini-embedding-001'/);
    expect(sql).toMatch(/\('embedding_model', 'gemini-embedding-001'\)/);
    expect(sql).toMatch(/\('embedding_dimensions', '768'\)/);
    expect(sql).not.toMatch(/vector\(1536\)/);
  });

  test('Voyage 1024d substitution', () => {
    const sql = getPGLiteSchema(1024, 'voyage-3-large');
    expect(sql).toMatch(/vector\(1024\)/);
    expect(sql).toMatch(/'voyage-3-large'/);
    expect(sql).toMatch(/\('embedding_model', 'voyage-3-large'\)/);
    expect(sql).toMatch(/\('embedding_dimensions', '1024'\)/);
    expect(sql).toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('Voyage 2048d skips unsupported HNSW index but keeps vector column', () => {
    const sql = getPGLiteSchema(2048, 'voyage-4-large');
    expect(sql).toMatch(/vector\(2048\)/);
    expect(sql).toMatch(/'voyage-4-large'/);
    expect(sql).toMatch(/\('embedding_dimensions', '2048'\)/);
    expect(sql).not.toContain('idx_chunks_embedding ON content_chunks USING hnsw');
    expect(sql).toContain('exact vector scans remain available');
  });

  test('PGLITE_SCHEMA_SQL back-compat constant is the default-dim schema', () => {
    expect(PGLITE_SCHEMA_SQL).toBe(getPGLiteSchema());
  });
});

describe('getPostgresSchema', () => {
  test('Voyage 2048d updates vector column and seeded config but skips HNSW', () => {
    const sql = getPostgresSchema(2048, 'voyage-4-large');
    expect(sql).toMatch(/vector\(2048\)/);
    expect(sql).toMatch(/\('embedding_model', 'voyage-4-large'\)/);
    expect(sql).toMatch(/\('embedding_dimensions', '2048'\)/);
    expect(sql).not.toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('escapes configured model before inserting into schema SQL literals', () => {
    const sql = getPostgresSchema(1024, "voyage-weird'quoted");
    expect(sql).toContain("'voyage-weird''quoted'");
    expect(sql).not.toContain("'voyage-weird'quoted'");
  });
});
