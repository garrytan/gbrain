/**
 * `--since` refuses a day the calendar does not have.
 *
 * parseSince is the one `--since` parser behind `gbrain agent logs`, `gbrain access read-log`, `gbrain beliefs`
 * and `gbrain repair`. `new Date('2026-02-30')` rolls over to 2026-03-02, so a mistyped short-month date used to
 * select a window two days later than the one typed, and `repair` printed that other instant in its follow-up
 * command. It must refuse instead, while every real day keeps parsing.
 */

import { describe, test, expect } from 'bun:test';
import { parseSince } from '../src/core/since.ts';

describe('parseSince refuses days that do not exist', () => {
  for (const bad of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-06-31T08:00:00Z', '2026-09-31 12:00', '2026-11-31T23:30:00-07:00']) {
    test(`${bad} is refused, not rolled into the next month`, () => {
      expect(() => parseSince(bad)).toThrow(/^--since: could not parse/);
    });
  }

  test('the error names the caller\'s flag', () => {
    expect(() => parseSince('2026-02-30', '--after')).toThrow(/^--after: could not parse/);
  });

  test('real days still parse: leap day, month ends and offsets that cross midnight', () => {
    expect(parseSince('2028-02-29')).toBe('2028-02-29T00:00:00.000Z');
    expect(parseSince('2026-01-31')).toBe('2026-01-31T00:00:00.000Z');
    expect(parseSince('2026-04-30T12:00:00Z')).toBe('2026-04-30T12:00:00.000Z');
    expect(parseSince('2026-10-31T23:30:00-07:00')).toBe('2026-11-01T06:30:00.000Z');
  });

  test('relative ages are unaffected', () => {
    expect(parseSince('1d', '--since', Date.UTC(2026, 2, 1))).toBe('2026-02-28T00:00:00.000Z');
  });
});
