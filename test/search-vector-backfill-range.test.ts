/**
 * Every backfill statement scans a bounded id range (fts_cjk_boundary on a
 * brain with little CJK text). Before, a filtered batch was "the next 5000
 * matching rows": on a brain with none, one statement scanned the whole table
 * looking for them, could pass statement_timeout, and never advanced the
 * checkpoint, so every retry failed the same way. Now each statement covers
 * `id > cursor AND id <= cursor + range`, the checkpoint advances to the range
 * end even with zero matches, and the run stops at the first batch's max(id).
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkpointKey } from '../src/core/backfill-base.ts';
import { FTS_CJK_BOUNDARY_REGEX } from '../src/core/fts-language.ts';
import { backfillChunkVectors, backfillPageVectors } from '../src/core/search-vector-backfill.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const RANGE = 100;
const FAR = 1000;
const RE = `'${FTS_CJK_BOUNDARY_REGEX}'`;
const PAGE_WHERE = `title ~ ${RE} OR timeline ~ ${RE}`;
const CHUNK_WHERE = `chunk_text ~ ${RE} OR doc_comment ~ ${RE} OR symbol_name_qualified ~ ${RE}`;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function page(slug: string, title: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: body, timeline: '', frontmatter: {} });
  await installFixtureChunks(engine, slug, await prepareMarkdownChunks({ compiled_truth: body, timeline: '' }));
}

/** Latin rows at low ids, then the id sequences jump so the only CJK rows sit several ranges further on, with stale vectors. */
async function seed(): Promise<void> {
  for (let i = 0; i < 5; i++) await page(`notes/latin-${i}`, `Latin ${i}`, `Redis7 cache note ${i}.`);
  await engine.executeRaw(`SELECT setval(pg_get_serial_sequence('pages', 'id'), ${FAR})`);
  await engine.executeRaw(`SELECT setval(pg_get_serial_sequence('content_chunks', 'id'), ${FAR})`);
  await page('notes/cjk', '升级PostgreSQL17指南', '升级PostgreSQL17后查询Redis7无返回');
  await engine.executeRaw(`ALTER TABLE content_chunks DISABLE TRIGGER chunk_search_vector_trigger`);
  await engine.executeRaw(`UPDATE content_chunks c SET search_vector = 'stale'::tsvector FROM pages p WHERE p.id = c.page_id AND p.slug = 'notes/cjk'`);
  await engine.executeRaw(`ALTER TABLE content_chunks ENABLE TRIGGER chunk_search_vector_trigger`);
  await engine.executeRaw(`UPDATE pages SET search_vector = 'stale'::tsvector WHERE slug = 'notes/cjk'`);
}

/** Records each backfill statement's scanned range and each checkpoint write. */
function observe(failOnBatch?: number) {
  const ranges: Array<[number, number]> = [];
  const checkpoints: number[] = [];
  const real = engine.executeRaw.bind(engine);
  const exec = spyOn(engine, 'executeRaw').mockImplementation((async (sql: string, params?: unknown[]) => {
    const m = /id > (\d+)(?: AND id <= (\d+))?/.exec(sql);
    if (m && /^\s*WITH bound|^\s*UPDATE (pages SET id = id|content_chunks SET search_vector)/.test(sql)) {
      ranges.push([Number(m[1]), m[2] === undefined ? Infinity : Number(m[2])]);
      if (ranges.length === failOnBatch) throw new Error('injected batch failure');
    }
    return real(sql, params);
  }) as typeof engine.executeRaw);
  const realSet = engine.setConfig.bind(engine);
  const set = spyOn(engine, 'setConfig').mockImplementation((async (key: string, value: string) => {
    if (key.startsWith('backfill.range-test')) checkpoints.push(Number(value));
    return realSet(key, value);
  }) as typeof engine.setConfig);
  return { ranges, checkpoints, restore: () => { exec.mockRestore(); set.mockRestore(); } };
}

const chunkVectors = async () => (await engine.executeRaw<{ v: string }>(
  `SELECT c.search_vector::text AS v FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'notes/cjk'`)).map(r => r.v);
const pageVector = async () => (await engine.executeRaw<{ v: string }>(`SELECT search_vector::text AS v FROM pages WHERE slug = 'notes/cjk'`))[0]!.v;

describe('backfill statements scan a bounded id range', () => {
  for (const [label, run, rebuilt] of [
    ['chunks', () => backfillChunkVectors(engine, { lang: 'english', checkpoint: 'range-test', where: CHUNK_WHERE, range: RANGE }), chunkVectors],
    ['pages', () => backfillPageVectors(engine, { lang: 'english', checkpoint: 'range-test', where: PAGE_WHERE, range: RANGE }), async () => [await pageVector()]],
  ] as const) {
    test(`${label}: every batch covers one range and advances the checkpoint; the far CJK rows are rebuilt`, async () => {
      await seed();
      const o = observe();
      try {
        await run();
      } finally {
        o.restore();
      }
      expect(o.ranges.length).toBeGreaterThanOrEqual(FAR / RANGE);
      for (const [from, to] of o.ranges) expect(to - from).toBe(RANGE);
      expect(o.ranges.map(r => r[0])).toEqual([0, ...o.ranges.slice(0, -1).map(r => r[1])]);
      expect(o.checkpoints).toEqual(o.ranges.map(r => r[1]));
      for (const v of await rebuilt()) {
        expect(v).not.toBe("'stale'");
        expect(v).toContain("'postgresql17'");
      }
    });

    test(`${label}: an interrupted run resumes from the checkpoint of the last finished batch`, async () => {
      await seed();
      const first = observe(4);
      try {
        await expect(run()).rejects.toThrow('injected batch failure');
      } finally {
        first.restore();
      }
      expect(Number(await engine.getConfig(checkpointKey('range-test')))).toBe(3 * RANGE);
      const second = observe();
      try {
        await run();
      } finally {
        second.restore();
      }
      expect(second.ranges[0]).toEqual([3 * RANGE, 4 * RANGE]);
      for (const v of await rebuilt()) expect(v).toContain("'postgresql17'");
    });
  }
});
