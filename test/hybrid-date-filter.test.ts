import { describe, expect, test } from 'bun:test';
import { normalizeSearchDate } from '../src/core/search/hybrid.ts';

describe('hybrid search date filters', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');

  test('resolves documented compact relative durations', () => {
    expect(normalizeSearchDate('7d', 'since', now)).toBe('2026-07-16T12:00:00.000Z');
    expect(normalizeSearchDate('2w', 'since', now)).toBe('2026-07-09T12:00:00.000Z');
    expect(normalizeSearchDate('1y', 'since', now)).toBe('2025-07-23T12:00:00.000Z');
  });

  test('uses end-of-day semantics for plain until dates', () => {
    expect(normalizeSearchDate('2026-07-16', 'until', now))
      .toBe('2026-07-16T23:59:59.999Z');
  });

  test('normalizes valid ISO dates and rejects invalid input loudly', () => {
    expect(normalizeSearchDate('2026-07-16', 'since', now))
      .toBe('2026-07-16T00:00:00.000Z');
    expect(() => normalizeSearchDate('recent-ish', 'since', now))
      .toThrow('Invalid since date');
  });
});
