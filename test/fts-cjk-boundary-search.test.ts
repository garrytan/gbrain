/**
 * #6370: Latin/digit tokens glued to CJK text are findable by keyword and
 * title search. Postgres' default parser reads Han/Kana/Hangul as letters, so
 * `升级PostgreSQL17后查询Redis7无返回` used to be one lexeme and an ASCII query
 * (`Redis7`) went through websearch_to_tsquery without matching it. Engine API
 * only, so the same file runs against a tree without the fix.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function page(slug: string, title: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: body });
  await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
}

const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug);

describe('CJK/Latin boundary in keyword search (#6370)', () => {
  test("the issue's chunk is found by the glued ASCII tokens", async () => {
    await page('notes/upgrade', 'Upgrade notes', '升级PostgreSQL17后查询Redis7无返回');
    await page('notes/other', 'Other', 'Nothing relevant here.');
    expect(slugs(await engine.searchKeyword('Redis7'))).toEqual(['notes/upgrade']);
    expect(slugs(await engine.searchKeyword('PostgreSQL17'))).toEqual(['notes/upgrade']);
  });

  test('Kana and Hangul boundaries split the same way', async () => {
    await page('notes/ja', 'Japanese', 'サーバーはNginx1を使う');
    await page('notes/ko', 'Korean', '서버는Caddy2를사용');
    expect(slugs(await engine.searchKeyword('Nginx1'))).toEqual(['notes/ja']);
    expect(slugs(await engine.searchKeyword('Caddy2'))).toEqual(['notes/ko']);
  });

  test('a glued title is found by its ASCII token and by the whole glued title', async () => {
    await page('guides/upgrade', '升级PostgreSQL17指南', 'Body text.');
    await page('guides/other', 'Unrelated title', 'Body text.');
    expect(slugs(await engine.searchTitles('PostgreSQL17'))).toEqual(['guides/upgrade']);
    expect(slugs(await engine.searchTitles('升级PostgreSQL17指南'))).toEqual(['guides/upgrade']);
  });

  test('pure Latin search is unchanged', async () => {
    await page('notes/latin', 'Redis notes', 'Redis7 is the cache we upgraded.');
    expect(slugs(await engine.searchKeyword('Redis7'))).toEqual(['notes/latin']);
    expect(slugs(await engine.searchTitles('Redis notes'))).toEqual(['notes/latin']);
  });
});
