import { expect, test } from 'bun:test';
import { hydraFilter } from '../../src/core/search/hydra-filters.ts';

test('cloud filters preserve type, exclusion and complete date-only until boundaries', () => {
  const admit = hydraFilter({ types: ['note'], since: '2030-06-15', until: '2030-06-15', exclude_slugs: ['notes/excluded'] });
  expect(admit({ slug: 'notes/current', type: 'note', date: '2030-06-15T23:59:59.999Z' })).toBe(true);
  expect(admit({ slug: 'notes/current', type: 'note', date: '2030-06-16T00:00:00Z' })).toBe(false);
  expect(admit({ slug: 'notes/current', type: 'person', date: '2030-06-15T12:00:00Z' })).toBe(false);
  expect(admit({ slug: 'notes/excluded', type: 'note', date: '2030-06-15T12:00:00Z' })).toBe(false);
  expect(admit({ slug: 'notes/no-date', type: 'note' })).toBe(false);
});

test('cloud retrieval retains default hard exclusions and explicit opt-back-in', () => {
  expect(hydraFilter({})({ slug: 'test/noise', type: 'note' })).toBe(false);
  expect(hydraFilter({ include_slug_prefixes: ['test/'] })({ slug: 'test/needed', type: 'note' })).toBe(true);
});

test('unknown cloud metadata cannot satisfy a type or code filter', () => {
  expect(hydraFilter({ types: ['note'] })({ slug: 'notes/unknown' })).toBe(false);
  expect(hydraFilter({ language: 'typescript' })({ slug: 'notes/unknown', type: 'note' })).toBe(false);
});

test('invalid dates are rejected before a cloud request can be made', () => {
  expect(() => hydraFilter({ since: '2030-02-30' })).toThrow('Invalid since');
});
