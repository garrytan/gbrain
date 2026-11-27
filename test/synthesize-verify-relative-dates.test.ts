import { describe, expect, test } from 'bun:test';
import { groundSource, unsupportedNumericClaims } from '../src/core/cycle/synthesize-verify.ts';

// 2026-03-09 is a Monday.
const src = groundSource('conversations/2026-03-09-sync.txt', 'Alex: the budget review is due Friday.');

describe('dates resolved from the transcript observation date', () => {
  test('a weekday resolved against the file-name date is not number_not_in_source', () => {
    expect(unsupportedNumericClaims('The budget review is due 2026-03-13.', [src])).toEqual([]);
  });
  test('a date with no relative anchor is still flagged', () => {
    expect(unsupportedNumericClaims('The budget review is due 2026-03-14.', [src])).toEqual(['2026-03-14']);
  });
  test('without a file-name date nothing resolves', () => {
    const bare = groundSource('conversations/sync.txt', 'Alex: the budget review is due Friday.');
    expect(unsupportedNumericClaims('Due 2026-03-13.', [bare])).toEqual(['2026-03-13']);
  });
});

describe('weekday direction', () => {
  test('a bare weekday does not accept the previous occurrence', () => {
    expect(unsupportedNumericClaims('Due 2026-03-06.', [src])).toEqual(['2026-03-06']);
  });
  test('"last Friday" resolves to the earlier occurrence only', () => {
    const last = groundSource('conversations/2026-03-09-sync.txt', 'Alex: we shipped last Friday.');
    expect(unsupportedNumericClaims('Shipped 2026-03-06.', [last])).toEqual([]);
    expect(unsupportedNumericClaims('Shipped 2026-03-13.', [last])).toEqual(['2026-03-13']);
  });
});
