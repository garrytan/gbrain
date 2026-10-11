/**
 * #6370: gbrain_fts_input() and the fts_cjk_boundary migration.
 *
 * - the helper splits CJK→ASCII-alnum and ASCII-alnum→CJK boundaries, is
 *   idempotent, and returns text without CJK unchanged (so every non-CJK
 *   tsvector is byte-identical);
 * - the runtime trigger builders are byte-identical to src/schema.sql's
 *   bodies, so the blob replay after a migration leaves the catalog unchanged;
 * - the migration rebuilds only rows whose text holds a boundary, resumes from
 *   its checkpoint and clears it.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { checkpointKey } from '../src/core/backfill-base.ts';
import {
  chunkSearchVectorTriggerFnSql,
  FTS_INPUT_FUNCTION_SQL,
  pageSearchVectorTriggerFnSql,
} from '../src/core/fts-language.ts';
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

async function ftsInput(t: string): Promise<string> {
  const rows = await engine.executeRaw<{ v: string }>('SELECT gbrain_fts_input($1) AS v', [t]);
  return rows[0]!.v;
}

const NON_CJK = [
  'plain english text with Redis7 and PostgreSQL17',
  'café naïve résumé — accented Latin',
  'e\u0301 combining acute, emoji 🚀🔥 and ZWJ 👩‍💻',
  'Ελληνικά, кириллица, עברית, العربية, ไทย',
  'punctuation: a-b_c.d/e:f (g) [h] {i} "j" \'k\'',
  '',
];

describe('gbrain_fts_input (#6370)', () => {
  test('splits both boundary directions in Han, Kana and Hangul', async () => {
    expect(await ftsInput('升级PostgreSQL17后查询Redis7无返回')).toBe('升级 PostgreSQL17 后查询 Redis7 无返回');
    expect(await ftsInput('サーバーはNginx1を使う')).toBe('サーバーは Nginx1 を使う');
    expect(await ftsInput('서버는Caddy2를사용')).toBe('서버는 Caddy2 를사용');
    expect(await ftsInput('中a中a1中')).toBe('中 a 中 a1 中');
  });

  test('is idempotent', async () => {
    for (const t of ['升级PostgreSQL17后查询Redis7无返回', '中a中a1中', 'a 中 b']) {
      const once = await ftsInput(t);
      expect(await ftsInput(once)).toBe(once);
    }
  });

  test('returns text without CJK unchanged, so its tsvector is byte-identical', async () => {
    for (const t of NON_CJK) {
      expect(await ftsInput(t)).toBe(t);
      const rows = await engine.executeRaw<{ a: string; b: string }>(
        `SELECT to_tsvector('english', $1)::text AS a, to_tsvector('english', gbrain_fts_input($1))::text AS b`, [t]);
      expect(rows[0]!.b).toBe(rows[0]!.a);
    }
  });

  test('CJK next to punctuation or spaces is left alone', async () => {
    for (const t of ['升级 PostgreSQL', '升级-PostgreSQL', '（Redis7）', '升级é']) expect(await ftsInput(t)).toBe(t);
  });

  test('is NULL-strict and declared immutable with a pinned search_path', async () => {
    const rows = await engine.executeRaw<{ n: string | null; vol: string; cfg: string[] }>(
      `SELECT gbrain_fts_input(NULL) AS n, p.provolatile AS vol, p.proconfig AS cfg FROM pg_proc p WHERE p.proname = 'gbrain_fts_input'`);
    expect(rows[0]!.n).toBeNull();
    expect(rows[0]!.vol).toBe('i');
    expect(rows[0]!.cfg).toEqual(['search_path=pg_catalog']);
  });
});

describe('one copy of the DDL', () => {
  // test-reads-source-ok[structural]: src/schema.sql is the generated Postgres blob; a fresh install must carry the runtime trigger bodies byte-for-byte or the upgrade replay drifts.
  const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');

  test('src/schema.sql carries the helper and the runtime trigger bodies byte-for-byte', () => {
    expect(schema).toContain(FTS_INPUT_FUNCTION_SQL);
    expect(schema).toContain(pageSearchVectorTriggerFnSql('english'));
    expect(schema).toContain(chunkSearchVectorTriggerFnSql('english'));
  });

  test('every indexing to_tsvector in src/schema.sql reads through the helper', () => {
    const calls = schema.match(/to_tsvector\('english', [^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/^to_tsvector\('english', gbrain_fts_input\(/);
  });
});

describe('fts_cjk_boundary migration (#6370)', () => {
  const migration = MIGRATIONS.find((m) => m.name === 'fts_cjk_boundary')!;
  const OLD_CHUNK = `setweight(to_tsvector('english', COALESCE(doc_comment, '')), 'A') || setweight(to_tsvector('english', COALESCE(symbol_name_qualified, '')), 'A') || setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'B')`;

  async function page(slug: string, title: string, body: string): Promise<void> {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: body });
    await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
  }

  /** The pre-migration state: CJK rows tokenized without the helper, others carrying a sentinel. */
  async function seedPreMigration(): Promise<void> {
    await page('notes/cjk', '升级PostgreSQL17指南', '升级PostgreSQL17后查询Redis7无返回');
    await page('notes/latin', 'Latin title', 'Redis7 is the cache.');
    await engine.executeRaw(`ALTER TABLE content_chunks DISABLE TRIGGER chunk_search_vector_trigger`);
    await engine.executeRaw(`UPDATE content_chunks c SET search_vector = ${OLD_CHUNK.replaceAll('COALESCE(', 'COALESCE(c.')}
      FROM pages p WHERE p.id = c.page_id AND p.slug = 'notes/cjk'`);
    await engine.executeRaw(`UPDATE content_chunks c SET search_vector = 'sentinel'::tsvector FROM pages p WHERE p.id = c.page_id AND p.slug = 'notes/latin'`);
    await engine.executeRaw(`ALTER TABLE content_chunks ENABLE TRIGGER chunk_search_vector_trigger`);
    await engine.executeRaw(`UPDATE pages SET search_vector = setweight(to_tsvector('english', title), 'A') WHERE slug = 'notes/cjk'`);
    await engine.executeRaw(`UPDATE pages SET search_vector = 'sentinel'::tsvector WHERE slug = 'notes/latin'`);
  }

  const chunkVectors = async (slug: string) => (await engine.executeRaw<{ v: string }>(
    `SELECT c.search_vector::text AS v FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 ORDER BY c.id`, [slug])).map((r) => r.v);
  const pageVector = async (slug: string) => (await engine.executeRaw<{ v: string }>(
    `SELECT search_vector::text AS v FROM pages WHERE slug = $1`, [slug]))[0]!.v;

  test('is registered handler-only and idempotent', () => {
    expect(migration).toBeDefined();
    expect(migration.sql).toBe('');
    expect(migration.idempotent).toBe(true);
  });

  test('rebuilds only rows with a CJK boundary and clears its checkpoints', async () => {
    await seedPreMigration();
    expect((await chunkVectors('notes/cjk')).join(' ')).not.toContain("'redis7'");
    await migration.handler!(engine);
    expect((await chunkVectors('notes/cjk')).join(' ')).toContain("'redis7'");
    expect(await pageVector('notes/cjk')).toContain("'postgresql17':2A");
    expect(await chunkVectors('notes/latin')).toEqual(["'sentinel'"]);
    expect(await pageVector('notes/latin')).toBe("'sentinel'");
    expect(await engine.getConfig(checkpointKey('fts_cjk_pages'))).toBeNull();
    expect(await engine.getConfig(checkpointKey('fts_cjk_content_chunks'))).toBeNull();
  });

  test('a rerun leaves the rebuilt vectors identical', async () => {
    await seedPreMigration();
    await migration.handler!(engine);
    const first = [await chunkVectors('notes/cjk'), await pageVector('notes/cjk')];
    await migration.handler!(engine);
    expect([await chunkVectors('notes/cjk'), await pageVector('notes/cjk')]).toEqual(first);
  });

  test('an interrupted run resumes after its saved cursor', async () => {
    await seedPreMigration();
    const [{ max }] = await engine.executeRaw<{ max: number }>(`SELECT max(c.id)::int AS max FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'notes/cjk'`);
    await engine.setConfig(checkpointKey('fts_cjk_content_chunks'), String(max));
    await migration.handler!(engine);
    expect((await chunkVectors('notes/cjk')).join(' ')).not.toContain("'redis7'");
    expect(await engine.getConfig(checkpointKey('fts_cjk_content_chunks'))).toBeNull();
  });

  test('the recreated trigger indexes new CJK writes through the helper', async () => {
    await migration.handler!(engine);
    await page('notes/new', 'New', 'サーバーはNginx1を使う');
    expect((await chunkVectors('notes/new')).join(' ')).toContain("'nginx1'");
  });
});
