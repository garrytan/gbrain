/**
 * GBRA-156 bounded keyword OR fallback on real Postgres: the statistics read
 * (orTokenSharesSql over pg_stats.most_common_elems) returns what
 * narrowOrFallbackTokens needs, stopwords included, and the engine's OR retry
 * still returns relaxed rows for the rare and the common terms when every
 * term fits the cap. Postgres only (PGLite has no OR narrowing); skipped
 * without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';
import { narrowOrFallbackTokens, narrowedOrFallbackQuery, orTokenSharesSql } from '../../src/core/search/keyword-or-narrow.ts';
import { KEYWORD_RANK_CANDIDATES } from '../../src/core/search/keyword-chunk-match.ts';

const run = process.env.DATABASE_URL ? describe : describe.skip;
let engine: BrainEngine;
let close: () => Promise<void> = async () => {};

run('keyword OR fallback narrowing on Postgres', () => {
  beforeAll(async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = isolated.engine;
    close = isolated.close;
    for (let i = 0; i < 40; i++) await seedPage(engine, `notes/quasar-log-${i}`, `Quasar log entry ${i}: the quasar survey, night ${i}.`);
    await seedPage(engine, 'notes/nebulith-field', 'Field notes on the nebulith deposit.');
    await engine.executeRaw('ANALYZE content_chunks');
  }, 300_000);

  afterAll(async () => { await close(); });

  test('the statistics read reports lexemes, tracked shares and the row estimate', async () => {
    const rows = await engine.executeRaw<{ token: string; lexemes: number; share: number | null; rows: number; analyzed: boolean }>(
      orTokenSharesSql('english'), [['the', 'quasar', 'nebulith', 'zzqxv']]);
    expect(rows.map(r => r.token)).toEqual(['the', 'quasar', 'nebulith', 'zzqxv']);
    expect(rows[0].analyzed).toBe(true);
    expect(Number(rows[0].rows)).toBeGreaterThan(30);
    expect(rows.map(r => Number(r.lexemes))).toEqual([0, 1, 1, 1]);
    expect(Number(rows[1].share)).toBeGreaterThan(0.9);
    expect(rows[3].share).toBeNull();
    const nebulith = rows[2].share === null ? null : Number(rows[2].share);
    expect(nebulith === null || nebulith < 0.05).toBe(true);

    const tokens = rows.map(r => ({ token: r.token, lexemes: Number(r.lexemes), share: r.share === null ? null : Number(r.share) }));
    expect(narrowOrFallbackTokens(tokens, Number(rows[0].rows), 10)).toEqual(['zzqxv', 'nebulith']);
    expect(narrowOrFallbackTokens(tokens, Number(rows[0].rows))).toBeNull();
  });

  // #7899: real pg_stats + engine retry, not a timing assertion or SQL-source check.
  // Existing cases have at most three content words, so cannot expose this gap.
  test('long-tail retries have bounded width, keep a known match and disclose narrowing', async () => {
    const unknown = Array.from({ length: 80 }, (_, i) => `zzlongtail${i}`);
    const query = [...unknown, 'quasar'].join(' ');
    const read = (sql: string, params: unknown[]) => engine.executeRaw<{
      token: string; lexemes: number; share: number | null; rows: number; analyzed: boolean;
    }>(sql, params);
    const stats = await read(orTokenSharesSql('english'), [[...unknown, 'quasar']]);
    expect(stats.slice(0, 80).every(t => t.share === null && Number(t.lexemes) === 1)).toBe(true);
    expect(Number(stats[80].share)).toBeGreaterThan(0.9);
    const narrowed = await narrowedOrFallbackQuery(read, query, 'english');
    const expected = [...unknown.slice(0, 15), 'quasar'].join(' OR ');
    expect(narrowed).toBe(expected);
    expect(await engine.searchKeyword(query, { limit: 50 })).toEqual([]);
    const incomplete: string[] = [];
    const relaxed = await engine.searchKeyword(query, { limit: 50, orFallback: true, sourceId: 'default',
      onKeywordIncomplete: reason => incomplete.push(reason) });
    expect(relaxed).toHaveLength(40);
    expect(relaxed.every(r => r.keyword_relaxed === true && r.source_id === 'default')).toBe(true);
    expect(incomplete).toEqual(['candidate_budget']);
    // Matching is narrowed, ranking still sees the entire original OR query.
    const ranked = await engine.searchKeyword(expected, { limit: 50, sourceId: 'default', rankQuery: [...unknown, 'quasar'].join(' OR ') });
    expect(relaxed.map(r => [r.slug, r.score])).toEqual(ranked.map(r => [r.slug, r.score]));
  });

  test('a page with hundreds of matching chunks does not crowd the only other match out of the pool', async () => {
    await seedPage(engine, 'notes/crowd-log', 'The crowdlex log. Each entry below cites the crowdlex survey.');
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
       SELECT cc.page_id, cc.chunk_index + g, cc.chunk_text || ' entry ' || g, cc.chunk_source, cc.modality
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id, generate_series(1, 299) g
       WHERE p.slug = 'notes/crowd-log' AND cc.chunk_index = 0`);
    await seedPage(engine, 'notes/solitar-field', 'Field notes on the solitar deposit.');
    const rows = await engine.searchKeyword('crowdlex OR solitar', { limit: 10 });
    expect(rows.map(r => r.slug).sort()).toEqual(['notes/crowd-log', 'notes/solitar-field']);
  });

  test('a match set over KEYWORD_RANK_CANDIDATES ranks a bounded sample and says so', async () => {
    await seedPage(engine, 'notes/plentix-log', 'The plentix log. Each entry below cites the plentix survey.');
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
       SELECT cc.page_id, cc.chunk_index + g, cc.chunk_text || ' entry ' || g, cc.chunk_source, cc.modality
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id, generate_series(1, $1::int) g
       WHERE p.slug = 'notes/plentix-log' AND cc.chunk_index = 0`, [KEYWORD_RANK_CANDIDATES]);
    const bounded: string[] = [];
    const rows = await engine.searchKeyword('plentix', { limit: 10, onKeywordIncomplete: reason => bounded.push(reason) });
    expect(rows.map(r => r.slug)).toEqual(['notes/plentix-log']);
    expect(bounded).toEqual(['candidate_budget']);

    const exact: string[] = [];
    expect((await engine.searchKeyword('nebulith', { limit: 10, onKeywordIncomplete: reason => exact.push(reason) })).length).toBe(1);
    expect(exact).toEqual([]);
  }, 300_000);

  test('an OR retry within the cap still returns relaxed rows for every term', async () => {
    expect(await engine.searchKeyword('quasar nebulith zzqxv', { limit: 10 })).toEqual([]);
    const rows = await engine.searchKeyword('quasar nebulith zzqxv', { limit: 50, orFallback: true });
    const slugs = new Set(rows.map(r => r.slug));
    expect(slugs.has('notes/nebulith-field')).toBe(true);
    expect([...slugs].some(s => s.startsWith('notes/quasar-log-'))).toBe(true);
    expect(rows.every(r => r.keyword_relaxed === true)).toBe(true);
  });
});
