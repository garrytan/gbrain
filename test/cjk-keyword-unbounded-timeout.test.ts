/**
 * Keyword-only CJK search (no cjkKeyword bound) must not surface a statement
 * timeout (SQLSTATE 57014) as an error: it retries the capped stage.
 */
import { describe, expect, test } from 'bun:test';
import { searchKeywordCJK, type ScopedReadRunner } from '../src/core/engine-sql/cjk-search.ts';
import { scopedRead } from '../src/core/engine-sql/brands.ts';
import type { SqlExecutor } from '../src/core/engine-sql/executor.ts';

const ctx = {
  limit: 5, offset: 0, innerLimit: 10, sourceFactorCase: '1', hardExcludeClause: '',
  visibilityClause: '', detailFilter: '', opts: undefined, dedup: true,
};

describe('searchKeywordCJK without a bound', () => {
  test('a timed-out full scoring statement does not throw', async () => {
    const seen: string[] = [];
    const scoped: ScopedReadRunner = async (read) => {
      const exec = scopedRead({
        unsafe: async (sql: string) => {
          seen.push(sql);
          if (seen.length === 1) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
          return { rows: [] };
        },
      } as unknown as SqlExecutor);
      return read(exec);
    };
    const outcome = await searchKeywordCJK(scoped, '会議 資料 確認', ctx).then(
      (value) => ({ value, error: null as unknown }),
      (error) => ({ value: null, error }),
    );
    expect(outcome.error).toBeNull();
    expect(outcome.value).toEqual([]);
    expect(seen.length).toBeGreaterThan(1);
  });
});

describe('searchKeywordCJK without a bound, retry also times out', () => {
  test('reports keyword_candidates_incomplete timeout instead of a silent empty result', async () => {
    const scoped: ScopedReadRunner = async (read) => read(scopedRead({
      unsafe: async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
    } as unknown as SqlExecutor));
    const reasons: string[] = [];
    const rows = await searchKeywordCJK(scoped, '会議 資料 確認', {
      ...ctx, opts: { onKeywordIncomplete: (r: string) => { reasons.push(r); } },
    } as never);
    expect(rows).toEqual([]);
    expect(reasons).toEqual(['timeout']);
  });
});
