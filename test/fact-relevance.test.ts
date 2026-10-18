/**
 * The shared fact scorer (src/core/search/fact-relevance.ts), pure parts:
 * whole-word term share, the per-fact stuffing cap, the dated bonus, the
 * (score, valid_from, id) order and both preregistered admission rules.
 */
import { describe, expect, test } from 'bun:test';
import { DATED_BONUS, TERM_STUFFING_RATIO, admitted, scoreFactCandidates, type FactCandidate } from '../src/core/search/fact-relevance.ts';

let next = 1;
function cand(fact: string, extra: Partial<FactCandidate> = {}): FactCandidate {
  const at = extra.created_at ?? '2026-01-10T00:00:00Z';
  return {
    id: next++, fact, kind: 'fact', entity_slug: null, source_id: 'default', source: 'test',
    valid_from: at, valid_until: null, created_at: at, claim_metric: null, claim_period: null, entity: false, ...extra,
  };
}

describe('fact scorer', () => {
  test('term share counts whole words, never substrings', () => {
    const [s] = scoreFactCandidates('rust compiler', [cand('We trust the compilers team')]);
    expect(s!.matched).toBe(0);
    expect(s!.termShare).toBe(0);
    const [w] = scoreFactCandidates('rust compiler', [cand('The rust compiler got faster')]);
    expect(w!.matched).toBe(2);
    expect(w!.termShare).toBe(1);
  });

  test('entity slugs match as words, hyphenated and split', () => {
    const [s] = scoreFactCandidates('alice offsite', [cand('Booked the offsite', { entity_slug: 'alice-example' })]);
    expect(s!.matched).toBe(2);
  });

  test('a fact with many more content terms than the question has its term share scaled down', () => {
    const question = 'coffee roast morning';
    const stuffed = cand(`coffee roast morning ${Array.from({ length: 60 }, (_, i) => `word${i}x`).join(' ')}`);
    const [s] = scoreFactCandidates(question, [stuffed]);
    expect(s!.matched).toBe(3);
    expect(s!.termShare).toBeCloseTo(3 / Math.ceil(63 / TERM_STUFFING_RATIO), 6);
    expect(admitted(s!, 'reserve')).toBe(false);
    const [plain] = scoreFactCandidates(question, [cand('Dark roast coffee every morning')]);
    expect(plain!.termShare).toBe(1);
    expect(admitted(plain!, 'reserve')).toBe(true);
  });

  test('score is cosine + term share + the dated bonus when valid_from is a writer-supplied date', () => {
    const dated = cand('trip to Lisbon', { valid_from: '2025-05-01T00:00:00Z', created_at: '2026-01-10T00:00:00Z', similarity: 0.4 });
    const [s] = scoreFactCandidates('lisbon trip', [dated]);
    expect(s!.score).toBeCloseTo(0.4 + 1 + DATED_BONUS, 6);
  });

  test('ties order by newest valid_from, then id', () => {
    const older = cand('kayak lesson', { valid_from: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' });
    const newer = cand('kayak lesson', { valid_from: '2026-01-05T00:00:00Z', created_at: '2026-01-05T00:00:00Z' });
    const sameTimeA = cand('kayak lesson', { valid_from: '2026-01-05T00:00:00Z', created_at: '2026-01-05T00:00:00Z' });
    const order = scoreFactCandidates('kayak lesson', [older, newer, sameTimeA]).map(s => s.candidate.id);
    expect(order).toEqual([sameTimeA.id, newer.id, older.id]);
  });

  test('the two admission rules: reserve (cosine 0.5 or share 0.34) and facts arm (cosine 0.6, half the terms, or the named entity)', () => {
    const q = 'alpha beta gamma delta';
    const [oneTerm] = scoreFactCandidates(q, [cand('alpha only here')]);
    expect(admitted(oneTerm!, 'reserve')).toBe(false);
    expect(admitted(oneTerm!, 'facts_arm')).toBe(false);
    const [twoTerms] = scoreFactCandidates(q, [cand('alpha and beta')]);
    expect(admitted(twoTerms!, 'reserve')).toBe(true);
    expect(admitted(twoTerms!, 'facts_arm')).toBe(true);
    const [cos55] = scoreFactCandidates(q, [cand('unrelated words', { similarity: 0.55 })]);
    expect(admitted(cos55!, 'reserve')).toBe(true);
    expect(admitted(cos55!, 'facts_arm')).toBe(false);
    const [entity] = scoreFactCandidates(q, [cand('unrelated words', { entity: true })]);
    expect(admitted(entity!, 'reserve')).toBe(false);
    expect(admitted(entity!, 'facts_arm')).toBe(true);
  });
});
