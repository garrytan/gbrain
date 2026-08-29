/**
 * #2416 — concept-shaped query detection (CLI nudge toward `query`).
 *
 * The classifier is tuned to favor false-negatives (silence) over
 * false-positives (noise): the cost of a missed nudge is zero; the cost of
 * nagging on an exact-token lookup is trust erosion. The non-collision block
 * pins the deliberate cue exclusions — "who are the" (find_experts) and bare
 * "anything…" (salience ops) must NEVER trigger the query nudge.
 */

import { describe, test, expect } from 'bun:test';
import { looksConceptShaped, conceptNudge, classifyQueryIntent, intentToDetail } from '../src/core/search/query-intent.ts';

describe('#2416 — looksConceptShaped: concept/landscape queries → true', () => {
  const CONCEPT_SHAPED = [
    'all the companies that do offshore wind',
    'every project that uses pgvector',
    'find all startups doing agent memory',
    'list everything about vector databases',
    'everything related to embedding pricing',
    'the landscape of agent memory startups',
    'the ecosystem of MCP servers',
    'which funds have invested in climate tech',
    'show all notes that mention fundraising strategy',
  ];
  for (const q of CONCEPT_SHAPED) {
    test(`true: "${q}"`, () => {
      expect(looksConceptShaped(q)).toBe(true);
    });
  }
});

describe('#2416 — looksConceptShaped: exact-token / entity / quoted → false', () => {
  const NOT_CONCEPT_SHAPED = [
    // bare tokens / proper-noun lookups (short-query guard)
    'stripe',
    'Series A',
    'acme-example',
    // quoted phrase — exact-match intent
    'find all notes with "offshore wind"',
    // slug-like token
    'all the pages that link to widget-co-seed',
    // entity lookups (classifyQueryIntent === 'entity')
    'who is alice from acme',
    'tell me about widget co',
    // plain questions without a fuzzy-quantifier cue
    'how does the embed backfill work',
    'meeting notes from tuesday',
  ];
  for (const q of NOT_CONCEPT_SHAPED) {
    test(`false: "${q}"`, () => {
      expect(looksConceptShaped(q)).toBe(false);
    });
  }
});

describe('#2416 — cue non-collision with other routers', () => {
  test('"who are the …" stays silent (owned by find_experts)', () => {
    expect(looksConceptShaped('who are the ML people in my network')).toBe(false);
  });
  test('bare "anything …" stays silent (owned by salience ops)', () => {
    expect(looksConceptShaped('anything notable lately')).toBe(false);
    expect(looksConceptShaped('anything crazy happening in my brain lately?')).toBe(false);
  });
});

describe('#2416 — conceptNudge message', () => {
  test('returns null for non-concept queries', () => {
    expect(conceptNudge('stripe')).toBeNull();
    expect(conceptNudge('who is alice from acme')).toBeNull();
  });

  test('returns a single-line hint naming `gbrain query` and the completeness caveat', () => {
    const msg = conceptNudge('all the companies that do offshore wind');
    expect(msg).not.toBeNull();
    expect(msg!).toContain('gbrain query');
    expect(msg!).toContain('all the companies that do offshore wind');
    expect(msg!).toContain('not proof of completeness');
    expect(msg!.includes('\n')).toBe(false);
  });

  test('truncates long queries in the copy-paste suggestion', () => {
    const long = 'all the companies that are doing something with autonomous underwater drone inspection services';
    const msg = conceptNudge(long)!;
    expect(msg).toContain('...');
    expect(msg.length).toBeLessThan(320);
  });
});

describe('v0.46.15 — classifyQueryIntent concept-guard branches (Cat 13)', () => {
  test('mid-sentence capital blocks concept: "What is Stripe Atlas?" → entity', () => {
    // Sentence-initial capitalization alone does not block; a proper noun
    // AFTER the first token is v1-conservative evidence of an entity lookup.
    expect(classifyQueryIntent('What is Stripe Atlas?')).toBe('entity');
  });

  test('definitional paraphrase without proper nouns → concept', () => {
    expect(classifyQueryIntent('What is the ownership economy?')).toBe('concept');
    expect(classifyQueryIntent('What are embeddings used for in retrieval?')).toBe('concept');
  });

  test('<3-word guard: bare two-word phrase never classifies concept', () => {
    expect(classifyQueryIntent('ownership economy')).toBe('general');
  });

  test("intentToDetail('concept') → undefined (concept never narrows detail)", () => {
    expect(intentToDetail('concept')).toBeUndefined();
  });
});

describe('v0.46.15 ship-review F5 — lowercase NAMES keep the entity tilt', () => {
  // The identity wave's own premise is that users type names lowercase; the
  // definitional concept cue must not cannibalize those lookups.
  test('status-verb queries about an entity are NOT concept', () => {
    expect(classifyQueryIntent('what is saoirse working on')).toBe('entity');
    expect(classifyQueryIntent('what is alice up to these days')).toBe('entity');
  });

  test('single-word lowercase subject is NOT concept (undecidable → entity)', () => {
    expect(classifyQueryIntent('what do i know about galewright')).toBe('entity');
    expect(classifyQueryIntent('what is kubernetes')).not.toBe('concept');
  });

  test('multi-word lowercase noun-phrase subjects stay concept', () => {
    expect(classifyQueryIntent('what do i know about founder liquidity')).toBe('concept');
    expect(classifyQueryIntent('what is the compounding advantage idea')).toBe('concept');
  });
});
