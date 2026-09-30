/**
 * Relational intent recognition beyond the parser's own verbs. The template
 * phrasings ("who invested in X") fired the relational arm, but ordinary
 * rewordings ("X's investors", "people who funded X", "who backs X", "who is
 * the founder of X") parsed as non-relational, so the arm never ran.
 *
 * These are DEVELOPMENT paraphrases written for this test. The frozen
 * held-out paraphrase split in gbrain-evals is deliberately not mirrored.
 */
import { describe, test, expect } from 'bun:test';
import { parseRelationalQuery, KNOWN_LINK_TYPES, type RelationalKind, type RelationDirection } from '../src/core/search/relational-intent.ts';

type Expect = { kind: RelationalKind; seeds: string[]; linkTypes: string[] | null; direction: RelationDirection };
const INVEST = ['invested_in', 'led_round'];

const POSITIVES: Array<[string, Expect]> = [
  // investors of a company (incoming)
  ["widget-co's investors", { kind: 'who_rel', seeds: ['widget-co'], linkTypes: INVEST, direction: 'in' }],
  ['Who are Widget Co’s backers?', { kind: 'who_rel', seeds: ['Widget Co'], linkTypes: INVEST, direction: 'in' }],
  ['investors in acme-co', { kind: 'who_rel', seeds: ['acme-co'], linkTypes: INVEST, direction: 'in' }],
  ['list the funders of novapay', { kind: 'who_rel', seeds: ['novapay'], linkTypes: INVEST, direction: 'in' }],
  ['people who funded helio', { kind: 'who_rel', seeds: ['helio'], linkTypes: INVEST, direction: 'in' }],
  ['who backs quanta?', { kind: 'who_rel', seeds: ['quanta'], linkTypes: INVEST, direction: 'in' }],
  ['who has invested in mindbridge', { kind: 'who_rel', seeds: ['mindbridge'], linkTypes: INVEST, direction: 'in' }],
  ['which funds put money into widget-co', { kind: 'who_rel', seeds: ['widget-co'], linkTypes: INVEST, direction: 'in' }],
  ['who led the seed round for acme-co', { kind: 'who_rel', seeds: ['acme-co'], linkTypes: INVEST, direction: 'in' }],
  ['what firms have financed novapay?', { kind: 'who_rel', seeds: ['novapay'], linkTypes: INVEST, direction: 'in' }],
  // founders (incoming)
  ['who is the founder of mindbridge', { kind: 'who_rel', seeds: ['mindbridge'], linkTypes: ['founded'], direction: 'in' }],
  ["helio's co-founders", { kind: 'who_rel', seeds: ['helio'], linkTypes: ['founded'], direction: 'in' }],
  ['founders of quanta', { kind: 'who_rel', seeds: ['quanta'], linkTypes: ['founded'], direction: 'in' }],
  ['who started acme-co?', { kind: 'who_rel', seeds: ['acme-co'], linkTypes: ['founded'], direction: 'in' }],
  ['which people co-founded widget-co', { kind: 'who_rel', seeds: ['widget-co'], linkTypes: ['founded'], direction: 'in' }],
  // employees (incoming)
  ["novapay's employees", { kind: 'who_rel', seeds: ['novapay'], linkTypes: ['works_at'], direction: 'in' }],
  ['who is employed by helio', { kind: 'who_rel', seeds: ['helio'], linkTypes: ['works_at'], direction: 'in' }],
  ['staff at quanta', { kind: 'who_rel', seeds: ['quanta'], linkTypes: ['works_at'], direction: 'in' }],
  ['people who work for acme-co', { kind: 'who_rel', seeds: ['acme-co'], linkTypes: ['works_at'], direction: 'in' }],
  ["who's on the team at widget-co", { kind: 'who_rel', seeds: ['widget-co'], linkTypes: ['works_at'], direction: 'in' }],
  // advisors (incoming)
  ["mindbridge's advisors", { kind: 'who_rel', seeds: ['mindbridge'], linkTypes: ['advises'], direction: 'in' }],
  ['who are the advisers to novapay?', { kind: 'who_rel', seeds: ['novapay'], linkTypes: ['advises'], direction: 'in' }],
  ['people who advise helio', { kind: 'who_rel', seeds: ['helio'], linkTypes: ['advises'], direction: 'in' }],
  ['who sits on the advisory board of quanta', { kind: 'who_rel', seeds: ['quanta'], linkTypes: ['advises'], direction: 'in' }],
  // outgoing
  ['which companies has alice-example backed?', { kind: 'who_rel', seeds: ['alice-example'], linkTypes: INVEST, direction: 'out' }],
  ["fund-a's portfolio companies", { kind: 'who_rel', seeds: ['fund-a'], linkTypes: INVEST, direction: 'out' }],
  ['who does bob-example work for', { kind: 'who_rel', seeds: ['bob-example'], linkTypes: ['works_at'], direction: 'out' }],
  ["carol-example's employer", { kind: 'who_rel', seeds: ['carol-example'], linkTypes: ['works_at'], direction: 'out' }],
  ['what companies did dave-example found?', { kind: 'who_rel', seeds: ['dave-example'], linkTypes: ['founded'], direction: 'out' }],
  ['which startups does erin-example advise', { kind: 'who_rel', seeds: ['erin-example'], linkTypes: ['advises'], direction: 'out' }],
  // connects
  ['relationship between fund-a and fund-b', { kind: 'connects', seeds: ['fund-a', 'fund-b'], linkTypes: null, direction: 'both' }],
  ['what is the connection between alice-example and widget-co?', { kind: 'connects', seeds: ['alice-example', 'widget-co'], linkTypes: null, direction: 'both' }],
  ['how is novapay connected to helio', { kind: 'connects', seeds: ['novapay', 'helio'], linkTypes: null, direction: 'both' }],
  ['what do acme-co and quanta have in common?', { kind: 'connects', seeds: ['acme-co', 'quanta'], linkTypes: null, direction: 'both' }],
  ['how do bob-example and carol-example know each other', { kind: 'connects', seeds: ['bob-example', 'carol-example'], linkTypes: null, direction: 'both' }],
  // intro
  ['who can introduce me to alice-example?', { kind: 'intro', seeds: ['alice-example'], linkTypes: null, direction: 'both' }],
  ['who could connect us with bob-example', { kind: 'intro', seeds: ['bob-example'], linkTypes: null, direction: 'both' }],
  ['who knows carol-example?', { kind: 'intro', seeds: ['carol-example'], linkTypes: null, direction: 'both' }],
];

const NEGATIVES = [
  'what did I eat for dinner last tuesday',
  'who did I go to the concert with?',
  'how do I invest in index funds',
  'who knows how to deploy the staging cluster',
  'people who work remotely are more productive',
  'what are the founders of stoicism known for',
  'employees should submit expenses by friday',
  'what is the idea of debating in public forums',
  'how are embeddings and keywords combined in hybrid search',
  'staff meeting notes from monday',
  'advisors often underestimate the time commitment',
  'what should I name my new puppy',
  'who is the best person to ask about taxes',
  'my portfolio allocation for next year',
];

describe('relational intent — development paraphrases', () => {
  for (const [query, want] of POSITIVES) {
    test(query, () => {
      const got = parseRelationalQuery(query);
      expect(got).not.toBeNull();
      expect({ kind: got!.kind, seeds: got!.seeds, linkTypes: got!.linkTypes, direction: got!.direction }).toEqual(want);
      for (const lt of got!.linkTypes ?? []) expect(KNOWN_LINK_TYPES.has(lt)).toBe(true);
    });
  }
});

// Syntactically relational phrasings with a non-entity seed ("who started the
// fire", "the relationship between sleep and memory") still parse; the arm
// only fires when relational-recall resolves the seed to a page.
describe('relational intent — precision on non-relational queries', () => {
  test('generic seeds and non-relational phrasing stay null', () => {
    const fired = NEGATIVES.filter(q => parseRelationalQuery(q) !== null);
    expect(fired).toEqual([]);
  });
});
