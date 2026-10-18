/**
 * Postgres half of the bounded page-timeline keyword vector: a 2 MB diverse
 * timeline writes, the densest title/timeline/entries stay under the
 * tsvector lexeme cap, and the trigger, the seal expression, the reindex
 * backfill and the v245 upgrade build the same vector (byte-equal to
 * PGLite's for ASCII text). PGLite half: test/large-pages/page-timeline-tsvector-bound.test.ts.
 *
 * Gated by DATABASE_URL; skips without a real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import { backfillPageVectors } from '../../src/core/search-vector-backfill.ts';
import { PAGE_TIMELINE_ENTRIES_FTS_MAX_CHARS, PAGE_TIMELINE_FTS_MAX_CHARS, pageSearchVectorSql } from '../../src/core/fts-language.ts';
import {
  BEYOND_NEEDLE,
  diverseTimeline,
  hyphenPairs,
  pairsSpan,
  PREFIX_NEEDLE,
  TSVECTOR_MAX_STRING_BYTES,
  vectorMatches,
  vectorStringBytes,
} from '../helpers/diverse-timeline.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;
const TIMELINE = diverseTimeline(2_000_000);

const vectorText = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ v: string }>(`SELECT search_vector::text AS v FROM pages WHERE slug = $1`, [slug]))[0]!.v;

describePg('page timeline tsvector bound (Postgres)', () => {
  let pg: BrainEngine;
  let lite: PGLiteEngine;

  beforeAll(async () => {
    pg = await setupDB();
    lite = new PGLiteEngine();
    await lite.connect({});
    await lite.initSchema();
  }, 120_000);
  afterAll(async () => {
    await lite.disconnect();
    await teardownDB();
  }, 60_000);
  beforeEach(async () => {
    await pg.executeRaw(`DELETE FROM pages WHERE slug LIKE 'large/%'`);
  });

  test('a 2 MB diverse timeline writes; the vector holds the prefix, not text past the cut', async () => {
    await pg.putPage('large/diverse', { type: 'note', title: 'Diverse timeline', compiled_truth: 'Body.', timeline: TIMELINE });
    expect(await vectorStringBytes(pg, 'large/diverse')).toBeLessThan(TSVECTOR_MAX_STRING_BYTES);
    expect(await vectorMatches(pg, 'large/diverse', PREFIX_NEEDLE)).toBe(true);
    expect(await vectorMatches(pg, 'large/diverse', BEYOND_NEEDLE)).toBe(false);
  }, 60_000);

  test('the bounded vector of a long ASCII timeline is byte-equal to PGLite', async () => {
    // ASCII only: which astral code points count as letters follows each
    // server's Unicode tables, which differ between PGLite and a stock image.
    const ascii = TIMELINE.replace(/[^\x00-\x7f]+/gu, '');
    expect(ascii.length).toBeGreaterThan(1_000_000);
    for (const engine of [pg, lite]) {
      await engine.putPage('large/ascii', { type: 'note', title: 'ASCII timeline', compiled_truth: 'Body.', timeline: ascii });
    }
    expect(await vectorText(pg, 'large/ascii')).toBe(await vectorText(lite, 'large/ascii'));
    expect(await vectorMatches(pg, 'large/ascii', PREFIX_NEEDLE)).toBe(true);
  }, 60_000);

  test('worst title + densest timeline + densest entries stay under the lexeme cap', async () => {
    const title = hyphenPairs(0x4e00, 200);
    const pairs = Math.ceil(PAGE_TIMELINE_FTS_MAX_CHARS / 10) + 500;
    const page = await pg.putPage('large/worst', { type: 'note', title, compiled_truth: 'Body.', timeline: 'seed' });
    let cp = 0x20000 + pairsSpan(pairs, 4);
    const entries: string[] = [];
    for (let length = 0; length < PAGE_TIMELINE_ENTRIES_FTS_MAX_CHARS + 2_000; ) {
      const summary = hyphenPairs(cp, 20, 4);
      cp += pairsSpan(20, 4);
      entries.push(summary);
      length += summary.length;
    }
    for (let i = 0; i < 1_500; i++) entries.push(`carol${i.toString(36)} met acme-example`);
    await pg.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, summary) SELECT $1, DATE '2026-01-01', s FROM unnest($2::text[]) AS s`,
      [page.id, entries],
    );
    await pg.executeRaw(`UPDATE pages SET timeline = $2 WHERE slug = $1`, ['large/worst', hyphenPairs(0x20000, pairs, 4)]);
    const bytes = await vectorStringBytes(pg, 'large/worst');
    expect(bytes).toBeGreaterThan(600_000);
    expect(bytes).toBeLessThan(TSVECTOR_MAX_STRING_BYTES);
  }, 60_000);

  test('trigger, seal expression, reindex backfill and the v245 upgrade build the same vector', async () => {
    await pg.putPage('large/parity', { type: 'note', title: 'Parity page', compiled_truth: 'Body.', timeline: TIMELINE });
    await pg.putPage('large/short', { type: 'note', title: 'Short page', compiled_truth: 'Body.', timeline: '- 2026-01-01 Short entry.' });
    const fresh = await vectorText(pg, 'large/parity');
    const [sealed] = await pg.executeRaw<{ v: string }>(`SELECT (${pageSearchVectorSql('$1::text', '$2', 'english')})::text AS v`, ['Parity page', TIMELINE]);
    expect(sealed!.v).toBe(fresh);

    await pg.executeRaw(`UPDATE pages SET search_vector = to_tsvector('english', 'stale') WHERE slug LIKE 'large/%'`);
    await backfillPageVectors(pg, { lang: 'english', checkpoint: 'test_timeline_bound_reindex_pg' });
    expect(await vectorText(pg, 'large/parity')).toBe(fresh);

    await pg.executeRaw(`UPDATE pages SET search_vector = to_tsvector('english', 'stale') WHERE slug LIKE 'large/%'`);
    const migration = MIGRATIONS.find(m => m.name === 'page_search_vector_bounded_timeline')!;
    await migration.handler!(pg);
    expect(await vectorText(pg, 'large/parity')).toBe(fresh);
    expect(await vectorText(pg, 'large/short')).toBe(`'stale':1`);
  }, 120_000);
});
