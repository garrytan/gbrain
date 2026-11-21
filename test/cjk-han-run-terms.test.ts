import { describe, test, expect } from 'bun:test';
import { cjkMatchTerms } from '../src/core/cjk.ts';

describe('cjkMatchTerms spaceless Han phrases', () => {
  test('a spaceless Chinese question yields bigram terms, not one verbatim term', () => {
    const terms = cjkMatchTerms('怎么设置团队版的席位数量？');
    expect(terms).toContain('席位');
    expect(terms).not.toContain('怎么设置团队版的席位数量？');
  });

  test('short Han terms and spaced queries are unchanged', () => {
    expect(cjkMatchTerms('席位 升级')).toEqual(['席位', '升级']);
  });
});
