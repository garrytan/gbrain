import { describe, test, expect } from 'bun:test';
import { pgliteSchema, PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { postgresSchema, SCHEMA_SQL } from '../src/core/schema-embedded.ts';

/**
 * Schema templating must:
 *   1) default to (1536, 'text-embedding-3-large') — backward compat
 *   2) substitute vector(dim) + DEFAULT 'model' when opts given
 *   3) not leak template placeholder strings into the SQL output
 *   4) keep the const aliases identical to the default-function output
 */

describe('pgliteSchema', () => {
  test('defaults to 1536d + text-embedding-3-large', () => {
    const sql = pgliteSchema();
    expect(sql).toContain('vector(1536)');
    expect(sql).toContain("DEFAULT 'text-embedding-3-large'");
    expect(sql).toContain("('embedding_model', 'text-embedding-3-large')");
    expect(sql).toContain("('embedding_dimensions', '1536')");
  });

  test('templates to Ollama dims + model when opts given', () => {
    const sql = pgliteSchema({ dimensions: 768, defaultModel: 'nomic-embed-text' });
    expect(sql).toContain('vector(768)');
    expect(sql).not.toContain('vector(1536)');
    expect(sql).toContain("DEFAULT 'nomic-embed-text'");
    expect(sql).not.toContain("DEFAULT 'text-embedding-3-large'");
    expect(sql).toContain("('embedding_model', 'nomic-embed-text')");
    expect(sql).toContain("('embedding_dimensions', '768')");
  });

  test('no template placeholder strings leak into output', () => {
    const sql = pgliteSchema({ dimensions: 1024, defaultModel: 'mxbai-embed-large' });
    expect(sql).not.toContain('${');
    expect(sql).not.toContain('undefined');
    expect(sql).not.toContain('null');
  });

  test('const alias matches default function output', () => {
    expect(PGLITE_SCHEMA_SQL).toBe(pgliteSchema());
  });

  test('partial opts — only dimensions', () => {
    const sql = pgliteSchema({ dimensions: 3072 });
    expect(sql).toContain('vector(3072)');
    expect(sql).toContain("DEFAULT 'text-embedding-3-large'"); // falls back to default model
  });

  test('partial opts — only model', () => {
    const sql = pgliteSchema({ defaultModel: 'voyage-3' });
    expect(sql).toContain('vector(1536)'); // falls back to default dim
    expect(sql).toContain("DEFAULT 'voyage-3'");
  });
});

describe('postgresSchema', () => {
  test('defaults to 1536d + text-embedding-3-large', () => {
    const sql = postgresSchema();
    expect(sql).toContain('vector(1536)');
    expect(sql).toContain("DEFAULT 'text-embedding-3-large'");
  });

  test('templates to Ollama dims + model', () => {
    const sql = postgresSchema({ dimensions: 768, defaultModel: 'nomic-embed-text' });
    expect(sql).toContain('vector(768)');
    expect(sql).toContain("DEFAULT 'nomic-embed-text'");
    expect(sql).toContain("('embedding_model', 'nomic-embed-text')");
    expect(sql).toContain("('embedding_dimensions', '768')");
  });

  test('preserves Postgres dollar-quoted functions after templating', () => {
    const sql = postgresSchema({ dimensions: 768, defaultModel: 'nomic-embed-text' });
    // Dollar-quoted plpgsql function bodies must survive the template (they use $$ markers)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION update_page_search_vector()');
    expect(sql).toContain('LANGUAGE plpgsql');
    // Two function definitions
    expect((sql.match(/\$\$ LANGUAGE plpgsql/g) || []).length).toBe(2);
  });

  test('const alias matches default function output', () => {
    expect(SCHEMA_SQL).toBe(postgresSchema());
  });
});

describe('schema drift between PGLite and Postgres', () => {
  test('both schemas have matching embedding dim when called with same opts', () => {
    const p = pgliteSchema({ dimensions: 768, defaultModel: 'nomic-embed-text' });
    const g = postgresSchema({ dimensions: 768, defaultModel: 'nomic-embed-text' });
    expect(p).toContain('vector(768)');
    expect(g).toContain('vector(768)');
    expect(p).toContain("DEFAULT 'nomic-embed-text'");
    expect(g).toContain("DEFAULT 'nomic-embed-text'");
  });
});
