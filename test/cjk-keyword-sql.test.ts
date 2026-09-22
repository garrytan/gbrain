/**
 * #3986: shared CJK keyword-fallback SQL builder + the Postgres engine's
 * executor module. DB-free — the real end-to-end pin is the
 * DATABASE_URL-gated block in test/e2e/engine-parity.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { buildCJKKeywordSql, type CjkKeywordCtx } from '../src/core/search/cjk-keyword-sql.ts';
import { searchKeywordCJK as searchKeywordCJKPg } from '../src/core/postgres-engine/cjk-search.ts';

function ctx(overrides: Partial<CjkKeywordCtx> = {}): CjkKeywordCtx {
  return {
    limit: 5,
    offset: 0,
    innerLimit: 15,
    sourceFactorCase: '1.0',
    hardExcludeClause: '',
    visibilityClause: '',
    detailFilter: '',
    opts: undefined,
    dedup: true,
    ...overrides,
  };
}

describe('buildCJKKeywordSql (#3986)', () => {
  test('empty and whitespace-only queries return null without binding SQL', () => {
    expect(buildCJKKeywordSql('', ctx())).toBeNull();
    expect(buildCJKKeywordSql('   ', ctx())).toBeNull();
  });

  test('one ILIKE clause per term, AND-joined, with explicit ESCAPE', () => {
    const built = buildCJKKeywordSql('東京 会議', ctx());
    expect(built).not.toBeNull();
    const ilikeCount = (built!.sql.match(/ILIKE \$\d+ ESCAPE '\\'/g) || []).length;
    expect(ilikeCount).toBe(2);
    // Escaped + wrapped LIKE params come first, raw terms after, raw query next.
    expect(built!.params.slice(0, 2)).toEqual(['%東京%', '%会議%']);
    expect(built!.params.slice(2, 4)).toEqual(['東京', '会議']);
    expect(built!.params[4]).toBe('東京 会議');
  });

  test('LIKE metacharacters in terms are escaped', () => {
    const built = buildCJKKeywordSql('東京_50%', ctx());
    expect(built!.params[0]).toBe('%東京\\_50\\%%');
    // Raw term stays unescaped for ranking arithmetic.
    expect(built!.params[1]).toBe('東京_50%');
  });

  test('dedup=true builds the best-per-page CTE; dedup=false is chunk-grain', () => {
    const dedup = buildCJKKeywordSql('東京', ctx({ dedup: true }));
    const flat = buildCJKKeywordSql('東京', ctx({ dedup: false }));
    expect(dedup!.sql).toContain('best_per_page');
    expect(flat!.sql).not.toContain('best_per_page');
  });

  test('sourceIds[] wins over scalar sourceId (federated subsumes single-source)', () => {
    const both = buildCJKKeywordSql('東京', ctx({
      opts: { sourceIds: ['a', 'b'], sourceId: 'c' },
    }));
    expect(both!.sql).toContain('p.source_id = ANY(');
    expect(both!.params).toContainEqual(['a', 'b']);
    expect(both!.params).not.toContain('c');

    const scalar = buildCJKKeywordSql('東京', ctx({ opts: { sourceId: 'c' } }));
    expect(scalar!.sql).toContain('p.source_id = $');
    expect(scalar!.params).toContain('c');
  });

  test('#4480: type/types/exclude_slugs filters bind as params (parity with the main keyword arm)', () => {
    const built = buildCJKKeywordSql('東京', ctx({
      opts: {
        type: 'person' as never,
        types: ['person', 'company'] as never,
        exclude_slugs: ['people/alice-example'],
      },
    }));
    expect(built!.sql).toContain('p.type = $');
    expect(built!.sql).toContain('p.type = ANY($');
    expect(built!.sql).toContain(`p.slug != ALL($`);
    expect(built!.params).toContain('person');
    expect(built!.params).toContainEqual(['person', 'company']);
    expect(built!.params).toContainEqual(['people/alice-example']);
  });

  test('#4480: no type/exclude filters → no p.type / p.slug clauses (unfiltered stays unfiltered)', () => {
    const built = buildCJKKeywordSql('東京', ctx());
    expect(built!.sql).not.toContain('p.type = $');
    expect(built!.sql).not.toContain('p.slug != ALL(');
  });

  test('date/lang/symbol filters bind as params', () => {
    const built = buildCJKKeywordSql('東京', ctx({
      opts: { afterDate: '2026-01-01', beforeDate: '2026-02-01', language: 'typescript', symbolKind: 'function' },
    }));
    expect(built!.sql).toContain('cc.language = $');
    expect(built!.sql).toContain('cc.symbol_type = $');
    expect(built!.sql).toContain('> $');
    expect(built!.sql).toContain('< $');
    expect(built!.params).toEqual(expect.arrayContaining(['2026-01-01', '2026-02-01', 'typescript', 'function']));
  });

  test('multi-term query gets contiguous-raw-query bonus; single-term does not', () => {
    const multi = buildCJKKeywordSql('東京 会議', ctx());
    const single = buildCJKKeywordSql('東京', ctx());
    // The bonus references the raw-query param in REPLACE: $5 for two terms
    // (LIKE $1-$2, raw terms $3-$4, raw query $5); $3 for one term
    // (LIKE $1, raw term $2, raw query $3 — used only in POSITION()).
    expect((multi!.sql.match(/REPLACE\(cc\.chunk_text, \$5,/g) || []).length).toBeGreaterThan(0);
    expect((single!.sql.match(/REPLACE\(cc\.chunk_text, \$3,/g) || []).length).toBe(0);
  });
});

describe('postgres-engine searchKeywordCJK executor (#3986)', () => {
  test('runs the built SQL through the runner and maps rows to SearchResult', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const results = await searchKeywordCJKPg(
      async (sql, params) => {
        calls.push({ sql, params });
        return [{
          slug: 'notes/tokyo', page_id: 1, title: '東京', type: 'note', source_id: 'default',
          effective_date: null, effective_date_source: null,
          message_id: null, thread_id: null, source_subject: null,
          chunk_id: 10, chunk_index: 0, chunk_text: '東京の会議', chunk_source: 'compiled_truth',
          score: 1.5, stale: false,
        }];
      },
      '東京 会議',
      ctx(),
    );
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain('ILIKE');
    expect(calls[0].params[0]).toBe('%東京%');
    expect(results.length).toBe(1);
    expect(results[0].slug).toBe('notes/tokyo');
    expect(results[0].score).toBe(1.5);
  });

  test('empty query never touches the runner', async () => {
    let called = false;
    const results = await searchKeywordCJKPg(async () => { called = true; return []; }, '', ctx());
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('buildCJKKeywordSql — Korean particle variants', () => {
  // These assert on the BUILDER's output, not on a new export, so they still
  // EXECUTE (and fail) against the pre-fix source — the discrimination-test
  // contract in CONTRIBUTING.md. A test that only imported the new helper
  // would crash on import instead, which is the vacuous-failure class.

  test('an inflected term binds its stem as an additional LIKE param', () => {
    const { params } = buildCJKKeywordSql('혈당에서', ctx())!;
    expect(params).toContain('%혈당에서%'); // original is never dropped
    expect(params).toContain('%혈당%');     // stem is offered alongside it
  });

  test('variants are ORed within a term, ANDed across terms', () => {
    const { sql } = buildCJKKeywordSql('혈당이 검진을', ctx())!;
    const where = sql.match(/\(cc\.chunk_text ILIKE[^\n]*/)![0];
    // Two parenthesised groups joined by AND, each holding an OR pair.
    expect(where).toMatch(/\(cc\.chunk_text ILIKE \$\d+ ESCAPE '\\' OR cc\.chunk_text ILIKE \$\d+ ESCAPE '\\'\) AND \(/);
  });

  test('term-frequency scoring binds ONE representative per term, not both variants', () => {
    // Counting the inflected form AND its stem would double-count the same
    // occurrence and inflate inflected queries against uninflected ones. The
    // non-LIKE string params are exactly [<term-frequency term>, <raw query>];
    // the stem takes the scoring slot, and the inflected form appears only as
    // the pre-existing raw-query param (contiguous-match bonus + tiebreaker).
    const { params } = buildCJKKeywordSql('혈당에서', ctx())!;
    const raw = params.filter(p => typeof p === 'string' && !p.startsWith('%'));
    expect(raw).toEqual(['혈당', '혈당에서']);
  });

  test('a term with no strippable particle binds exactly one LIKE param', () => {
    const like = (q: string) =>
      buildCJKKeywordSql(q, ctx())!.params.filter(p => typeof p === 'string' && p.startsWith('%'));
    expect(like('회의')).toEqual(['%회의%']);   // 1-syllable stem refused
    expect(like('LDL')).toEqual(['%LDL%']);    // non-Korean untouched
  });
});
