/**
 * question→temporal-window seam (explicit tokens only).
 *
 * `parseQuestionWindow` derives a window from EXACTLY ONE unambiguous explicit
 * date token (`YYYY-MM-DD`, `YYYY-MM`, or full month-name + 4-digit year),
 * reusing the shipped `parseTemporalWindow`/`parseBound` contract. It adds NO new
 * date semantics and NO relative civil-time semantics. Explicit caller since/until
 * stay authoritative via the exported production resolver `resolveTemporalWindow`,
 * which `runThink` calls (index.ts) — this suite binds to that helper directly, not a
 * copied expression. Pure: no engine, no LLM, no `now` — deterministic.
 */

import { describe, test, expect } from 'bun:test';
import { parseQuestionWindow, parseTemporalWindow, resolveTemporalWindow } from '../src/core/think/temporal-window.ts';

const win = (since?: string, until?: string) => parseTemporalWindow(since, until);

describe('parseQuestionWindow — supported explicit tokens', () => {
  test('single ISO day → that calendar day (== parseTemporalWindow(day,day))', () => {
    expect(parseQuestionWindow('what changed on 2026-09-15 exactly'))
      .toEqual(win('2026-09-15', '2026-09-15'));
  });

  test('single ISO month → that month', () => {
    expect(parseQuestionWindow('summarize 2026-09 for me')).toEqual(win('2026-09', '2026-09'));
  });

  test('full month name + year → that month (== the ISO-month window)', () => {
    expect(parseQuestionWindow('meetings in September 2026')).toEqual(win('2026-09', '2026-09'));
  });

  test('a "mid-<Month> <Year>" question shape resolves to that month', () => {
    expect(parseQuestionWindow('Summarize my upcoming week of acme meetings (mid-September 2026).'))
      .toEqual(win('2026-09', '2026-09'));
  });

  test('month name is case-insensitive', () => {
    expect(parseQuestionWindow('SEPTEMBER 2026 recap')).toEqual(win('2026-09', '2026-09'));
    expect(parseQuestionWindow('september 2026 recap')).toEqual(win('2026-09', '2026-09'));
  });

  test('a single token mentioned twice in the same normalized form is still one window', () => {
    expect(parseQuestionWindow('September 2026 (2026-09) plans')).toEqual(win('2026-09', '2026-09'));
  });
});

describe('parseQuestionWindow — fail-closed to null (no invented dates, no silent narrowing)', () => {
  test('no date token → null', () => {
    expect(parseQuestionWindow('what are my open commitments')).toBeNull();
  });

  test('bare 4-digit year is NEVER a bound ("GPT-4 in 2024", "v2026", "in 2026")', () => {
    expect(parseQuestionWindow('what did GPT-4 in 2024 change')).toBeNull();
    expect(parseQuestionWindow('notes about v2026 planning')).toBeNull();
    expect(parseQuestionWindow('what happened in 2026')).toBeNull();
  });

  test('two or more DISTINCT tokens → null (ambiguous range)', () => {
    expect(parseQuestionWindow('between September 2026 and October 2026')).toBeNull();
    expect(parseQuestionWindow('compare 2026-09-15 and 2026-09-22')).toBeNull();
    expect(parseQuestionWindow('September 2026 vs 2026-10')).toBeNull();
  });

  test('partial / invalid tokens → null', () => {
    expect(parseQuestionWindow('the 2026-13 quarter')).toBeNull(); // invalid month
    expect(parseQuestionWindow('around 2026-9 sometime')).toBeNull(); // not zero-padded
    expect(parseQuestionWindow('Septober 2026 offsite')).toBeNull(); // not a real month name
  });

  test('relative civil-time phrases are OUT OF SCOPE → null (deferred; no invented window)', () => {
    expect(parseQuestionWindow('meetings next week')).toBeNull();
    expect(parseQuestionWindow("this month's emails")).toBeNull();
    expect(parseQuestionWindow('what happened in the last 7 days')).toBeNull();
    expect(parseQuestionWindow('recent updates')).toBeNull();
  });

  test('empty / non-string question → null', () => {
    expect(parseQuestionWindow('')).toBeNull();
    expect(parseQuestionWindow(undefined)).toBeNull();
    expect(parseQuestionWindow(null)).toBeNull();
  });
});

describe('precedence — the PRODUCTION resolver `resolveTemporalWindow` (the exact helper runThink calls)', () => {
  // Binds to the shipped resolver, not a copied `??` expression: if the index.ts
  // wiring were removed/reversed, these fail.
  test('explicit caller since/until win over the question token', () => {
    expect(resolveTemporalWindow('September 2026', '2020-01-01', '2020-12-31'))
      .toEqual(win('2020-01-01', '2020-12-31'));
  });

  test('a single explicit caller bound (since only) still wins over the question token', () => {
    expect(resolveTemporalWindow('September 2026', '2020-01-01', undefined))
      .toEqual(win('2020-01-01', undefined));
  });

  test('when both are absent, the question window is used', () => {
    expect(resolveTemporalWindow('September 2026', undefined, undefined))
      .toEqual(win('2026-09', '2026-09'));
  });

  test('when both are absent AND the question has no token, the window is null (unchanged behavior)', () => {
    expect(resolveTemporalWindow('open commitments', undefined, undefined)).toBeNull();
  });
});
