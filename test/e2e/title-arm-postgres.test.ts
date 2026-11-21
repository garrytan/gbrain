/**
 * Title arm on PostgreSQL: the dual-backend cases in
 * test/search/title-arm-exact.test.ts, plus a plan proof for the remote
 * (safe-chunks) predicate. The plan proof EXPLAINs the statement the engine
 * runs (search/title-statement.ts buildSearchTitlesStatement, the one builder
 * both engines call) and requires the title-only index `idx_pages_title_search`
 * (GBRA-156, v267: the weight-A slice of search_vector, so a term in timeline
 * text never makes its page a candidate) with no per-row `to_tsvector(title)`
 * filter (the pre-fix remote arm scanned every page in scope).
 * `enable_seqscan = off` inside the transaction keeps the plan choice
 * deterministic on a small fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { __setTitleWholeVectorCandidatesForTests, buildSearchTitlesStatement, titleWholeVectorCandidates } from '../../src/core/search/title-statement.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS } from '../../src/core/postgres-engine/keyword-statement-timeout.ts';
import { registerPostgresTests, requirePostgresTestDatabase } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/title-arm-exact.test.ts'));

const POSTGRES_DIALECT = { statementTimeout: `${KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS}ms`, relaxedPrefersIndex: true, staleProbe: false };
const REMOTE = { requireSafeChunks: true, excludePrivate: true, sourceId: 'default', limit: 50 };
const DEFAULT_CAP = titleWholeVectorCandidates();

describe('remote title arm plan (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
    for (let i = 1; i <= 40; i++) {
      const slug = `notes/page-${i}`;
      const body = `Body ${i}.`;
      await engine.putPage(slug, { type: 'note', title: i % 10 === 0 ? `Acme review ${i}` : `Globex weekly sync ${i}`, compiled_truth: body });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
    }
    // Timeline text (search_vector weight C) names the title terms; the title-only predicate must not match it.
    await engine.addTimelineEntry('notes/page-1', { date: '2026-02-02', source: 't', summary: 'Acme secret weekly sync with acme', detail: 'acme' });
    await engine.addTimelineEntry('notes/page-10', { date: '2026-02-03', source: 't', summary: 'secret globex notes', detail: 'globex' });
    await engine.executeRaw('ANALYZE pages');
  }, 120_000);

  afterAll(async () => { await close?.(); });

  async function plan(query: string): Promise<string> {
    const statement = buildSearchTitlesStatement(query, REMOTE, POSTGRES_DIALECT);
    return engine.transaction(async (tx) => {
      await tx.executeRaw(`SET LOCAL enable_seqscan = off`);
      const rows = await tx.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.sql}`, statement.params);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  }

  // 'matt acme' ORs in its given-name variant 'matthew acme' (#7471).
  for (const query of ['acme', 'acme -secret', '"weekly sync"', 'globex or acme', 'matt acme']) {
    test(`\`${query}\` uses idx_pages_title_search with no per-row to_tsvector(title)`, async () => {
      const text = await plan(query);
      expect(text).toContain('idx_pages_title_search');
      expect(text).not.toMatch(/to_tsvector\([^)]*title/);
    });
  }

  // GBRA-156: the title-only predicate `ts_filter(search_vector, '{a}') @@ q` matches exactly the pages the former
  // `search_vector @@ q` with every lexeme labeled :A matched (negation and phrases read title lexemes only either way).
  test('the title-only predicate returns the pages the weight-A labeled query returned', async () => {
    const statement = buildSearchTitlesStatement('acme', REMOTE, POSTGRES_DIALECT);
    expect(statement.sql).toContain("ts_filter(p.search_vector, '{a}') @@ websearch_to_tsquery(");
    const labeled = statement.sql.replace(/ts_filter\(p\.search_vector, '\{a\}'\) @@ (websearch_to_tsquery\('\w+', gbrain_fts_input\(\$1\)\))/,
      (_m, tsq: string) => `p.search_vector @@ regexp_replace(${tsq}::text, '(''(?:[^'']|'''')*'')(?::(\\*))?', '\\1:\\2A', 'g')::tsquery`);
    expect(labeled).not.toBe(statement.sql);
    for (const query of ['acme', 'acme -secret', '"weekly sync"', 'globex or acme', 'secret', 'globex -weekly', 'acme notes']) {
      const params = buildSearchTitlesStatement(query, REMOTE, POSTGRES_DIALECT).params;
      const now = (await engine.executeRaw<{ slug: string }>(statement.sql, params)).map(r => r.slug);
      const before = (await engine.executeRaw<{ slug: string }>(labeled, params)).map(r => r.slug);
      expect({ query, now }).toEqual({ query, now: before });
    }
    const secret = await engine.executeRaw<{ slug: string }>(statement.sql, buildSearchTitlesStatement('secret', REMOTE, POSTGRES_DIALECT).params);
    expect(secret).toEqual([]);
  });

  test('the engine runs the same statement the plan proof explains', async () => {
    const statement = buildSearchTitlesStatement('acme', REMOTE, POSTGRES_DIALECT);
    const direct = await engine.executeRaw<{ slug: string }>(statement.sql, statement.params);
    const viaEngine = await engine.searchTitles('acme', REMOTE);
    expect(viaEngine.map((r) => r.slug)).toEqual(direct.map((r) => r.slug));
    expect(viaEngine.length).toBe(4);
  });

  // #7082: a local caller's whole-vector attempt ranks at most titleWholeVectorCandidates() pages, chosen by page id.
  test('a cut local attempt keeps the lowest page ids, reports candidate_budget and leads with the title rows', async () => {
    const local = async () => {
      const cut: string[] = [];
      const rows = await engine.searchTitles('acme', { limit: 50, onKeywordIncomplete: r => { cut.push(r); } });
      return { slugs: rows.map(r => r.slug), cut };
    };
    // Fold page-1's timeline_entries row (it names acme) into its search_vector, as the next title write does.
    await engine.executeRaw("UPDATE pages SET title = title WHERE slug = 'notes/page-1'");
    const titled = (await engine.searchTitles('acme', REMOTE)).map(r => r.slug);
    const whole = await local();
    expect(whole.cut).toEqual([]);
    expect(whole.slugs.sort()).toEqual([...titled, 'notes/page-1'].sort());
    __setTitleWholeVectorCandidatesForTests(2);
    try {
      const first = await local();
      expect(first.cut).toEqual(['candidate_budget']);
      expect(first.slugs).toEqual([...titled, 'notes/page-1']);
      for (let i = 0; i < 3; i++) expect((await local()).slugs).toEqual(first.slugs);
    } finally {
      __setTitleWholeVectorCandidatesForTests(DEFAULT_CAP);
    }
  });
});

// #7082: the local cut's candidates CTE (`search_vector @@ q ORDER BY p.id LIMIT cap + 1`) has two good plans. A rare
// term's few matches come from the GIN index idx_pages_search and are sorted, never by walking pages_pkey through every
// page; a term on nearly every page walks pages_pkey and stops at cap + 1 matches, never bitmapping every match first.
// Statistics come from ANALYZE on a 12,000-page fixture, with no planner setting changed.
describe('local title cut plan (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth)
       SELECT 'notes/filler-' || g, 'note', CASE WHEN g % 3000 = 0 THEN 'Zorbex ledger ' || g ELSE 'Filler page ' || g END, 'Common body ' || g
       FROM generate_series(1, 12000) g`);
    // A page is searchable once its text projection matches its knowledge revision, as the projection worker leaves it.
    await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision');
    await engine.executeRaw('ANALYZE pages');
  }, 180_000);

  afterAll(async () => { await close?.(); });

  async function candidatesPlan(query: string): Promise<string> {
    const statement = buildSearchTitlesStatement(query, { limit: 50 }, POSTGRES_DIALECT);
    expect(statement.sql).toContain('ORDER BY p.id');
    const rows = await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.sql}`, statement.params);
    const lines = rows.map((r) => r['QUERY PLAN']);
    const start = lines.findIndex((l) => /CTE candidates/.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    const indent = lines[start].search(/\S/);
    const end = lines.findIndex((l, i) => i > start && l.search(/\S/) <= indent && !/^\s*->/.test(l) && /\S/.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  }

  test('a rare term takes its candidates from idx_pages_search, not a pages_pkey walk', async () => {
    expect((await engine.searchTitles('zorbex', { limit: 50 })).length).toBe(4);
    const plan = await candidatesPlan('zorbex');
    expect(plan).toContain('idx_pages_search');
    expect(plan).not.toContain('pages_pkey');
  });

  test('a term on every page walks pages_pkey and stops at the cap', async () => {
    const cut: string[] = [];
    await engine.searchTitles('filler', { limit: 50, onKeywordIncomplete: r => { cut.push(r); } });
    expect(cut).toEqual(['candidate_budget']);
    const plan = await candidatesPlan('filler');
    expect(plan).toMatch(/Limit/);
    expect(plan).toContain('pages_pkey');
    expect(plan).not.toContain('idx_pages_search');
  });
});
