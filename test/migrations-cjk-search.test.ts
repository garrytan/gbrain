import { describe, expect, test } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';

describe('indexed CJK keyword search migration', () => {
  const migration = MIGRATIONS.find(item => item.version === 109);

  test('registers an idempotent migration after the current schema head', () => {
    expect(migration).toBeDefined();
    expect(migration?.name).toBe('indexed_cjk_search_tokens');
    expect(migration?.idempotent).toBe(true);
  });

  test('adds an immutable CJK unigram and bigram tokenizer', () => {
    expect(migration!.sql).toContain('pmbrain_cjk_search_tokens');
    expect(migration!.sql).toMatch(/RETURNS TEXT[\s\S]*IMMUTABLE/);
    expect(migration!.sql).toContain('LEFT JOIN chars next_char');
  });

  test('keeps English FTS and appends simple-config CJK tokens to search_vector', () => {
    expect(migration!.sql).toContain("to_tsvector('english'");
    expect(migration!.sql).toContain("to_tsvector('simple', pmbrain_cjk_search_tokens");
    expect(migration!.sql).toContain('CREATE OR REPLACE FUNCTION update_chunk_search_vector');
  });

  test('backfills existing chunks so old users gain Chinese search immediately', () => {
    expect(migration!.sql).toMatch(/UPDATE content_chunks[\s\S]*SET search_vector/);
    expect(migration!.sql).not.toContain('ILIKE');
  });
});
