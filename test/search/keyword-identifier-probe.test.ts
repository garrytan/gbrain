/** #7491: which queries run the keyword arm's identifier probe, and what it matches (search/keyword-identifier-probe.ts). */
import { describe, expect, test } from 'bun:test';
import { holdsIdentifiers, identifierProbeQuery, identifierTokens, keywordArmRows } from '../../src/core/search/keyword-identifier-probe.ts';
import type { SearchResult } from '../../src/core/types.ts';

describe('identifierProbeQuery', () => {
  test('a hash number in a question is probed without its #', () => {
    expect(identifierProbeQuery('What did the latest weekly digest (#412) say?')).toBe('412');
    expect(identifierProbeQuery('What did digest report #412 say?')).toBe('412');
  });

  test('codes, long digit runs, emails and URLs are identifiers', () => {
    expect(identifierProbeQuery('status of INV-2026-00417 for acme-example')).toBe('INV-2026-00417');
    expect(identifierProbeQuery('who paid order 88231904 last week')).toBe('88231904');
    expect(identifierProbeQuery('notes from alice@acme-example.com about pricing')).toBe('alice@acme-example.com');
  });

  test('several identifiers are ANDed', () => {
    expect(identifierProbeQuery('compare #411 and #412 digests')).toBe('411 412');
  });

  test('no identifier, or nothing besides it, runs no probe', () => {
    expect(identifierProbeQuery('What did the latest weekly digest say?')).toBeNull();
    expect(identifierProbeQuery('#412')).toBeNull();
    expect(identifierProbeQuery('INV-2026-00417')).toBeNull();
    expect(identifierProbeQuery('report 412 summary')).toBeNull();
    expect(identifierProbeQuery('meeting on 2026-10-24 with acme-example')).toBeNull();
  });

  test('identifierTokens returns the tokens the title arm checks', () => {
    expect(identifierTokens('What did the latest weekly digest (#412) say?')).toEqual(['412']);
  });
});

describe('holdsIdentifiers', () => {
  test('matches whole tokens only', () => {
    expect(holdsIdentifiers('Weekly digest (#412)', ['412'])).toBe(true);
    expect(holdsIdentifiers('Weekly digest (#4120)', ['412'])).toBe(false);
    expect(holdsIdentifiers('frame t004120', ['412'])).toBe(false);
    expect(holdsIdentifiers('Invoice INV-2026-00417 paid', ['inv-2026-00417'])).toBe(true);
    expect(holdsIdentifiers(null, ['412'])).toBe(false);
  });

  test('every token must be held', () => {
    expect(holdsIdentifiers('Digest #411 and #412', ['411', '412'])).toBe(true);
    expect(holdsIdentifiers('Digest #412', ['411', '412'])).toBe(false);
  });
});

describe('keywordArmRows', () => {
  const row = (page_id: number) => ({ page_id, slug: `p${page_id}` }) as unknown as SearchResult;
  const run = async (query: string, o: { strict?: number[]; offset?: number; orFallback?: boolean; probe?: () => Promise<SearchResult[]> } = {}) => {
    const calls: string[] = [];
    const rows = await keywordArmRows<SearchResult>({
      query, strict: (o.strict ?? []).map(row), orFallback: o.orFallback ?? true, limit: 5, offset: o.offset ?? 0, toResult: r => r,
      runProbe: (m, r) => { calls.push(`probe:${m}|${r}`); return o.probe ? o.probe() : Promise.resolve([row(9)]); },
      runRelaxed: q => { calls.push(`relaxed:${q}`); return Promise.resolve([row(7), row(9)]); },
    });
    return { calls, rows: rows.map(r => [r.page_id, r.keyword_relaxed === true]) };
  };

  test('strict rows lead, probe rows follow untagged, one row per page', async () => {
    expect(await run('weekly digest #412 summary', { strict: [1, 9] })).toEqual({ calls: ['probe:412|weekly OR digest OR 412 OR summary'], rows: [[1, false], [9, false]] });
  });

  test('strict empty: probe rows lead untagged, then the relaxed rows tagged', async () => {
    expect((await run('weekly digest #412 summary')).rows).toEqual([[9, false], [7, true]]);
  });

  test('a quoted phrase, a negation, a paged read or a precision caller runs no probe', async () => {
    for (const q of ['"weekly digest" #412', 'weekly -digest #412']) expect((await run(q, { strict: [1] })).calls).toEqual([]);
    expect((await run('weekly digest #412', { strict: [1], offset: 5 })).calls).toEqual([]);
    expect((await run('weekly digest #412', { orFallback: false })).calls).toEqual([]);
  });

  test('a query without an identifier runs no probe', async () => {
    expect((await run('weekly digest summary', { strict: [1] })).calls).toEqual([]);
  });

  test('a failed probe adds nothing', async () => {
    expect((await run('weekly digest #412', { strict: [1], probe: () => Promise.reject(new Error('boom')) })).rows).toEqual([[1, false]]);
  });
});

