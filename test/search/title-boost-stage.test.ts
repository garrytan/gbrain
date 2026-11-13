/**
 * T2 — applyTitleBoost stage unit tests (mutate-in-place post-fusion stage).
 * Verifies: title-match multiplies + stamps; non-match untouched; floor-gate
 * skips below-threshold results; idempotent factor stamping.
 */

import { describe, test, expect } from 'bun:test';
import { applyTitleBoost, DEFAULT_TITLE_BOOST } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { applyIdentityBoosts, type HybridRequest } from '../../src/core/search/hybrid/request.ts';
import { weightsForIntent } from '../../src/core/search/intent-weights.ts';

function mk(slug: string, title: string, score: number): SearchResult {
  return {
    slug, title, score,
    chunk_text: '', type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1,
  } as unknown as SearchResult;
}

describe('applyTitleBoost', () => {
  test('multiplies score and stamps title_match_boost on a title-phrase match', () => {
    const r = mk('projects/mingtang', 'The Mingtang — Indoor Greek Amphitheater', 0.8);
    applyTitleBoost([r], 'greek amphitheater', DEFAULT_TITLE_BOOST);
    expect(r.score).toBeCloseTo(0.8 * 1.25, 6);
    expect(r.title_match_boost).toBe(1.25);
  });

  test('leaves non-matching results untouched (no stamp)', () => {
    const r = mk('notes/other', 'Completely Unrelated Title', 0.8);
    applyTitleBoost([r], 'greek amphitheater', DEFAULT_TITLE_BOOST);
    expect(r.score).toBe(0.8);
    expect(r.title_match_boost).toBeUndefined();
  });

  test('floor-gate skips a matching result below threshold', () => {
    const strong = mk('projects/mingtang', 'Indoor Greek Amphitheater', 1.0);
    const weak = mk('notes/aside', 'A Greek Amphitheater Footnote', 0.50);
    // threshold = 0.85 * topScore(1.0) = 0.85; weak (0.50) is below.
    applyTitleBoost([strong, weak], 'greek amphitheater', DEFAULT_TITLE_BOOST, 0.85);
    expect(strong.title_match_boost).toBe(1.25);
    expect(weak.title_match_boost).toBeUndefined(); // gated out
    expect(weak.score).toBe(0.50);
  });

  test('factor <= 1.0 is a no-op (disabled)', () => {
    const r = mk('projects/mingtang', 'Greek Amphitheater', 0.8);
    applyTitleBoost([r], 'greek amphitheater', 1.0);
    expect(r.score).toBe(0.8);
    expect(r.title_match_boost).toBeUndefined();
  });

  test('empty query is a no-op', () => {
    const r = mk('projects/mingtang', 'Greek Amphitheater', 0.8);
    applyTitleBoost([r], '', DEFAULT_TITLE_BOOST);
    expect(r.score).toBe(0.8);
  });
});

describe('applyTitleBoost — given-name variants (#7471)', () => {
  test('a short first name counts as a title match for the formal title, and back', () => {
    const formal = mk('people/matthew-examplesurname', 'Matthew Examplesurname', 0.8);
    applyTitleBoost([formal], 'Matt Examplesurname', DEFAULT_TITLE_BOOST);
    expect(formal.title_match_boost).toBe(1.25);
    const short = mk('people/bob-samplename', 'Bob Samplename', 0.8);
    applyTitleBoost([short], 'Robert Samplename', DEFAULT_TITLE_BOOST);
    expect(short.title_match_boost).toBe(1.25);
  });

  test('another person with the same first name gets no boost', () => {
    const other = mk('people/matt-otherperson', 'Matt Otherperson', 0.8);
    applyTitleBoost([other], 'Matt Examplesurname', DEFAULT_TITLE_BOOST);
    expect(other.score).toBe(0.8);
    expect(other.title_match_boost).toBeUndefined();
  });
});

describe('qualified title boost (search.title_qualified)', () => {
  const person = (score = 0.5) => ({ ...mk('people/alice-example', 'Alice Example', score), type: 'person' }) as SearchResult;
  const stubEngine = { resolveAliases: async () => new Map(), getConfig: async () => null } as never;
  // intent null: intent weighting off, so only the qualified arm can move a score.
  const run = async (list: SearchResult[], query: string, on: boolean, intent: 'general' | 'entity' | null = null) => {
    const req = {
      engine: stubEngine, query, opts: {}, suggestions: { intent: intent ?? 'general' }, intentWeightingOn: intent !== null,
      intentWeights: weightsForIntent(intent ?? 'general'),
      resolvedMode: { relational_planner: false, title_qualified: on, title_boost: DEFAULT_TITLE_BOOST },
    } as unknown as HybridRequest;
    await applyIdentityBoosts(req, list, Promise.resolve(null));
    return list;
  };
  const Q = 'acme widget team lead alice example';

  test('a person title inside the query is boosted only when on, whatever its score', async () => {
    const off = (await run([person(0.01)], Q, false))[0];
    expect(off.score).toBe(0.01);
    expect(off.title_mention_boost).toBeUndefined();
    const on = (await run([person(0.01)], Q, true))[0];
    expect(on.score).toBeCloseTo(0.01 * DEFAULT_TITLE_BOOST, 8);
    expect(on.title_mention_boost).toBe(DEFAULT_TITLE_BOOST);
    expect(on.title_match_boost).toBeUndefined();
  });

  test('general intent: on, with intent weighting, the person page is boosted once', async () => {
    const r = (await run([person(0.5)], Q, true, 'general'))[0];
    expect(r.title_mention_boost).toBe(DEFAULT_TITLE_BOOST);
    expect(r.score).toBeCloseTo(0.5 * DEFAULT_TITLE_BOOST, 8);
  });

  test('a generic 3-token note title and a one-token company title are not boosted', async () => {
    const note = mk('meetings/weekly-team-sync', 'Weekly Team Sync', 0.5);
    const company = { ...mk('companies/acme', 'Acme', 0.5), type: 'company' } as SearchResult;
    await run([note, company], 'action items and owners from the weekly team sync at acme corp', true);
    expect(note.title_mention_boost).toBeUndefined();
    expect(company.title_mention_boost).toBeUndefined();
    expect(note.score).toBe(0.5);
    expect(company.score).toBe(0.5);
  });

  test('a forward title match keeps the floor: no qualified boost for it', async () => {
    const r = person(0.01);
    await run([r], 'alice example', true);
    expect(r.title_mention_boost).toBeUndefined();
    expect(r.score).toBe(0.01);
  });

  test('a row that already carries exact_match_boost gets no second boost', async () => {
    const r = { ...person(0.5), exact_match_boost: 1.18 } as SearchResult;
    await run([r], Q, true);
    expect(r.title_mention_boost).toBeUndefined();
    expect(r.score).toBe(0.5);
  });

  test('general intent: a title the #4694 subject boost already raised gets no second boost', async () => {
    const r = (await run([person(0.5)], 'acme alice example', true, 'general'))[0];
    expect(r.exact_match_boost).toBeDefined();
    expect(r.title_mention_boost).toBeUndefined();
    expect(r.score).toBeCloseTo(0.5 * r.exact_match_boost!, 8);
  });

  test('under entity intent a mentioned person page gets exactly one multiplier', async () => {
    const r = person(0.5);
    await run([r], 'who is alice example at acme', true, 'entity');
    expect(r.exact_match_boost).toBe(weightsForIntent('entity').exactMatchBoost);
    expect(r.title_mention_boost).toBeUndefined();
    expect(r.score).toBeCloseTo(0.5 * weightsForIntent('entity').exactMatchBoost, 8);
  });

  test('a given-name variant of the query counts as a mention', async () => {
    const r = { ...mk('people/matthew-examplesurname', 'Matthew Examplesurname', 0.5), type: 'person' } as SearchResult;
    await run([r], 'matt examplesurname at acme', true);
    expect(r.title_mention_boost).toBe(DEFAULT_TITLE_BOOST);
  });
});
