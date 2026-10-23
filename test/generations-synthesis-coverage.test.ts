/**
 * GBRA-161 PR 4 (#7065): the pure predecessor match (generations/synthesis-coverage.ts). An earlier synthesis output may
 * retire only as an exact duplicate, or on the same subject with every claim unit, quote and citation covered.
 */
import { describe, expect, test } from 'bun:test';
import { citations, claimUnits, matchPredecessor, quotes, subjectStem, titleTokens } from '../src/core/generations/synthesis-coverage.ts';

const earlier = { slug: 'wiki/personal/reflections/2026-10-01-storage-plan-0b4ba2', title: 'Storage plan',
  body: 'The storage plan moved to object storage. Costs are reviewed weekly.\n\n> we charge for durability\n\nDecided with [[people/alice-example]].' };
const page = (slug: string, title: string, body: string) => ({ slug, title, body });

describe('synthesis predecessor match (#7065)', () => {
  test('the subject stem drops the hash suffix, the chunk suffix and the date prefix; title tokens are a sorted lowercase set', () => {
    expect(subjectStem('wiki/personal/reflections/2026-10-01-storage-plan-0b4ba2')).toBe('wiki/personal/reflections/storage-plan');
    expect(subjectStem('wiki/personal/reflections/storage-plan-70251c-c1')).toBe('wiki/personal/reflections/storage-plan');
    expect(titleTokens('Plan: Storage, plan!')).toBe('plan storage');
  });

  test('claim units skip quote blocks and headings; quotes are > blocks and quoted spans of three or more words; citations are link targets', () => {
    const body = '# Heading\nFirst claim. Second claim!\n> a quoted block\nShe said "only two" and "this one counts here".\nSee [[people/alice-example|Alice]] and [doc](https://example.com/a).';
    expect(claimUnits(body)).toEqual(['first claim', 'second claim', 'she said "only two" and "this one counts here"', 'see alice and doc']);
    expect(quotes(body)).toEqual(['a quoted block', 'this one counts here']);
    expect(citations(body)).toEqual(['https://example.com/a', 'people/alice-example']);
  });

  test('an exact duplicate matches whatever its slug', () => {
    expect(matchPredecessor(earlier, [page('wiki/personal/originals/other-1a2b3c', 'Other', earlier.body)])).toMatchObject({ matched: true, why: 'duplicate' });
  });

  test('a successor on the same subject that covers every claim, quote and citation matches', () => {
    const successor = page('wiki/personal/reflections/2026-10-02-storage-plan-70251c', 'Storage plan', earlier.body + '\n\nA new claim from the grown transcript.');
    expect(matchPredecessor(earlier, [successor])).toEqual({ matched: true, why: 'covered', successor: successor.slug });
  });

  test('one unquoted claim the successor lacks keeps the earlier page live, with the count', () => {
    const successor = page('wiki/personal/reflections/storage-plan-70251c', 'Storage plan', earlier.body.replace(' Costs are reviewed weekly.', ''));
    expect(matchPredecessor(earlier, [successor])).toEqual({ matched: false, why: 'uncovered', missing: { claims: 1, quotes: 0, citations: 0 } });
  });

  test('a missing quote or citation keeps it live', () => {
    const noQuote = page('wiki/personal/reflections/storage-plan-70251c', 'Storage plan', earlier.body.replace('> we charge for durability', 'We charge for it.'));
    expect(matchPredecessor(earlier, [noQuote])).toMatchObject({ matched: false, missing: { quotes: 1 } });
    const noCite = page('wiki/personal/reflections/storage-plan-70251c', 'Storage plan', earlier.body.replace('[[people/alice-example]]', 'Alice-example'));
    expect(matchPredecessor(earlier, [noCite])).toMatchObject({ matched: false, missing: { citations: 1 } });
  });

  test('full coverage under another subject is not a match', () => {
    const renamed = page('wiki/personal/reflections/storage-strategy-70251c', 'Storage strategy', earlier.body + ' More.');
    expect(matchPredecessor(earlier, [renamed])).toMatchObject({ matched: false, why: 'no_subject', missing: { claims: 0, quotes: 0, citations: 0 } });
  });
});
