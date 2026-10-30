/**
 * #7160: name-variant matching for entity lookup (pure). Synthetic names only.
 */
import { describe, expect, test } from 'bun:test';
import { editDistance, givenNameVariants, hasLeadingTitle, matchNameVariant, parsePersonName, probeWords } from '../src/core/entities/name-variants.ts';

describe('matchNameVariant', () => {
  const cases: Array<[string, string, string | null]> = [
    ['Alice Example', 'Alice Example', 'normalized'],
    ['alice-example', 'Alice Example', 'normalized'],
    ['Dr. Alice Example', 'Alice Example', 'honorific'],
    ['Mayor Alice Example Jr.', 'Alice Example', 'honorific'],
    ['example alice', 'Alice Example', 'reordered'],
    ['Example, Alice', 'Alice Example', 'reordered'],
    ['Allie Example', 'Alice Example', 'diminutive'],
    ['Bob Thistlewood', 'Robert Thistlewood', 'diminutive'],
    ['Robert Thistlewood', 'Bob Thistlewood', 'diminutive'],
    ['A. Example', 'Alice Example', 'initial'],
    ['A Example', 'Alice Example', 'initial'],
    ['Alice Exmaple', 'Alice Example', 'typo'],
    ['Alicee Example', 'Alice Example', null],
    ['Jon Example', 'Joe Example', null],
    ['Allie Exmaple', 'Alice Example', 'typo'],
    ['Example', 'Alice Example', 'surname'],
    ['Mayor Example', 'Alice Example', 'surname'],
    ['Alicia Example', 'Alice Example', null],
    ['Alice Examples', 'Alice Example', 'typo'],
    ['Bob Example', 'Alice Example', null],
    ['B. Example', 'Alice Example', null],
    ['Ex', 'Alice Example', null],
    ['Alice', 'Alice Example', null],
    ['Alice Example', 'Example', null],
    ['Alice Q Example', 'Alice Example', null],
  ];
  for (const [q, c, kind] of cases) {
    test(`${q} vs ${c} -> ${kind}`, () => expect(matchNameVariant(q, c)).toBe(kind as never));
  }
});

describe('helpers', () => {
  test('parsePersonName strips leading titles and trailing suffixes, keeps a title-only name', () => {
    expect(parsePersonName('Senator Dr. Alice Example III')).toEqual({ core: ['alice', 'example'], titles: ['senator', 'dr'] });
    expect(parsePersonName('Mayor')).toEqual({ core: ['mayor'], titles: [] });
  });
  test('hasLeadingTitle reads titles and slug basenames', () => {
    expect(hasLeadingTitle('Mayor Example')).toBe(true);
    expect(hasLeadingTitle('mayor-example')).toBe(true);
    expect(hasLeadingTitle('Alice Example')).toBe(false);
  });
  test('editDistance counts a transposition as one edit and caps', () => {
    expect(editDistance('example', 'exmaple')).toBe(1);
    expect(editDistance('example', 'exampel')).toBe(1);
    expect(editDistance('example', 'sample')).toBe(2);
  });
  test('probeWords keeps core words of three or more letters', () => {
    expect(probeWords('Dr. A. Example')).toEqual(['example']);
  });
});

describe('givenNameVariants (#7471)', () => {
  test('swaps the given name for each other form in its groups', () => {
    expect(givenNameVariants('Matt Examplesurname')).toEqual(['matthew examplesurname']);
    expect(givenNameVariants('Matthew Examplesurname')).toEqual(['matt examplesurname']);
    expect(givenNameVariants('Bob Samplename')).toEqual(['robert samplename', 'rob samplename', 'bobby samplename', 'robbie samplename', 'bert samplename']);
  });
  test('keeps leading titles and swaps the word after them', () => {
    expect(givenNameVariants('Dr. Matt Examplesurname')).toEqual(['dr matthew examplesurname']);
  });
  test('skips forms full-text search drops as stopwords', () => {
    expect(givenNameVariants('Bill Example')).not.toContain('will example');
    expect(givenNameVariants('Donald Example')).toEqual(['donnie example']);
  });
  test('needs 2-4 words, a surname after the given name and a known given name', () => {
    expect(givenNameVariants('Matt')).toEqual([]);
    expect(givenNameVariants('Dr Matt')).toEqual([]);
    expect(givenNameVariants('Matt and the quarterly planning notes')).toEqual([]);
    expect(givenNameVariants('Acme Example')).toEqual([]);
  });
  test('caps the variants', () => {
    expect(givenNameVariants('Bob Samplename', 2)).toEqual(['robert samplename', 'rob samplename']);
  });
});
