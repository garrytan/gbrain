import { describe, expect, test } from 'bun:test';
import { buildKeywordCountStatement, buildKeywordPagesStatement } from '../src/core/search/keyword-statement.ts';

describe('remote page keyword indexed match', () => {
  const opts = { excludePrivate: true, sourceIds: ['example'], types: ['email'], language: 'en', exclude_slugs: ['hidden'] };
  test('count and page queries fence the same full-text candidates before visibility joins', () => {
    const count = buildKeywordCountStatement('common', opts)!;
    const page = buildKeywordPagesStatement('common', opts, { limit: 5 })!;
    const fence = "(SELECT * FROM content_chunks WHERE search_vector @@ websearch_to_tsquery('english', $1) AND modality = 'text' OFFSET 0) cc JOIN pages";
    for (const statement of [count, page]) {
      expect(statement.sql).toContain(fence);
      expect(statement.sql).toContain('p.source_id = ANY(');
      expect(statement.sql).toContain('p.deleted_at IS NULL');
      expect(statement.sql).toContain("'quarantine'");
      expect(statement.sql).toContain('cc.body_generation');
      expect(statement.sql).toContain('cc.modality =');
      expect(statement.params[0]).toBe('common');
    }
    expect(page.params.slice(0, count.params.length)).toEqual(count.params);
    expect(page.sql).toContain('DISTINCT ON (page_id)');
    expect(page.sql).not.toContain('LIMIT 50000');
  });
  test('local and CJK reads retain their existing match paths', () => {
    expect(buildKeywordCountStatement('common', { excludePrivate: false })!.sql).not.toContain('OFFSET 0');
    expect(buildKeywordPagesStatement('中文', opts, { limit: 5 })!.sql).not.toContain('OFFSET 0');
  });
});
