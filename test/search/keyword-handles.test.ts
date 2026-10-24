/** GBRA-108: which query tokens are slug handles (search/keyword-handles.ts) and where their rows go in the keyword arm. */
import { describe, expect, test } from 'bun:test';
import { MAX_SLUG_HANDLES, slugHandles } from '../../src/core/search/keyword-handles.ts';
import { keywordArmRows } from '../../src/core/search/keyword-identifier-probe.ts';
import { buildKeywordCountStatement, buildKeywordPagesStatement } from '../../src/core/search/keyword-statement.ts';
import type { SearchResult } from '../../src/core/types.ts';

describe('slugHandles', () => {
  test('quoted handles of an OR are each resolved, bare ones too, lowercased', () => {
    expect(slugHandles('"dan-example" OR "erin-example"')).toEqual(['dan-example', 'erin-example']);
    expect(slugHandles('what did Dan-Example say about acme-example-2?')).toEqual(['dan-example', 'acme-example-2']);
  });

  test('no hyphenated token, a token without a letter, a negation or a longer quoted phrase resolves nothing', () => {
    expect(slugHandles('Dan Example procurement')).toBeNull();
    expect(slugHandles('meeting on 2026-10-24')).toBeNull();
    expect(slugHandles('northwind -dan-example')).toBeNull();
    expect(slugHandles('northwind -"dan-example"')).toBeNull();
    expect(slugHandles('"met dan-example yesterday"')).toBeNull();
    expect(slugHandles('people/dan-example')).toBeNull();
  });

  test('at most MAX_SLUG_HANDLES handles', () => {
    const q = Array.from({ length: 40 }, (_, i) => 'p-' + i + 'x').join(' ');
    expect(slugHandles(q)).toHaveLength(MAX_SLUG_HANDLES);
  });
});

describe('the keyword statement', () => {
  test('a query without a handle builds the statement it built before (no handle arm)', () => {
    for (const st of [buildKeywordCountStatement('northwind procurement', undefined), buildKeywordPagesStatement('northwind procurement', undefined, { limit: 10 })]) {
      expect(st!.sql).not.toContain("regexp_replace(p.slug, '^.*/', '')");
      expect(st!.sql).not.toContain('UNION');
    }
  });

  test('a handle adds the basename arm under the same filters', () => {
    const st = buildKeywordPagesStatement('"dan-example"', { types: ['person'] }, { limit: 10 })!;
    expect(st.sql).toContain('UNION ALL');
    expect(st.sql.match(/p\.type = ANY/g)).toHaveLength(2);
  });
});

describe('keywordArmRows with handles', () => {
  const row = (page_id: number) => ({ page_id, slug: 'p' + page_id }) as unknown as SearchResult;
  const run = (query: string, o: { strict?: number[]; offset?: number; orFallback?: boolean; handles?: () => Promise<SearchResult[]> } = {}) => {
    const calls: string[] = [];
    return keywordArmRows<SearchResult>({
      query, strict: (o.strict ?? []).map(row), orFallback: o.orFallback ?? true, limit: 5, offset: o.offset ?? 0, toResult: r => r,
      runProbe: () => Promise.resolve([]),
      runRelaxed: () => Promise.resolve([row(7)]),
      runHandles: h => { calls.push(h.join(',')); return o.handles ? o.handles() : Promise.resolve([row(3)]); },
    }).then(rows => ({ calls, rows: rows.map(r => [r.page_id, r.keyword_relaxed === true]) }));
  };

  test('named pages lead untagged, ahead of the strict rows, one row per page', async () => {
    expect(await run('"dan-example" OR "erin-example"', { strict: [1, 3] })).toEqual({ calls: ['dan-example,erin-example'], rows: [[3, false], [1, false]] });
  });

  test('ahead of the relaxed rows when strict is empty', async () => {
    expect((await run('dan-example procurement')).rows).toEqual([[3, false], [7, true]]);
  });

  test('no handle, a paged read or a precision caller resolves nothing; a failed read adds nothing', async () => {
    expect((await run('northwind procurement', { strict: [1] })).calls).toEqual([]);
    expect((await run('dan-example', { strict: [1], offset: 5 })).calls).toEqual([]);
    expect((await run('dan-example', { strict: [1], orFallback: false })).calls).toEqual([]);
    expect((await run('dan-example', { strict: [1], handles: () => Promise.reject(new Error('boom')) })).rows).toEqual([[1, false]]);
  });
});
