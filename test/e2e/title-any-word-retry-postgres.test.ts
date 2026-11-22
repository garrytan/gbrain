/**
 * The any-word retry's whole-vector statement on PostgreSQL (GST-2899). A local
 * caller's retry matches titles and timelines while every matching page fits the
 * title cap (search/title-statement.ts `completeOnly`), and otherwise falls back
 * to the title-only statement. Its candidate count has no ORDER BY: nothing is cut
 * from a set that must fit whole, and an ordered count walked pages_pkey for a
 * word on a few percent of a large brain (13 ms to about 800 ms at 1,000,000
 * pages). These tests EXPLAIN the statement the engine runs, with statistics from
 * ANALYZE on a 12,000-page fixture, and require the candidates to come from the
 * GIN index `idx_pages_search`, never from a walk of `pages_pkey`: once with no
 * planner setting changed, and once with the `enable_seqscan = off` the engine
 * sets for a local any-word retry. Pages carry 14 timeline lines so the table is
 * large enough for the planner to price the index against a scan.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS } from '../../src/core/postgres-engine/keyword-statement-timeout.ts';
import { boundWebsearchQuery, buildOrFallbackWebsearchQuery } from '../../src/core/search/sql-ranking.ts';
import { __setTitleWholeVectorCandidatesForTests, buildSearchTitlesStatement, titleWholeVectorCandidates } from '../../src/core/search/title-statement.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const POSTGRES_DIALECT = { statementTimeout: `${KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS}ms`, relaxedPrefersIndex: true, staleProbe: false };
const DEFAULT_CAP = titleWholeVectorCandidates();
/** Pages whose timeline names each fixture word: 4 of 12,000 (rare) and 600 of 12,000 (5%). */
const RARE = 4, FEW_PERCENT = 600;

describe('local any-word title retry (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
    // No title holds either word: only the timeline (search_vector weight C) does.
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline)
       SELECT 'notes/filler-' || g, 'note', 'Filler page ' || g, 'Common body ' || g,
         (SELECT string_agg('- 2026-01-' || lpad(j::text, 2, '0') || ': ' || substr(md5((g * 31 + j)::text), 1, 8) || ' ' || substr(md5((g * 17 + j * 3)::text), 1, 8)
             || ' ' || substr(md5((g + j * 101)::text), 1, 8) || ' ' || substr(md5((g * 3 + j * 7)::text), 1, 8), E'\\n') FROM generate_series(1, 14) j)
           || CASE WHEN g % 3000 = 0 THEN E'\\n- 2026-02-06: zorbex visit' ELSE '' END
           || CASE WHEN g % 20 = 0 THEN E'\\n- 2026-03-07: tarsik call' ELSE '' END
       FROM generate_series(1, 12000) g`);
    // A page is searchable once its text projection matches its knowledge revision, as the projection worker leaves it.
    await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision');
    await engine.executeRaw('VACUUM (ANALYZE) pages');
  }, 180_000);

  afterAll(async () => {
    __setTitleWholeVectorCandidatesForTests(DEFAULT_CAP);
    await close?.();
  });

  /** The plan of a statement's candidates CTE for a question, bound as the retry binds it (the any-word text as $1). */
  async function candidatesPlan(question: string, completeOnly: boolean, seqscan: 'on' | 'off'): Promise<string> {
    const statement = buildSearchTitlesStatement(question, { limit: 50 }, { ...POSTGRES_DIALECT, completeOnly });
    const candidates = statement.sql.slice(statement.sql.indexOf('candidates AS MATERIALIZED'), statement.sql.indexOf('top_pages AS'));
    expect(candidates).toContain(`LIMIT ${titleWholeVectorCandidates() + 1}`);
    expect(candidates.includes('ORDER BY p.id')).toBe(!completeOnly);
    const anyWord = boundWebsearchQuery(buildOrFallbackWebsearchQuery(statement.params[0] as string)!);
    const rows = await engine.transaction(async (tx) => {
      await tx.executeRaw(`SET LOCAL enable_seqscan = ${seqscan}`);
      return tx.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.sql}`, [anyWord, ...statement.params.slice(1)]);
    });
    const lines = rows.map((r) => r['QUERY PLAN']);
    const start = lines.findIndex((l) => /CTE candidates/.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    const indent = lines[start].search(/\S/);
    const end = lines.findIndex((l, i) => i > start && l.search(/\S/) <= indent && !/^\s*->/.test(l) && /\S/.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  }

  /** The retry's count reads idx_pages_search and never walks pages_pkey, under the default planner settings and the engine's. */
  async function expectIndexedCount(question: string): Promise<void> {
    for (const seqscan of ['on', 'off'] as const) {
      const plan = await candidatesPlan(question, true, seqscan);
      expect({ seqscan, plan }).toEqual({ seqscan, plan: expect.stringContaining('idx_pages_search') });
      expect({ seqscan, plan }).toEqual({ seqscan, plan: expect.not.stringContaining('pages_pkey') });
    }
  }

  test('a rare word in timelines is found by the retry, from idx_pages_search', async () => {
    const rows = await engine.searchTitles('zorbex nomatchword', { limit: 50 });
    expect(rows.length).toBe(RARE);
    expect(rows.map(r => r.slug).sort()).toEqual(['notes/filler-12000', 'notes/filler-3000', 'notes/filler-6000', 'notes/filler-9000']);
    await expectIndexedCount('zorbex nomatchword');
  });

  test('a word on a few percent of pages that fits the cap is found, from idx_pages_search', async () => {
    expect(FEW_PERCENT).toBeLessThanOrEqual(titleWholeVectorCandidates());
    const rows = await engine.searchTitles('tarsik nomatchword', { limit: 50 });
    expect(rows.length).toBe(50);
    expect(rows.every(r => Number(r.slug.split('-')[1]) % 20 === 0)).toBe(true);
    await expectIndexedCount('tarsik nomatchword');
  });

  test('a word on a few percent of pages that does not fit the cap is counted from idx_pages_search, and the retry falls back to titles', async () => {
    __setTitleWholeVectorCandidatesForTests(100);
    try {
      expect(FEW_PERCENT).toBeGreaterThan(titleWholeVectorCandidates());
      const cut: string[] = [];
      // No title holds the word, so the title-only fallback has nothing to return.
      expect(await engine.searchTitles('tarsik nomatchword', { limit: 50, onKeywordIncomplete: r => { cut.push(r); } })).toEqual([]);
      expect(cut).toEqual([]);
      await expectIndexedCount('tarsik nomatchword');
      // The fixture reaches the case this pins: the same count ordered by page id walks pages_pkey here.
      expect(await candidatesPlan('tarsik nomatchword', false, 'on')).toContain('pages_pkey');
    } finally {
      __setTitleWholeVectorCandidatesForTests(DEFAULT_CAP);
    }
  });
});
