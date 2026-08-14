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
import { looksConceptShaped, conceptNudge } from '../src/core/search/query-intent.ts';

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
