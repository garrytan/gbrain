/**
 * LHF wave 2 item G: the contract-parity harness's pure comparison rules.
 *
 * 1. Protects: score-like keys compare within the stated tolerances, rows may
 *    reorder only inside a run of tolerance-equal scores, answer_id is
 *    replaced by its order of appearance everywhere, timings are blanked and
 *    the behavior-change disclosure is split out instead of compared.
 * 2. Fails when: a tolerance widens or narrows, a real reorder passes, or a
 *    normalization starts hiding a field it should not touch.
 * 3. Pure: no engine, no process spawn.
 */
import { describe, expect, test } from 'bun:test';
import { COSINE_TOLERANCE, SCORE_TOLERANCE, diff, normalizeResponse, passes, savedFactFixtures } from '../scripts/bench/contract-parity.ts';

const row = (slug: string, score: number, extra: Record<string, unknown> = {}) => ({ source_id: 'default', slug, chunk_index: 0, score, ...extra });

describe('contract-parity diff', () => {
  test('scores within tolerance are equal, beyond it differ', () => {
    expect(diff({ score: 0.5 }, { score: 0.5 + SCORE_TOLERANCE / 2 })).toEqual([]);
    expect(diff({ score: 0.5 }, { score: 0.5 + SCORE_TOLERANCE * 2 })).toHaveLength(1);
    expect(diff({ cosine: 0.5 }, { cosine: 0.5 + COSINE_TOLERANCE / 2 })).toEqual([]);
    expect(diff({ cosine: 0.5 }, { cosine: 0.5 + COSINE_TOLERANCE * 2 })).toHaveLength(1);
  });

  test('non-score numbers compare exactly', () => {
    expect(diff({ count: 3 }, { count: 3 })).toEqual([]);
    expect(diff({ rank: 0.5 }, { rank: 0.5 + 1e-9 })).toHaveLength(1);
  });

  test('rows may swap only inside a tolerance-equal score run', () => {
    const base = [row('a', 0.9), row('b', 0.8), row('c', 0.8 - SCORE_TOLERANCE / 4), row('d', 0.5)];
    const tieSwap = [base[0], base[2], base[1], base[3]];
    expect(diff(base, tieSwap)).toEqual([]);
    const realSwap = [base[1], base[0], base[2], base[3]];
    expect(diff(base, realSwap).some(d => d.note?.includes('outside a tolerance-equal'))).toBe(true);
  });

  test('added, removed and changed fields are reported', () => {
    const d = diff({ a: 1, b: 'x' }, { b: 'y', c: true });
    expect(d.map(x => x.note ?? 'changed').sort()).toEqual(['added', 'changed', 'removed']);
  });

  test('JSON carried inside a text block is compared structurally', () => {
    expect(diff(JSON.stringify({ score: 0.5, slug: 'a' }), JSON.stringify({ slug: 'a', score: 0.5 + SCORE_TOLERANCE / 2 }))).toEqual([]);
  });
});

describe('contract-parity normalization', () => {
  test('answer_id becomes its order of appearance in content, meta and rate lines', () => {
    const ids = new Map<string, string>();
    const r = normalizeResponse({
      content: [{ text: JSON.stringify({ answer_id: 'uuid-1', rows: [] }) }, { text: 'Rate it: rate_answer { answer_id: "uuid-1", rating: 1-5 }' }],
      _meta: { retrieval: { answer_id: 'uuid-1' } },
    }, ids);
    const second = normalizeResponse({ content: [{ text: JSON.stringify({ answer_id: 'uuid-2' }) }] }, ids);
    expect(JSON.stringify(r)).not.toContain('uuid-1');
    expect(r.blocks[0]).toEqual({ answer_id: '<answer_id:0>', rows: [] });
    expect(r.blocks[1]).toContain('<answer_id:0>');
    expect(second.blocks[0]).toEqual({ answer_id: '<answer_id:1>' });
  });

  test('timings are blanked and nothing else is', () => {
    const r = normalizeResponse({ content: [{ text: JSON.stringify({ total_ms: 12, timings: { a: 1 }, score: 0.25, results: 3, how_to_rate: 'x' }) }, { text: 'took 41 ms' }] }, new Map());
    expect(r.blocks[0]).toEqual({ total_ms: '<timing>', timings: '<timing>', score: 0.25, results: 3, how_to_rate: '<how_to_rate>' });
    expect(r.blocks[1]).toBe('took <n> ms');
  });

  test('the behavior-change disclosure is split out of the compared blocks', () => {
    const r = normalizeResponse({ content: [{ text: '[]' }, { text: '[gbrain notice] Behavior change in 0.60.253.0: ...' }] }, new Map());
    expect(r.blocks).toEqual([[]]);
    expect(r.disclosures).toHaveLength(1);
  });
});

describe('contract-parity fixtures', () => {
  test('the call sequence covers every item the wave gates', () => {
    const calls = passes().flatMap(p => p.calls);
    expect(calls.some(c => JSON.stringify(c.params.types ?? []).includes('ghosttype'))).toBe(true);
    expect(calls.some(c => JSON.stringify(c.params.types ?? []).includes('organization') && c.sourceId === 'other')).toBe(true);
    expect(calls.some(c => c.federated)).toBe(true);
    expect(passes().map(p => p.name)).toEqual(['main', 'federated', 'halfvec', 'feedback']);
  });

  test('saved facts include the >200-match case and the visibility edges', () => {
    const facts = savedFactFixtures();
    expect(facts.filter(f => f.fact.startsWith('Kestrel')).length).toBeGreaterThan(200);
    expect(facts.some(f => f.visibility === 'private')).toBe(true);
    expect(facts.some(f => f.expired)).toBe(true);
    expect(facts.some(f => f.source_id === 'other')).toBe(true);
  });
});

describe('contract-parity rounding flips', () => {
  test('a one-unit move in the last printed digit is a listed flip, a larger move is a failure', async () => {
    const { ROUNDING_FLIP } = await import('../scripts/bench/contract-parity.ts');
    expect(diff({ score: 0.6998 }, { score: 0.6999 })[0]?.note).toBe(ROUNDING_FLIP);
    expect(diff({ score: 0.6998 }, { score: 0.7 })[0]?.note).not.toBe(ROUNDING_FLIP);
    expect(diff({ score: 0.6998 }, { score: 0.6996 })[0]?.note).not.toBe(ROUNDING_FLIP);
  });
});

describe('contract-parity disclosure in _meta', () => {
  test('a notices array that held only the disclosure is removed, as if it never existed', () => {
    const r = normalizeResponse({ content: [{ text: '[]' }], _meta: { gbrain_notices: [{ code: 'behavior_changes', text: 'Behavior change ...' }] } }, new Map());
    expect(r.meta).toEqual({});
    expect(r.disclosures).toHaveLength(1);
    const kept = normalizeResponse({ content: [{ text: '[]' }], _meta: { gbrain_notices: [{ code: 'other' }] } }, new Map());
    expect(kept.meta).toEqual({ gbrain_notices: [{ code: 'other' }] });
  });
});
