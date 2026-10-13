/**
 * recall `since` relative phrases (src/core/facts/since-parse.ts). The recall
 * op's parser keeps its grammar and falls back to the relative one, so the
 * additive check compares it with a copy of the grammar it had before the
 * fallback on every form that grammar accepted. Op-level coverage on both
 * engines is in test/recall-question.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { parseRelativeSince } from '../src/core/facts/since-parse.ts';
import { parseSinceParam } from '../src/core/ops/facts.ts';

const NOW = Date.UTC(2026, 2, 31, 12, 0, 0);
const DAY = 86_400_000;

function previousGrammar(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);
  const ago = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)(?:\s+ago)?$/i);
  if (!ago) return null;
  const n = parseInt(ago[1]!, 10);
  const unit = ago[2]!.toLowerCase();
  const ms = unit.startsWith('s') ? n * 1000 : unit.startsWith('m') ? n * 60_000 : unit.startsWith('h') ? n * 3_600_000 : n * DAY;
  return new Date(Date.now() - ms);
}

describe('parseRelativeSince', () => {
  test('weeks, months and years, counted or "a"/"an"/"one", with or without "ago"', () => {
    const at = (s: string) => parseRelativeSince(s, NOW)?.toISOString() ?? null;
    expect(at('6 weeks ago')).toBe(new Date(NOW - 42 * DAY).toISOString());
    expect(at('6 Weeks  Ago')).toBe(new Date(NOW - 42 * DAY).toISOString());
    expect(at('a week ago')).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(at('an hour ago')).toBe(new Date(NOW - 3_600_000).toISOString());
    expect(at('3w')).toBe(new Date(NOW - 21 * DAY).toISOString());
    expect(at('1 month ago')).toBe('2026-02-28T12:00:00.000Z');
    expect(at('2mo')).toBe('2026-01-31T12:00:00.000Z');
    expect(at('one year ago')).toBe('2025-03-31T12:00:00.000Z');
    expect(at('1y')).toBe('2025-03-31T12:00:00.000Z');
  });

  test('"last" and "past" windows', () => {
    const at = (s: string) => parseRelativeSince(s, NOW)?.toISOString() ?? null;
    expect(at('last month')).toBe('2026-02-28T12:00:00.000Z');
    expect(at('last week')).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(at('past 2 weeks')).toBe(new Date(NOW - 14 * DAY).toISOString());
    expect(at('the last 6 weeks')).toBe(new Date(NOW - 42 * DAY).toISOString());
    expect(at('in the past 2 years')).toBe('2024-03-31T12:00:00.000Z');
    expect(at('last year')).toBe('2025-03-31T12:00:00.000Z');
  });

  test('anything else is not a relative phrase', () => {
    for (const s of ['month ago', 'weeks ago', 'last', 'last few weeks', 'aweek', 'a while back', 'next week', '6 fortnights ago', '99999999999999999999 years ago', '9999999 years ago']) {
      expect(parseRelativeSince(s, NOW)).toBeNull();
    }
  });
});

describe('recall parseSinceParam stays additive', () => {
  test('every form the previous grammar accepted parses to the same instant', () => {
    const forms: unknown[] = ['2026-08-11T00:00:00Z', '2026-08-11', 'Tue, 11 Aug 2026 00:00:00 GMT', 1_786_406_400_000,
      '8 hours ago', '3 days ago', '30m', '1h', '2d', '7d', '45 sec', '10 minutes ago', ' 2d '];
    for (const f of forms) {
      const before = previousGrammar(f);
      const after = parseSinceParam(f);
      expect(before).not.toBeNull();
      expect(Math.abs(after!.getTime() - before!.getTime())).toBeLessThan(1000);
    }
  });

  test('forms the previous grammar refused now parse, and garbage is still refused', () => {
    for (const f of ['6 weeks ago', 'last month', 'a week ago', '2mo']) {
      expect(previousGrammar(f)).toBeNull();
      expect(parseSinceParam(f)).toBeInstanceOf(Date);
    }
    for (const f of ['a while back', '', '   ', null, undefined, {}, Number.NaN]) expect(parseSinceParam(f)).toBeNull();
  });
});
