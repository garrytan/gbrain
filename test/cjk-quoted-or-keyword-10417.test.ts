/**
 * #10417: CJK keyword search honors a quoted phrase and OR (with its precedence:
 * `a OR b c` is `a | (b & c)`), as the non-CJK branch does through
 * websearch_to_tsquery.
 *
 * Before the fix a CJK query was split on whitespace with quotes kept, so
 * `"회귀 원인을"` required the patterns `%"회귀%` and `%원인을"%` (no page
 * matched) and `"홍길동" OR "김철수"` required three patterns, `OR` included
 * (no page matched). The strict count, the keyword pages and the chunk search
 * (engine.searchKeyword) now read the same groups. PGLite (repo-less).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { buildKeywordCountStatement, buildKeywordPagesStatement } from '../src/core/search/keyword-statement.ts';
import { cjkMatchGroups } from '../src/core/cjk.ts';
import { buildCJKKeywordSql } from '../src/core/search/cjk-keyword-sql.ts';

let engine: PGLiteEngine;
async function page(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
  await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
}
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await page('notes/regression', '이번 회귀 원인을 분석했다.');
  await page('notes/split', '회귀 테스트를 추가했다. 원인을 아직 모른다.');
  await page('notes/alice', '홍길동 회의록');
  await page('notes/bob', '김철수 메모');
  await page('notes/tokyo', '東京で会議があった');
  await page('notes/seoul', '서울 출장 메모');
  await page('notes/busan', '부산 출장 메모');
  await page('notes/busan-jeju', '부산 그리고 제주 출장 메모');
  await page('notes/daejeon', '대전 기록');
  await page('notes/gwangju-ulsan', '광주 울산 기록');
  await page('notes/ulsan-pohang', '울산 포항 기록');
  await page('notes/gwangju-loud', '광주 울산 '.repeat(40));
  await page('notes/ulsan-loud', '울산 포항 '.repeat(40));
});
afterAll(async () => { await engine.disconnect(); });

const count = async (q: string) => { const s = buildKeywordCountStatement(q, undefined)!;
  return Number((await engine.executeRaw<{ n: string | number }>(s.sql, s.params))[0]!.n); };
const pages = async (q: string) => { const s = buildKeywordPagesStatement(q, undefined, { limit: 10 })!;
  return (await engine.executeRaw<{ slug: string }>(s.sql, s.params)).map(r => r.slug).sort(); };
const chunks = async (q: string) => [...new Set((await engine.searchKeyword(q)).map(r => r.slug))].sort();

describe('#10417 CJK quoted phrases and OR', () => {
  test('groups: a quoted phrase is one exact substring, OR joins its neighbours, quotes never reach a pattern', () => {
    expect(cjkMatchGroups('"회귀 원인을"')).toEqual([['회귀 원인을']]);
    expect(cjkMatchGroups('"홍길동" OR "김철수"')).toEqual([['홍길동'], ['김철수']]);
    expect(cjkMatchGroups('혈당에서 수치')).toEqual([['혈당', '수치']]);
    expect(cjkMatchGroups('서울 or 부산 제주')).toEqual([['서울'], ['부산', '제주']]);
    expect(cjkMatchGroups('"東京で会議')).toEqual([['東京で会議']]);
    expect(cjkMatchGroups('東京 OR')).toEqual([['東京']]);
  });

  test('a quoted phrase matches only the page holding it contiguously', async () => {
    expect(await pages('"회귀 원인을"')).toEqual(['notes/regression']);
    expect(await chunks('"회귀 원인을"')).toEqual(['notes/regression']);
    expect(await count('"회귀 원인을"')).toBe(1);
    expect(await pages('회귀 원인을')).toEqual(['notes/regression', 'notes/split']);
  });

  test('OR binds looser than AND and is case-insensitive, as in websearch_to_tsquery', async () => {
    for (const q of ['서울 OR 부산 제주', '서울 or 부산 제주']) {
      expect(await pages(q)).toEqual(['notes/busan-jeju', 'notes/seoul']);
      expect(await chunks(q)).toEqual(['notes/busan-jeju', 'notes/seoul']);
      expect(await count(q)).toBe(2);
    }
  });

  test('the any-term fallback keeps a page that satisfies one alternative above partial matches of a longer one', async () => {
    const q = '대전 OR 광주 울산 포항';
    expect(await pages(q)).toEqual(['notes/daejeon']);
    expect([...new Set((await engine.searchKeyword(q, { limit: 2, orFallback: true })).map(r => r.slug))]).toContain('notes/daejeon');
  });

  test('a boosted partial match that repeats its terms still ranks below a page satisfying an alternative', async () => {
    const built = buildCJKKeywordSql('대전 OR 광주 울산 포항', { limit: 2, offset: 0, sourceFactorCase: '100.0', hardExcludeClause: '',
      visibilityClause: '', detailFilter: '', opts: undefined, dedup: true }, { match: 'any' })!;
    const ranked = (await engine.executeRaw<{ slug: string }>(built.sql, built.params)).map(r => r.slug);
    expect(ranked[0]).toBe('notes/daejeon');
  });

  test('building the SQL for a very long CJK query stays linear in its terms', () => {
    const terms = Array.from({ length: 40_000 }, (_, i) => String.fromCharCode(0xAC00 + (i % 11_172)) + String.fromCharCode(0xAC00 + Math.floor(i / 11_172)));
    const started = performance.now();
    expect(buildCJKKeywordSql(terms.join(' '), { limit: 10, offset: 0, sourceFactorCase: '1.0', hardExcludeClause: '',
      visibilityClause: '', detailFilter: '', opts: undefined, dedup: true })).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('OR finds pages with either name', async () => {
    expect(await pages('"홍길동" OR "김철수"')).toEqual(['notes/alice', 'notes/bob']);
    expect(await chunks('"홍길동" OR "김철수"')).toEqual(['notes/alice', 'notes/bob']);
  });
});
