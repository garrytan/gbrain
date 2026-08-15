/**
 * BrainBench metric formulas — pure scoring over hand-built turn rows.
 * Edge cases: zero should_retrieve turns, empty injections, acceptable-vs-gold
 * asymmetry, micro-averaging weights.
 */
import { describe, expect, test } from 'bun:test';
import { scoreKnowToAsk } from '../src/eval/brainbench/metrics/know-to-ask.ts';
import { scorePush } from '../src/eval/brainbench/metrics/push.ts';
import type { TurnRow } from '../src/eval/brainbench/types.ts';

function row(partial: Partial<TurnRow> & { gold: TurnRow['gold'] }): TurnRow {
  return {
    fixture_id: 'fx',
    turn_id: 1,
    harness: 'openclaw',
    suite: 'know-to-ask',
    injected_slugs: [],
    injected_tokens: 0,
    cross_source_slugs: [],
    latency_ms: 0,
    ...partial,
  };
}

describe('scoreKnowToAsk', () => {
  test('miss on should_retrieve counts; acceptable_slugs also satisfy', () => {
    const rows = [
      row({ turn_id: 1, gold: { should_retrieve: true, gold_slugs: ['a'] }, injected_slugs: [] }),
      row({ turn_id: 2, gold: { should_retrieve: true, gold_slugs: ['a'], acceptable_slugs: ['b'] }, injected_slugs: ['b'] }),
      row({ turn_id: 3, gold: { should_retrieve: true, gold_slugs: ['a'] }, injected_slugs: ['a'] }),
    ];
    const s = scoreKnowToAsk(rows);
    expect(s.metrics.know_to_ask_failure_rate).toBeCloseTo(1 / 3);
    expect(s.gold_failed).toBe(1);
    expect(s.failed_items[0]).toContain('fx#1');
  });

  test('false fire: injection on a stay-silent turn', () => {
    const rows = [
      row({ turn_id: 1, gold: { should_retrieve: false }, injected_slugs: ['x'] }),
      row({ turn_id: 2, gold: { should_retrieve: false }, injected_slugs: [] }),
    ];
    const s = scoreKnowToAsk(rows);
    expect(s.metrics.false_fire_rate).toBeCloseTo(0.5);
    expect(s.metrics.know_to_ask_failure_rate).toBe(0); // zero should_retrieve turns → 0, not NaN
    expect(s.gold_total).toBe(2);
  });

  test('rows without gold are ignored; empty input is all-zeros', () => {
    expect(scoreKnowToAsk([row({ gold: null })]).gold_total).toBe(0);
    const s = scoreKnowToAsk([]);
    expect(s.metrics.know_to_ask_failure_rate).toBe(0);
    expect(s.metrics.false_fire_rate).toBe(0);
  });

  test('"always inject" games the failure rate but bleeds false fires (anti-gaming pair)', () => {
    const rows = [
      row({ turn_id: 1, gold: { should_retrieve: true, gold_slugs: ['a'] }, injected_slugs: ['a', 'junk'] }),
      row({ turn_id: 2, gold: { should_retrieve: false }, injected_slugs: ['junk'] }),
    ];
    const s = scoreKnowToAsk(rows);
    expect(s.metrics.know_to_ask_failure_rate).toBe(0);
    expect(s.metrics.false_fire_rate).toBe(1);
    expect(s.gold_failed).toBe(1);
  });
});

describe('scorePush', () => {
  test('micro-averaged: a 3-slug turn weighs 3x a 1-slug turn', () => {
    const rows = [
      row({ suite: 'push', turn_id: 1, gold: { should_retrieve: true, gold_slugs: ['a', 'b', 'c'] }, injected_slugs: ['a', 'b', 'junk'] }),
      row({ suite: 'push', turn_id: 2, gold: { should_retrieve: true, gold_slugs: ['d'] }, injected_slugs: ['d'] }),
    ];
    const s = scorePush(rows);
    // precision: relevant 3 (a,b,d) of 4 injected; recall: hit 3 (a,b,d) of 4 gold
    expect(s.metrics.push_precision).toBeCloseTo(3 / 4);
    expect(s.metrics.push_recall).toBeCloseTo(3 / 4);
    expect(s.gold_total).toBe(4);
    expect(s.gold_failed).toBe(1);
    expect(s.failed_items[0]).toContain('c');
  });

  test('acceptable counts for precision, NOT required for recall', () => {
    const rows = [
      row({
        suite: 'push',
        gold: { should_retrieve: true, gold_slugs: ['a'], acceptable_slugs: ['extra'] },
        injected_slugs: ['a', 'extra'],
      }),
    ];
    const s = scorePush(rows);
    expect(s.metrics.push_precision).toBe(1); // 'extra' is not junk
    expect(s.metrics.push_recall).toBe(1); // 'extra' was never owed
    expect(s.gold_total).toBe(1);
  });

  test('no injections anywhere → precision 1 (vacuously clean), recall 0 with misses counted', () => {
    const rows = [
      row({ suite: 'push', gold: { should_retrieve: true, gold_slugs: ['a', 'b'] }, injected_slugs: [] }),
    ];
    const s = scorePush(rows);
    expect(s.metrics.push_precision).toBe(1);
    expect(s.metrics.push_recall).toBe(0);
    expect(s.gold_failed).toBe(2);
  });

  test('empty input → both 1 (nothing owed, nothing junk), zero counts', () => {
    const s = scorePush([]);
    expect(s.metrics.push_precision).toBe(1);
    expect(s.metrics.push_recall).toBe(1);
    expect(s.gold_total).toBe(0);
  });
});
