/**
 * GST-4037: follow-ups to #10417's CJK quoted phrases and OR.
 * A) The hybrid any-term retry keeps a quoted phrase required: it relaxes only an alternative's unquoted words.
 * B) With OR alternatives the strict pass and the any-term retry order the rows they share the same way, so OFFSET paging
 *    that crosses from one pass to the other never repeats or skips a page.
 * C) A term named by many OR alternatives binds once, so a long OR query stays far from Postgres's bind limit.
 * PGLite (repo-less).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { buildKeywordCountStatement, buildKeywordPagesStatement } from '../src/core/search/keyword-statement.ts';
import { buildCJKCandidateSql, type CjkKeywordCtx } from '../src/core/search/cjk-keyword-sql.ts';
import { cjkMatchAlternatives } from '../src/core/cjk.ts';

let engine: PGLiteEngine;
async function page(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
  await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
}
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await page('notes/phrase', '東京大学で研究した');
  await page('notes/partial', '研究 論文 だけ');
  await page('notes/osaka-loud', '大阪 '.repeat(20));
  await page('notes/osaka', '大阪 '.repeat(10));
  await page('notes/kansai', '京都 神戸 奈良');
  await page('notes/kyoto', '京都 の 記録');
  for (let i = 0; i < 3; i++) await page(`notes/tokyo-${i}`, `東京 項目${i}`);
});
afterAll(async () => { await engine.disconnect(); });

const slugs = async (q: string, opts: Record<string, unknown>) => [...new Set((await engine.searchKeyword(q, opts)).map(r => r.slug))];

describe('GST-4037 CJK keyword follow-ups', () => {
  test('A: the any-term retry never returns a chunk without the quoted phrase', async () => {
    const q = '"東京大学" 研究 論文';
    expect(await slugs(q, { limit: 10 })).toEqual([]);
    expect(await slugs(q, { limit: 10, orFallback: true })).toEqual(['notes/phrase']);
    const ctx: CjkKeywordCtx = { limit: 10, offset: 0, innerLimit: 50, sourceFactorCase: '1.0', hardExcludeClause: '', visibilityClause: '', detailFilter: '', opts: undefined, dedup: true };
    const stage = buildCJKCandidateSql(q, ctx, { match: 'any', cap: 100 })!;
    const ids = (await engine.executeRaw<{ chunk_id: number }>(stage.sql, stage.params)).map(r => Number(r.chunk_id));
    const [phrase] = await engine.executeRaw<{ id: number }>("SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'notes/phrase'");
    expect(ids).toEqual([Number(phrase!.id)]);
  });

  test('B: OFFSET paging across the strict pass and the any-term retry returns every OR match once', async () => {
    const q = '大阪 OR 京都 神戸 奈良';
    const first = await slugs(q, { limit: 2, offset: 0, orFallback: true });
    const second = await slugs(q, { limit: 2, offset: 2, orFallback: true });
    const seen = [...first, ...second];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(['notes/osaka-loud', 'notes/osaka', 'notes/kansai']));
    expect(seen.indexOf('notes/kyoto')).toBe(3);
  });

  test('C: a term every OR alternative names is bound once, and the statements still match', async () => {
    const q = Array.from({ length: 50 }, (_, i) => `東京 項目${i}`).join(' OR ');
    const pagesStmt = buildKeywordPagesStatement(q, undefined, { limit: 10 })!;
    expect(pagesStmt.params.filter(p => p === '%東京%')).toHaveLength(1);
    const countStmt = buildKeywordCountStatement(q, undefined)!;
    expect(countStmt.params.filter(p => typeof p === 'string' && p.startsWith('%'))).toHaveLength(51);
    expect(Number((await engine.executeRaw<{ n: number }>(countStmt.sql, countStmt.params))[0]!.n)).toBe(3);
    expect((await engine.executeRaw<{ slug: string }>(pagesStmt.sql, pagesStmt.params)).map(r => r.slug).sort()).toEqual(['notes/tokyo-0', 'notes/tokyo-1', 'notes/tokyo-2']);
  });

  test('alternatives with the same words but different quotes both relax, in either order', async () => {
    for (const q of ['"東京" 京都 OR 東京 京都', '東京 京都 OR "東京" 京都']) {
      expect(cjkMatchAlternatives(q)).toHaveLength(2);
      expect(await slugs(q, { limit: 10 })).toEqual([]);
      expect(await slugs(q, { limit: 10, orFallback: true })).toEqual(expect.arrayContaining(['notes/kyoto', 'notes/kansai', 'notes/tokyo-0']));
    }
  });
});
