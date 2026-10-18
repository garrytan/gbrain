/**
 * The page keyword vector indexes a bounded timeline prefix, so a page with
 * a large diverse timeline writes instead of overflowing the tsvector cap.
 *
 * 1. Protects: page writes with multi-MB timelines (a diverse timeline over
 *    about 1 MB failed the whole write with "string is too long for
 *    tsvector"), and identical vectors from every writer: the trigger, the
 *    seal's pageSearchVectorSql, the reindex backfill and the v245 upgrade.
 * 2. Fails when: either timeline cut is dropped or raised past what fits
 *    (the densest measured text, worst title included, must stay under the
 *    lexeme cap), the writers drift apart, or the upgrade misses a long
 *    page or rewrites a short one.
 * 3. Existing coverage: test/page-search-vector-overflow.test.ts covers the
 *    compiled_truth half (#2704); test/fts-cjk-boundary.test.ts pins the
 *    trigger body against schema.sql. Postgres half:
 *    test/e2e/page-timeline-tsvector-bound-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import { backfillPageVectors } from '../../src/core/search-vector-backfill.ts';
import { PAGE_TIMELINE_ENTRIES_FTS_MAX_CHARS, PAGE_TIMELINE_FTS_MAX_CHARS, pageSearchVectorSql } from '../../src/core/fts-language.ts';
import { sanitizeRemoteBody } from '../../src/core/remote-body.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
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

let engine: PGLiteEngine;
const TIMELINE = diverseTimeline(2_000_000);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });

const vectorText = async (slug: string) =>
  (await engine.executeRaw<{ v: string }>(`SELECT search_vector::text AS v FROM pages WHERE slug = $1`, [slug]))[0]!.v;

describe('page timeline tsvector bound (PGLite)', () => {
  test('a 2 MB diverse timeline writes; the vector holds the prefix, not text past the cut', async () => {
    expect(TIMELINE.length).toBeGreaterThanOrEqual(2_000_000);
    await engine.putPage('large/diverse', { type: 'note', title: 'Diverse timeline', compiled_truth: 'Body.', timeline: TIMELINE });
    expect(await vectorStringBytes(engine, 'large/diverse')).toBeLessThan(TSVECTOR_MAX_STRING_BYTES);
    expect(await vectorMatches(engine, 'large/diverse', PREFIX_NEEDLE)).toBe(true);
    expect(await vectorMatches(engine, 'large/diverse', BEYOND_NEEDLE)).toBe(false);
  }, 60_000);

  test('worst title + densest timeline + densest entries stay under the lexeme cap', async () => {
    // The title btree (idx_pages_source_title_lower, 2,704-byte rows) caps a
    // title near 2.7 KB; 200 CJK pairs are 2,400 bytes of the densest text.
    const title = hyphenPairs(0x4e00, 200);
    const timeline = hyphenPairs(0x20000, Math.ceil(PAGE_TIMELINE_FTS_MAX_CHARS / 10) + 500, 4);
    const page = await engine.putPage('large/worst', { type: 'note', title, compiled_truth: 'Body.', timeline: 'seed' });
    let cp = 0x20000 + pairsSpan(Math.ceil(PAGE_TIMELINE_FTS_MAX_CHARS / 10) + 500, 4);
    const entries: string[] = [];
    for (let length = 0; length < PAGE_TIMELINE_ENTRIES_FTS_MAX_CHARS + 2_000; ) {
      const summary = hyphenPairs(cp, 20, 4);
      cp += pairsSpan(20, 4);
      entries.push(summary);
      length += summary.length;
    }
    for (let i = 0; i < 1_500; i++) entries.push(`carol${i.toString(36)} met acme-example`);
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, summary) SELECT $1, DATE '2026-01-01', s FROM unnest($2::text[]) AS s`,
      [page.id, entries],
    );
    await engine.executeRaw(`UPDATE pages SET timeline = $2 WHERE slug = $1`, ['large/worst', timeline]);
    const bytes = await vectorStringBytes(engine, 'large/worst');
    // Near the measured worst case, and still under the cap.
    expect(bytes).toBeGreaterThan(600_000);
    expect(bytes).toBeLessThan(TSVECTOR_MAX_STRING_BYTES);
  }, 60_000);

  test('trigger, seal expression, reindex backfill and the v245 upgrade build the same vector', async () => {
    await engine.putPage('large/parity', { type: 'note', title: 'Parity page', compiled_truth: 'Body.', timeline: TIMELINE });
    await engine.putPage('large/short', { type: 'note', title: 'Short page', compiled_truth: 'Body.', timeline: '- 2026-01-01 Short entry.' });
    const fresh = await vectorText('large/parity');
    expect(sanitizeRemoteBody(TIMELINE)).toBe(TIMELINE);
    const [sealed] = await engine.executeRaw<{ v: string }>(`SELECT (${pageSearchVectorSql('$1', '$2', 'english')})::text AS v`, ['Parity page', TIMELINE]);
    expect(sealed!.v).toBe(fresh);

    await engine.executeRaw(`UPDATE pages SET search_vector = to_tsvector('english', 'stale') WHERE slug LIKE 'large/%'`);
    await backfillPageVectors(engine, { lang: 'english', checkpoint: 'test_timeline_bound_reindex' });
    expect(await vectorText('large/parity')).toBe(fresh);

    await engine.executeRaw(`UPDATE pages SET search_vector = to_tsvector('english', 'stale') WHERE slug LIKE 'large/%'`);
    const migration = MIGRATIONS.find(m => m.name === 'page_search_vector_bounded_timeline')!;
    expect({ sql: migration.sql, idempotent: migration.idempotent }).toEqual({ sql: '', idempotent: true });
    await migration.handler!(engine);
    expect(await vectorText('large/parity')).toBe(fresh);
    expect(await vectorText('large/short')).toBe(`'stale':1`);
    await migration.handler!(engine);
    expect(await vectorText('large/parity')).toBe(fresh);
  }, 120_000);
});
