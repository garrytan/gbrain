/**
 * Ranker wave (R1) — pure-function pins for `pinRelationalRows` and the ONE
 * range contract `normalizeRelationalRerankPin` (relational-rerank-pin.ts).
 *
 * Pins the documented contract: relational rows move to a top block in fused
 * order bounded by `max`; a row the reranker itself ranked higher keeps that
 * claim; ties resolve to the fused order; one row per page; text rows keep
 * their reranked relative order and identity; every no-op path returns the
 * input array itself; inputs are never mutated.
 */

import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_RELATIONAL_RERANK_PIN,
  RELATIONAL_RERANK_PIN_MAX,
  normalizeRelationalRerankPin,
  pinRelationalRows,
  type RelationalRerankPinDecision,
} from '../../src/core/search/relational-rerank-pin.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug,
    page_id: 0,
    title: slug,
    type: 'note',
    chunk_text: `text of ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 0.5,
    stale: false,
    source_id: 'default',
    ...extra,
  };
}
const slugs = (rs: readonly SearchResult[]) => rs.map((r) => r.slug);
const rel = (slug: string) => row(slug, { relational_via_link_types: ['invested_in'], relational_seed: 'companies/acme' });

describe('pinRelationalRows — no-op paths return the input array itself', () => {
  const T1 = row('t1'), T2 = row('t2');
  test('empty relational list', () => {
    const reranked = [T1, T2];
    expect(pinRelationalRows(reranked, [], { max: 3 })).toBe(reranked);
  });
  test('max 0 / negative / NaN', () => {
    const reranked = [T1, rel('r1')];
    for (const max of [0, -1, Number.NaN]) {
      expect(pinRelationalRows(reranked, [rel('r1')], { max })).toBe(reranked);
    }
  });
  test('empty pool', () => {
    const reranked: SearchResult[] = [];
    expect(pinRelationalRows(reranked, [rel('r1')], { max: 3 })).toBe(reranked);
  });
  test('no relational page in the pool (arm rows dropped upstream)', () => {
    const reranked = [T1, T2];
    let fired = 0;
    expect(pinRelationalRows(reranked, [rel('r9')], { max: 3, onPin: () => { fired++; } })).toBe(reranked);
    expect(fired).toBe(0);
  });
  test('source_id scoping: the same slug in another source is NOT the relational page', () => {
    const other = row('r1', { source_id: 'other' });
    const reranked = [T1, other];
    expect(pinRelationalRows(reranked, [rel('r1')], { max: 3 })).toBe(reranked);
  });
});

describe('pinRelationalRows — pin order', () => {
  test('relational rows move to the top in FUSED order; text rows keep reranked order and identity', () => {
    const T1 = row('t1'), T2 = row('t2'), T3 = row('t3');
    const Ra = row('r-a', { rerank_score: 0.1 }), Rb = row('r-b', { rerank_score: 0.2 });
    // Fused (pre-rerank): R_a led, R_b third; the reranker buried both.
    const fused = [Ra, T1, Rb, T2, T3];
    const reranked = [T1, T2, Rb, T3, Ra];
    let decision: RelationalRerankPinDecision | undefined;
    const out = pinRelationalRows(reranked, [rel('r-a'), rel('r-b')], { max: 3, fusedOrder: fused, onPin: (d) => { decision = d; } });

    expect(slugs(out)).toEqual(['r-a', 'r-b', 't1', 't2', 't3']);
    // Text rows are the SAME objects (permutation, not a rebuild).
    expect(out[2]).toBe(T1);
    expect(out[3]).toBe(T2);
    expect(out[4]).toBe(T3);
    // Pinned rows are stamped copies; the inputs are untouched.
    expect(out[0].relational_pinned).toBe(true);
    expect(out[1].relational_pinned).toBe(true);
    expect(out[0].rerank_score).toBe(0.1); // score kept for telemetry
    expect(Ra.relational_pinned).toBeUndefined();
    expect(slugs(reranked)).toEqual(['t1', 't2', 'r-b', 't3', 'r-a']);
    expect(decision).toEqual({
      max: 3,
      relational_in_pool: 2,
      pinned: [
        { slug: 'r-a', source_id: 'default', from_rank: 4, to_rank: 0, fused_rank: 0 },
        { slug: 'r-b', source_id: 'default', from_rank: 2, to_rank: 1, fused_rank: 1 },
      ],
      moved: 2,
    });
  });

  test('max bound: only `max` rows are pinned; the rest keep their reranked relative order after the block', () => {
    const T1 = row('t1'), T2 = row('t2');
    const Ra = row('r-a'), Rb = row('r-b'), Rc = row('r-c'), Rd = row('r-d');
    const fused = [Ra, Rb, Rc, Rd, T1, T2];
    const reranked = [T1, Rd, T2, Rc, Rb, Ra];
    const out = pinRelationalRows(reranked, [Ra, Rb, Rc, Rd], { max: 2, fusedOrder: fused });
    // Claims: R_a min(0,5)=0, R_b min(1,4)=1, R_c min(2,3)=2, R_d min(3,1)=1.
    // Sorted: R_a(0), R_b(1,f1), R_d(1,f3), R_c(2) → block = [R_a, R_b].
    expect(slugs(out)).toEqual(['r-a', 'r-b', 't1', 'r-d', 't2', 'r-c']);
    expect(out.filter((r) => r.relational_pinned).length).toBe(2);
    // An unpinned row never lands HIGHER than the reranker put it.
    expect(slugs(out).indexOf('r-d')).toBeGreaterThanOrEqual(slugs(reranked).indexOf('r-d'));
    expect(slugs(out).indexOf('r-c')).toBeGreaterThanOrEqual(slugs(reranked).indexOf('r-c'));
  });

  test('both relational AND reranked: a row the reranker promoted to rank 0 keeps that claim over a fused-higher sibling', () => {
    const T1 = row('t1');
    const Ra = row('r-a'), Rb = row('r-b'), Rc = row('r-c');
    const fused = [Ra, Rb, Rc, T1];
    // The reranker liked R_c (rank 0) and buried R_a / R_b.
    const reranked = [Rc, T1, Ra, Rb];
    const out = pinRelationalRows(reranked, [Ra, Rb, Rc], { max: 3, fusedOrder: fused });
    // Claims: R_a min(0,2)=0, R_b min(1,3)=1, R_c min(2,0)=0 → ties at 0 → fused order (R_a, then R_c), then R_b.
    expect(slugs(out)).toEqual(['r-a', 'r-c', 'r-b', 't1']);
  });

  test('ties resolve to the FUSED order (the reranker only promotes when strictly decisive)', () => {
    const T1 = row('t1');
    const Ra = row('r-a'), Rb = row('r-b');
    const fused = [Ra, Rb, T1];
    const reranked = [Rb, T1, Ra]; // R_b claim min(1,0)=0; R_a claim min(0,2)=0 → tie → fused: R_a first
    const out = pinRelationalRows(reranked, [Ra, Rb], { max: 3, fusedOrder: fused });
    expect(slugs(out)).toEqual(['r-a', 'r-b', 't1']);
  });

  test('already on top in fused order: order unchanged, rows still stamped, moved = 0', () => {
    const Ra = row('r-a'), Rb = row('r-b'), T1 = row('t1');
    const reranked = [Ra, Rb, T1];
    let decision: RelationalRerankPinDecision | undefined;
    const out = pinRelationalRows(reranked, [Ra, Rb], { max: 3, fusedOrder: [Ra, Rb, T1], onPin: (d) => { decision = d; } });
    expect(slugs(out)).toEqual(['r-a', 'r-b', 't1']);
    expect(out[0].relational_pinned).toBe(true);
    expect(out[1].relational_pinned).toBe(true);
    expect(out[2]).toBe(T1);
    expect(decision?.moved).toBe(0);
    expect(decision?.pinned.length).toBe(2);
  });

  test('one row per page: a second chunk of a pinned page stays an ordinary text row', () => {
    const T1 = row('t1');
    const Ra1 = row('r-a', { chunk_id: 1 }), Ra2 = row('r-a', { chunk_id: 2 });
    const reranked = [T1, Ra1, Ra2];
    const out = pinRelationalRows(reranked, [rel('r-a')], { max: 3, fusedOrder: [Ra1, Ra2, T1] });
    expect(out.map((r) => `${r.slug}#${r.chunk_id}`)).toEqual(['r-a#1', 't1#1', 'r-a#2']);
    expect(out[0].relational_pinned).toBe(true);
    expect(out[2]).toBe(Ra2);
    expect(out[2].relational_pinned).toBeUndefined();
  });

  test('fusedOrder omitted → the arm order ranks; rows absent from fusedOrder rank after fused-present rows', () => {
    const T1 = row('t1');
    const Ra = row('r-a'), Rb = row('r-b'), Rc = row('r-c');
    // Arm order: R_c, R_a, R_b. No fusedOrder → R_c first.
    const reranked = [T1, Ra, Rb, Rc];
    expect(slugs(pinRelationalRows(reranked, [Rc, Ra, Rb], { max: 3 }))).toEqual(['r-c', 'r-a', 'r-b', 't1']);
    // fusedOrder carries only R_b → R_b fused rank 0; R_c / R_a fall back to arm order after it.
    expect(slugs(pinRelationalRows(reranked, [Rc, Ra, Rb], { max: 3, fusedOrder: [T1, Rb] }))).toEqual(['r-b', 'r-c', 'r-a', 't1']);
  });

  test('output is a permutation of the input (no row added or removed)', () => {
    const rows = [row('t1'), row('r-a'), row('t2'), row('r-b'), row('t3'), row('r-c'), row('r-d')];
    const out = pinRelationalRows(rows, [rel('r-a'), rel('r-b'), rel('r-c'), rel('r-d')], { max: 2, fusedOrder: rows });
    expect(out.length).toBe(rows.length);
    expect([...slugs(out)].sort()).toEqual([...slugs(rows)].sort());
  });

  test('a throwing onPin never breaks the pin', () => {
    const out = pinRelationalRows([row('t1'), row('r-a')], [rel('r-a')], { max: 3, onPin: () => { throw new Error('boom'); } });
    expect(slugs(out)).toEqual(['r-a', 't1']);
  });

  test('fractional max floors (2.9 → 2)', () => {
    const rows = [row('t1'), row('r-a'), row('r-b'), row('r-c')];
    const out = pinRelationalRows(rows, [rel('r-a'), rel('r-b'), rel('r-c')], { max: 2.9, fusedOrder: rows });
    expect(out.filter((r) => r.relational_pinned).length).toBe(2);
  });
});

describe('normalizeRelationalRerankPin — the ONE range contract', () => {
  test('constants', () => {
    expect(DEFAULT_RELATIONAL_RERANK_PIN).toBe(3);
    expect(RELATIONAL_RERANK_PIN_MAX).toBe(10);
  });
  test('accepts non-negative integers <= 10 (numbers and numeric strings)', () => {
    expect(normalizeRelationalRerankPin(0)).toBe(0);
    expect(normalizeRelationalRerankPin(3)).toBe(3);
    expect(normalizeRelationalRerankPin(10)).toBe(10);
    expect(normalizeRelationalRerankPin('3')).toBe(3);
    expect(normalizeRelationalRerankPin(' 7 ')).toBe(7);
    expect(normalizeRelationalRerankPin('0')).toBe(0);
  });
  test('off / false literals disable (0)', () => {
    expect(normalizeRelationalRerankPin('off')).toBe(0);
    expect(normalizeRelationalRerankPin('OFF')).toBe(0);
    expect(normalizeRelationalRerankPin('false')).toBe(0);
    expect(normalizeRelationalRerankPin(false)).toBe(0);
  });
  test('everything else is unset (falls through to config → bundle)', () => {
    for (const bad of [-1, 11, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '', 'x', '2.5', '-3', '11', null, undefined, true, {}, []]) {
      expect(normalizeRelationalRerankPin(bad)).toBeUndefined();
    }
  });
});
