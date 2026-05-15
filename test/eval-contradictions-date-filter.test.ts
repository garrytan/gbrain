/**
 * Date pre-filter tests — A1 three-rule pre-filter.
 *
 * Codex's critique: the naive "both have dates AND dates differ → skip" rule
 * would miss real contradictions. These tests pin the layered rules:
 *   - Same-paragraph dual dates → DO NOT skip (flip-flop case).
 *   - One side missing dates → DO NOT skip.
 *   - Both sides explicit AND separated by >30 days → SKIP (the obvious case).
 */

import { describe, test, expect } from 'bun:test';
import {
  extractDates,
  hasSameParagraphDualDate,
  shouldSkipForDateMismatch,
} from '../src/core/eval-contradictions/date-filter.ts';

describe('extractDates', () => {
  test('YYYY-MM-DD', () => {
    const dates = extractDates('On 2024-08-12 we shipped');
    expect(dates.length).toBe(1);
    expect(dates[0].getUTCFullYear()).toBe(2024);
    expect(dates[0].getUTCMonth()).toBe(7);
    expect(dates[0].getUTCDate()).toBe(12);
  });

  test('YYYY/MM/DD', () => {
    const dates = extractDates('happened 2024/08/12');
    expect(dates.length).toBe(1);
    expect(dates[0].getUTCFullYear()).toBe(2024);
  });

  test('quarter strings', () => {
    const dates = extractDates('shipped in Q2 2024');
    expect(dates.length).toBe(1);
    expect(dates[0].getUTCFullYear()).toBe(2024);
  });

  test('bare year', () => {
    const dates = extractDates('back in 2024 we');
    expect(dates.length).toBe(1);
    expect(dates[0].getUTCFullYear()).toBe(2024);
  });

  test('multiple dates', () => {
    const dates = extractDates('from 2024-01-15 to 2026-03-22');
    expect(dates.length).toBe(2);
  });

  test('no dates returns empty array', () => {
    expect(extractDates('plain text no dates here')).toEqual([]);
    expect(extractDates('')).toEqual([]);
  });

  test('rejects implausible years', () => {
    expect(extractDates('written in 1066')).toEqual([]);
    expect(extractDates('back in 3050')).toEqual([]);
  });
});

describe('hasSameParagraphDualDate', () => {
  test('two dates in one paragraph → true', () => {
    const text = 'In Jan 2024 I thought X.\nIn Mar 2024 I changed my mind to not-X.';
    expect(hasSameParagraphDualDate(text)).toBe(true);
  });

  test('two dates in different paragraphs → false', () => {
    const text = 'In 2024 we did X.\n\nIn 2026 we did Y.';
    expect(hasSameParagraphDualDate(text)).toBe(false);
  });

  test('only one date in text → false', () => {
    expect(hasSameParagraphDualDate('on 2024-01-15 we shipped')).toBe(false);
  });

  test('two SAME dates in one paragraph → false (not distinct)', () => {
    expect(hasSameParagraphDualDate('on 2024-01-15 and also 2024-01-15')).toBe(false);
  });

  test('empty text → false', () => {
    expect(hasSameParagraphDualDate('')).toBe(false);
  });
});

describe('shouldSkipForDateMismatch', () => {
  test('both explicit + >30 days apart → SKIP (the obvious quarterly case)', () => {
    const d = shouldSkipForDateMismatch({
      textA: 'Acme MRR was $50K (2024-08-01)',
      textB: 'Acme MRR was $2M (2026-03-15)',
    });
    expect(d.skip).toBe(true);
    expect(d.reason).toBe('both_explicit_separated');
  });

  test('both explicit + within 30 days → do NOT skip', () => {
    const d = shouldSkipForDateMismatch({
      textA: 'on 2024-08-01 Alice was CFO',
      textB: 'on 2024-08-20 Alice was not CFO',
    });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe('overlapping_or_close');
  });

  test('one side missing date → do NOT skip', () => {
    const d = shouldSkipForDateMismatch({
      textA: 'Alice is the CFO',
      textB: 'Alice left the company on 2026-03-01',
    });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe('one_or_both_missing_dates');
  });

  test('both sides missing dates → do NOT skip', () => {
    const d = shouldSkipForDateMismatch({
      textA: 'Acme is profitable',
      textB: 'Acme is unprofitable',
    });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe('one_or_both_missing_dates');
  });

  test('same-paragraph dual-date overrides separation rule', () => {
    // Even though the OTHER chunk has a date 100 days later, the same-paragraph
    // flip in A means we must NOT skip.
    const d = shouldSkipForDateMismatch({
      textA: 'In Jan 2024 I said X. In Mar 2024 I reversed to not-X.',
      textB: 'In 2026 I still hold not-X.',
    });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe('same_paragraph_dual_date');
  });

  test('regression: regex lastIndex reset between calls', () => {
    // The /g regex shares lastIndex across calls; if not reset, the second
    // call returns wrong results. This test pins the reset.
    const text = 'see 2024-01-15 and 2026-03-22 and 2025-06-10';
    const a = extractDates(text);
    const b = extractDates(text);
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(3);
  });
});
