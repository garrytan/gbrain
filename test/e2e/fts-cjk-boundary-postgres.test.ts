/**
 * #6370 Postgres parity: gbrain_fts_input() returns the same text and the same
 * tsvectors on Postgres as on PGLite, the glued ASCII tokens are found by
 * keyword and title search, and the fts_cjk_boundary migration rebuilds only
 * rows with a CJK boundary. PGLite half: test/fts-cjk-boundary.test.ts and
 * test/fts-cjk-boundary-search.test.ts.
 *
 * Gated by DATABASE_URL; skips without a real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;

const SAMPLES = [
  '升级PostgreSQL17后查询Redis7无返回',
  'サーバーはNginx1を使う',
  '서버는Caddy2를사용',
  '中a中a1中',
  'plain english text with Redis7',
  'café naïve — emoji 🚀 and e\u0301',
];

async function page(engine: BrainEngine, slug: string, title: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: body });
  await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
}

async function tokenize(engine: BrainEngine): Promise<Array<{ input: string; vector: string }>> {
  const out: Array<{ input: string; vector: string }> = [];
  for (const t of SAMPLES) {
    const rows = await engine.executeRaw<{ input: string; vector: string }>(
      `SELECT gbrain_fts_input($1) AS input, to_tsvector('english', gbrain_fts_input($1))::text AS vector`, [t]);
    out.push(rows[0]!);
  }
  return out;
}

describePg('CJK/Latin FTS boundary on Postgres (#6370)', () => {
  let pg: BrainEngine;
  let lite: PGLiteEngine;

  beforeAll(async () => {
    pg = await setupDB();
    lite = new PGLiteEngine();
    await lite.connect({});
    await lite.initSchema();
  });
  afterAll(async () => {
    await lite.disconnect();
    await teardownDB();
  });
  beforeEach(async () => {
    await pg.executeRaw(`DELETE FROM pages WHERE slug LIKE 'cjk6370/%'`);
  });

  test('the helper and its tsvectors match PGLite byte-for-byte', async () => {
    expect(await tokenize(pg)).toEqual(await tokenize(lite));
  });

  test('glued ASCII tokens are found by keyword and title search', async () => {
    await page(pg, 'cjk6370/upgrade', '升级PostgreSQL17指南', '升级PostgreSQL17后查询Redis7无返回');
    await page(pg, 'cjk6370/other', 'Unrelated', 'Nothing relevant here.');
    const kw = await pg.searchKeyword('Redis7');
    expect(kw.map((r) => r.slug).filter((s) => s.startsWith('cjk6370/'))).toEqual(['cjk6370/upgrade']);
    const titles = await pg.searchTitles('PostgreSQL17');
    expect(titles.map((r) => r.slug).filter((s) => s.startsWith('cjk6370/'))).toEqual(['cjk6370/upgrade']);
  });

  test('the migration rebuilds only rows with a CJK boundary', async () => {
    const migration = MIGRATIONS.find((m) => m.name === 'fts_cjk_boundary')!;
    await page(pg, 'cjk6370/cjk', 'CJK', '升级PostgreSQL17后查询Redis7无返回');
    await page(pg, 'cjk6370/latin', 'Latin', 'Redis7 is the cache.');
    await pg.executeRaw(`ALTER TABLE content_chunks DISABLE TRIGGER chunk_search_vector_trigger`);
    try {
      await pg.executeRaw(`UPDATE content_chunks c SET search_vector = to_tsvector('english', c.chunk_text)
        FROM pages p WHERE p.id = c.page_id AND p.slug = 'cjk6370/cjk'`);
      await pg.executeRaw(`UPDATE content_chunks c SET search_vector = 'sentinel'::tsvector
        FROM pages p WHERE p.id = c.page_id AND p.slug = 'cjk6370/latin'`);
    } finally {
      await pg.executeRaw(`ALTER TABLE content_chunks ENABLE TRIGGER chunk_search_vector_trigger`);
    }
    const vectors = async (slug: string) => (await pg.executeRaw<{ v: string }>(
      `SELECT c.search_vector::text AS v FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1`, [slug])).map((r) => r.v).join(' ');
    expect(await vectors('cjk6370/cjk')).not.toContain("'redis7'");
    await migration.handler!(pg);
    expect(await vectors('cjk6370/cjk')).toContain("'redis7'");
    expect(await vectors('cjk6370/latin')).toBe("'sentinel'");
  });
});
