/**
 * Multi-relation planner (pure). Development frames written for this test;
 * the held-out composed-question wording in gbrain-evals is deliberately not
 * mirrored.
 *
 * Protects: 2-3 relation questions become anchor-outward hop chains with the
 * right direction per surface form; coordination, negation, time and
 * multi-entity questions are refused (never guessed); single-relation queries
 * stay `not_applicable` so the one-hop parser keeps them.
 */
import { describe, test, expect } from 'bun:test';
import { parseRelationalPlan, isRelationalQuery } from '../src/core/search/relational-plan.ts';
import { cpuMs } from './helpers/cpu-time.ts';

type Hop = [string, 'object' | 'subject'];
const shape = (q: string) => {
  const r = parseRelationalPlan(q);
  if (r.kind !== 'plan') return r.kind;
  return { anchor: r.plan.anchor, hops: r.plan.hops.map(h => [h.linkTypes[0], h.toward] as Hop), exclude: r.plan.excludeAnchor };
};

const PLANS: Array<[string, string, Hop[], boolean]> = [
  ['Who founded the companies that Alice Example invested in?', 'Alice Example', [['invested_in', 'object'], ['founded', 'subject']], false],
  ['Who invested in companies founded by Alice Example?', 'Alice Example', [['founded', 'object'], ['invested_in', 'subject']], false],
  ['founders of companies Bob Example invested in', 'Bob Example', [['invested_in', 'object'], ['founded', 'subject']], false],
  ['Who are the founders of the companies Alice Example advises?', 'Alice Example', [['advises', 'object'], ['founded', 'subject']], false],
  ['investors in the companies founded by Carol Example', 'Carol Example', [['founded', 'object'], ['invested_in', 'subject']], false],
  ['Which companies did the investors of acme-example also back?', 'acme-example', [['invested_in', 'subject'], ['invested_in', 'object']], true],
  ['Which companies were founded by the investors of acme-example?', 'acme-example', [['invested_in', 'subject'], ['founded', 'object']], false],
  ['Which meetings did the founders of acme-example attend?', 'acme-example', [['founded', 'subject'], ['attended', 'object']], false],
  ['Who else invested in the companies Bob Example invested in?', 'Bob Example', [['invested_in', 'object'], ['invested_in', 'subject']], true],
  ["Who are Alice Example's co-investors?", 'Alice Example', [['invested_in', 'object'], ['invested_in', 'subject']], true],
  ['Who works at the companies backed by fund-a?', 'fund-a', [['invested_in', 'object'], ['works_at', 'subject']], false],
  ['Who advises the companies that Dave Example founded?', 'Dave Example', [['founded', 'object'], ['advises', 'subject']], false],
  ['Which investors backed the companies Alice Example founded?', 'Alice Example', [['founded', 'object'], ['invested_in', 'subject']], false],
  ['Which other investors backed the companies Alice Example backed?', 'Alice Example', [['invested_in', 'object'], ['invested_in', 'subject']], true],
  ['Which other companies did the investors in companies founded by Carol Example back?', 'Carol Example',
    [['founded', 'object'], ['invested_in', 'subject'], ['invested_in', 'object']], true],
  // Polite lead-ins, relative "in which"/"for which", and phrasal relations.
  ['Could you tell me who the founders are of the companies in which Alice Example has invested?', 'Alice Example',
    [['invested_in', 'object'], ['founded', 'subject']], false],
  ['Could you tell me which investors backed the businesses established by Bob Example?', 'Bob Example',
    [['founded', 'object'], ['invested_in', 'subject']], false],
  ['Please list the founders of the startups for which Carol Example serves as an advisor', 'Carol Example',
    [['advises', 'object'], ['founded', 'subject']], false],
  ['Which individuals founded the companies in which Dave Example holds an investment?', 'Dave Example',
    [['invested_in', 'object'], ['founded', 'subject']], false],
  ['Which other parties have invested in the companies that Erin Example has funded?', 'Erin Example',
    [['invested_in', 'object'], ['invested_in', 'subject']], true],
  // Possessive founded forms bind to the entity first.
  ["who put money into Alice Example's startups", 'Alice Example', [['founded', 'object'], ['invested_in', 'subject']], false],
  ["Which other companies did the backers of Bob Example's founded companies also invest in?", 'Bob Example',
    [['founded', 'object'], ['invested_in', 'subject'], ['invested_in', 'object']], true],
  // A back-reference continues the chain instead of coordinating it.
  ['Carol Example advises some companies, who founded them?', 'Carol Example', [['advises', 'object'], ['founded', 'subject']], false],
  ['Dave Example invested in which companies, and who founded them?', 'Dave Example', [['invested_in', 'object'], ['founded', 'subject']], false],
  // The co-relation already walks out and back; its verb is not another hop.
  ['Who are the co-investors in the companies that Erin Example has invested in?', 'Erin Example',
    [['invested_in', 'object'], ['invested_in', 'subject']], true],
];

describe('parseRelationalPlan: plans', () => {
  for (const [q, anchor, hops, exclude] of PLANS) {
    test(q, () => {
      expect(shape(q)).toEqual({ anchor, hops, exclude });
    });
  }

  test('a "who"/"which companies" head constrains a last hop whose relation allows several page types', () => {
    const r = parseRelationalPlan('Who invested in companies founded by Alice Example?');
    expect(r.kind === 'plan' && r.plan.hops[1].nodeType).toBe('person');
  });
});

describe('parseRelationalPlan: tense markers on relations that can end', () => {
  const statuses = (q: string) => {
    const r = parseRelationalPlan(q);
    return r.kind === 'plan' ? r.plan.hops.map(h => [h.linkTypes[0], h.toward, h.status ?? null]) : r;
  };
  test('"formerly advised" walks ended advisory relationships; the founding hop keeps the default', () => {
    expect(statuses('Who founded the companies Alice Example formerly advised?'))
      .toEqual([['advises', 'object', 'ended'], ['founded', 'subject', null]]);
  });
  test('"used to work at" walks every employment; "worked at" too', () => {
    expect(statuses('Who advises the companies Bob Example used to work at?'))
      .toEqual([['works_at', 'object', 'all'], ['advises', 'subject', null]]);
    expect(statuses('Who founded the companies Bob Example worked at?'))
      .toEqual([['works_at', 'object', 'all'], ['founded', 'subject', null]]);
  });
  test('a marker attaches to the relation right after it', () => {
    expect(statuses("Which companies did Carol Example's former employees found?"))
      .toEqual([['works_at', 'subject', 'ended'], ['founded', 'object', null]]);
    expect(statuses('Who currently works at the companies founded by Dave Example?'))
      .toEqual([['founded', 'object', null], ['works_at', 'subject', 'live']]);
  });
  test('events do not end, and dates stay refused', () => {
    for (const [q, reason] of [
      ['Who founded the companies Alice Example formerly invested in?', 'does not end'],
      ['Who previously founded the companies Bob Example backed?', 'does not end'],
      ['Who advised the companies Bob Example funded in 2021?', 'time'],
      ['Who founded the companies Alice Example advised before 2020?', 'time'],
      ['Formerly, who founded the companies Alice Example advises?', 'time'],
    ] as const) {
      const r = parseRelationalPlan(q);
      expect(r.kind).toBe('unsupported');
      expect(r.kind === 'unsupported' && r.reason).toContain(reason);
    }
  });
});

describe('parseRelationalPlan: refusals', () => {
  for (const [q, reason] of [
    ['Which companies did Alice Example found and invest in?', 'coordination'],
    ['Who advised the companies that Bob Example funded in 2021?', 'time'],
    ['Who founded companies that Alice Example did not invest in?', 'negation'],
    ['How many founders of companies backed by fund-a are there?', 'count'],
    ['Who founded the companies "Alice" invested in?', 'quoted'],
  ] as const) {
    test(q, () => {
      const r = parseRelationalPlan(q);
      expect(r.kind).toBe('unsupported');
      expect(r.kind === 'unsupported' && r.reason).toContain(reason);
    });
  }

  test('a chain whose page types disagree is refused', () => {
    expect(parseRelationalPlan("Who invested in acme-example's founders' companies?").kind).toBe('unsupported');
  });
});

describe('single-relation and non-relational queries stay with the one-hop parser', () => {
  for (const q of [
    'who invested in widget-co', "widget-co's investors", 'investors in acme-co', 'list the funders of novapay',
    'who backs quanta?', 'who is the founder of mindbridge', "helio's co-founders", 'founders of quanta',
    "novapay's employees", 'who is employed by helio', 'people who work for acme-co', "mindbridge's advisors",
    'which companies has alice-example backed?', "fund-a's portfolio companies", 'who does bob-example work for',
    "carol-example's employer", 'what companies did dave-example found?', 'which startups does erin-example advise',
    'relationship between fund-a and fund-b', 'how do bob-example and carol-example know each other',
    'who can introduce me to alice-example?', 'Who attended the Q3 board meeting?', 'notes from the offsite',
    'summarize the q3 board deck', 'who invested time in learning Rust', 'what is the capital structure of a seed round',
    'who invested in "Acme Example"?', 'Who has a "40 under 40" mention?',
    'Who among our founders worked at acme-example?', 'Which of my investors advise widget-co?',
  ]) {
    test(q, () => {
      expect(parseRelationalPlan(q).kind).toBe('not_applicable');
    });
  }

  test('linear time on a long adversarial input', () => {
    const q = `${'founders of investors of '.repeat(20)}x`.slice(0, 512);
    expect(cpuMs(() => parseRelationalPlan(q))).toBeLessThan(50);
  });
});

describe('isRelationalQuery', () => {
  test('a planned chain counts as relational only when the planner is on', () => {
    const q = 'Who founded the companies that Alice Example invested in?';
    expect(isRelationalQuery(q, true)).toBe(true);
    expect(isRelationalQuery(q, false)).toBe(false);
    expect(isRelationalQuery('who invested in widget-co', false)).toBe(true);
  });
});
