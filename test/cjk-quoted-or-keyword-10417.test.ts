/**
 * #10417: CJK keyword search honors a quoted phrase and OR, as the non-CJK
 * branch does through websearch_to_tsquery.
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
});
afterAll(async () => { await engine.disconnect(); });

const count = async (q: string) => Number((await engine.executeRaw<{ n: string | number }>(
  `SELECT COUNT(*) AS n FROM (${buildKeywordCountStatement(q, undefined)!.sql}) x`, buildKeywordCountStatement(q, undefined)!.params))[0]!.n);
const pages = async (q: string) => { const s = buildKeywordPagesStatement(q, undefined, { limit: 10 })!;
  return (await engine.executeRaw<{ slug: string }>(s.sql, s.params)).map(r => r.slug).sort(); };
const chunks = async (q: string) => [...new Set((await engine.searchKeyword(q)).map(r => r.slug))].sort();

describe('#10417 CJK quoted phrases and OR', () => {
  test('groups: a quoted phrase is one exact substring, OR joins its neighbours, quotes never reach a pattern', () => {
    expect(cjkMatchGroups('"회귀 원인을"')).toEqual([['회귀 원인을']]);
    expect(cjkMatchGroups('"홍길동" OR "김철수"')).toEqual([['홍길동', '김철수']]);
    expect(cjkMatchGroups('혈당에서 수치')).toEqual([['혈당'], ['수치']]);
    expect(cjkMatchGroups('"東京で会議')).toEqual([['東京で会議']]);
    expect(cjkMatchGroups('東京 OR')).toEqual([['東京']]);
  });

  test('a quoted phrase matches only the page holding it contiguously', async () => {
    expect(await pages('"회귀 원인을"')).toEqual(['notes/regression']);
    expect(await chunks('"회귀 원인을"')).toEqual(['notes/regression']);
    expect(await count('"회귀 원인을"')).toBeGreaterThan(0);
    expect(await pages('회귀 원인을')).toEqual(['notes/regression', 'notes/split']);
  });

  test('OR finds pages with either name', async () => {
    expect(await pages('"홍길동" OR "김철수"')).toEqual(['notes/alice', 'notes/bob']);
    expect(await chunks('"홍길동" OR "김철수"')).toEqual(['notes/alice', 'notes/bob']);
  });
});
