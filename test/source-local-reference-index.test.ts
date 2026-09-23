import { expect, test } from 'bun:test';
import { buildSourceLocalReferenceIndex } from '../src/core/source-local-reference-index.ts';

test('source-local names combine alias, title and basename candidates without guessing ambiguity', () => {
  const index = buildSourceLocalReferenceIndex([
    { slug: 'people/operator', title: 'Different Title', aliases: ['Ｄｕｔｙ owner', 'Common'] },
    { slug: 'people/peer', title: 'Common', aliases: [] },
    { slug: 'teams/common', title: 'Another Title', aliases: ['Duty owner'] },
  ]);
  expect(index.resolveMatches('Different Title')).toEqual(['people/operator']);
  expect(index.resolveMatches('operator')).toEqual(['people/operator']);
  expect(index.resolveMatches('Common')).toEqual(['people/operator', 'people/peer', 'teams/common']);
  expect(index.resolveMatches('Duty owner')).toEqual(['people/operator', 'teams/common']);
  expect(index.resolveMatches('Duty owner', 'people')).toEqual(['people/operator']);
  expect(index.resolveMatches('Common', ['people', 'teams'])).toEqual(['people/operator', 'people/peer', 'teams/common']);
  expect(index.resolveMatches('people/operator')).toEqual(['people/operator']);
  expect(index.resolveMatches('foreign:people/operator')).toEqual([]);
  expect(index.resolveMatches('../people/operator')).toEqual([]);
  expect(index.basenameMatches('Duty owner')).toEqual([]);
});

test('source-local reference indexes enforce page and metadata bounds', () => {
  expect(() => buildSourceLocalReferenceIndex(Array.from({ length: 100_001 }, () => ({ slug: 'notes/one', title: 'One' })))).toThrow('100,000');
  expect(() => buildSourceLocalReferenceIndex([{ slug: 'notes/large', title: 'x'.repeat(16 * 1024 ** 2) }])).toThrow('16 MiB');
});
