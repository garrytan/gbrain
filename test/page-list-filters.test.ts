import { describe, expect, test } from 'bun:test';
import {
  PageListFilterError,
  parsePageFrontmatterFields,
  parsePageFrontmatterFilters,
  parsePageListOffset,
  projectPageFrontmatter,
} from '../src/core/page-list-filters.ts';

describe('parsePageListOffset', () => {
  test('accepts an omitted or non-negative integer offset', () => {
    expect(parsePageListOffset(undefined)).toBeUndefined();
    expect(parsePageListOffset(0)).toBe(0);
    expect(parsePageListOffset(12)).toBe(12);
  });

  test('rejects negative and fractional offsets', () => {
    expect(() => parsePageListOffset(-1)).toThrow(PageListFilterError);
    expect(() => parsePageListOffset(1.5)).toThrow(PageListFilterError);
  });
});

describe('parsePageFrontmatterFilters', () => {
  test('accepts supported clauses and preserves value case', () => {
    expect(parsePageFrontmatterFilters([
      { field: 'from_address', operator: 'eq_ci', value: 'Sender@Example.com' },
      { field: 'subject', operator: 'contains_any_ci', values: ['SPACE PENDING', 'ROLLING'] },
    ])).toEqual([
      { field: 'from_address', operator: 'eq_ci', value: 'Sender@Example.com' },
      { field: 'subject', operator: 'contains_any_ci', values: ['SPACE PENDING', 'ROLLING'] },
    ]);
  });

  test('accepts an omitted filter list as empty', () => {
    expect(parsePageFrontmatterFilters(undefined)).toEqual([]);
  });

  test('rejects a non-array and more than eight clauses', () => {
    expect(() => parsePageFrontmatterFilters({})).toThrow(PageListFilterError);
    expect(() => parsePageFrontmatterFilters(Array.from({ length: 9 }, () => ({
      field: 'subject',
      operator: 'eq_ci',
      value: 'Update',
    })))).toThrow(PageListFilterError);
  });

  test('rejects sparse filter arrays', () => {
    const sparseFilters: unknown[] = [];
    sparseFilters.length = 1;

    expect(() => parsePageFrontmatterFilters(sparseFilters))
      .toThrow(PageListFilterError);
  });

  test('rejects sparse contains-any value arrays', () => {
    const sparseValues: unknown[] = [];
    sparseValues.length = 1;

    expect(() => parsePageFrontmatterFilters([{
      field: 'subject',
      operator: 'contains_any_ci',
      values: sparseValues,
    }])).toThrow(PageListFilterError);
  });

  test('rejects unsupported operators', () => {
    expect(() => parsePageFrontmatterFilters([
      { field: 'subject', operator: 'starts_with_ci', value: 'Update' },
    ])).toThrow(PageListFilterError);
  });

  test('rejects nested and overlong field names', () => {
    expect(() => parsePageFrontmatterFilters([
      { field: 'sender.address', operator: 'eq_ci', value: 'sender@example.com' },
    ])).toThrow(PageListFilterError);
    expect(() => parsePageFrontmatterFilters([
      { field: `a${'b'.repeat(64)}`, operator: 'eq_ci', value: 'sender@example.com' },
    ])).toThrow(PageListFilterError);
  });

  test('rejects empty and overlong values', () => {
    expect(() => parsePageFrontmatterFilters([
      { field: 'subject', operator: 'eq_ci', value: '   ' },
    ])).toThrow(PageListFilterError);
    expect(() => parsePageFrontmatterFilters([
      { field: 'subject', operator: 'eq_ci', value: 'x'.repeat(513) },
    ])).toThrow(PageListFilterError);
  });

  test('rejects empty or oversized contains-any value lists', () => {
    expect(() => parsePageFrontmatterFilters([
      { field: 'subject', operator: 'contains_any_ci', values: [] },
    ])).toThrow(PageListFilterError);
    expect(() => parsePageFrontmatterFilters([
      { field: 'subject', operator: 'contains_any_ci', values: Array.from({ length: 17 }, (_, index) => `value-${index}`) },
    ])).toThrow(PageListFilterError);
  });

  test('rejects malformed clause objects', () => {
    const malformed: unknown[] = [
      null,
      'subject',
      { operator: 'eq_ci', value: 'Update' },
      { field: 'subject', value: 'Update' },
      { field: 'subject', operator: 'eq_ci' },
      { field: 'subject', operator: 'contains_any_ci' },
      { field: 'subject', operator: 'contains_any_ci', values: ['Update', 7] },
    ];

    for (const clause of malformed) {
      expect(() => parsePageFrontmatterFilters([clause])).toThrow(PageListFilterError);
    }
  });
});

describe('parsePageFrontmatterFields', () => {
  test('deduplicates valid top-level fields in first-seen order', () => {
    expect(parsePageFrontmatterFields(['email_id', 'subject', 'email_id']))
      .toEqual(['email_id', 'subject']);
  });

  test('accepts an omitted projection as empty', () => {
    expect(parsePageFrontmatterFields(undefined)).toEqual([]);
  });

  test('rejects a non-array and more than sixteen projected fields', () => {
    expect(() => parsePageFrontmatterFields('subject')).toThrow(PageListFilterError);
    expect(() => parsePageFrontmatterFields(
      Array.from({ length: 17 }, (_, index) => `field_${index}`),
    )).toThrow(PageListFilterError);
  });

  test('rejects nested and overlong projected fields', () => {
    expect(() => parsePageFrontmatterFields(['sender.address'])).toThrow(PageListFilterError);
    expect(() => parsePageFrontmatterFields([`a${'b'.repeat(64)}`])).toThrow(PageListFilterError);
  });
});

describe('projectPageFrontmatter', () => {
  test('returns only requested fields that exist', () => {
    expect(projectPageFrontmatter(
      { email_id: 'm-1', subject: 'Carrier update', hidden: 'no' },
      ['email_id', 'subject'],
    )).toEqual({ email_id: 'm-1', subject: 'Carrier update' });
  });

  test('returns an empty object when frontmatter is absent', () => {
    expect(projectPageFrontmatter(null, ['subject'])).toEqual({});
    expect(projectPageFrontmatter(undefined, ['subject'])).toEqual({});
  });
});
