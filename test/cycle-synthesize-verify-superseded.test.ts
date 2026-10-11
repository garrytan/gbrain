// #5425 [UC4] (wave 14 PR3 row P3.9): `superseded_in_source`, behind
// `dream.attribution_checks` (default off).
//
// Protects: with the switch on, a synthesized sentence whose grounded quote a
// LATER user turn takes back on the same number or date is quarantined with
// reason `superseded_in_source`; a later user sentence that merely repeats
// the number, negates a different number, negates in an assistant turn, or
// comes before the quote supersedes nothing; a bare year is never a target.
// With the switch off (the default, and every caller that does not pass
// `supersession`), the output is byte-identical to the previous release.
// Fails when: the check fires without the switch, misses the same-sentence
// rule, or counts non-user turns. Why not existing coverage:
// cycle-synthesize-verify-decisions.test.ts pins attribution, not retraction.
// No production seam: `verifyBody` already takes an options object.

import { describe, expect, test } from 'bun:test';
import { emptyQuoteVerifyStats, groundSource, verifyBody, verifyDreamPage } from '../src/core/cycle/synthesize-verify.ts';
import { ATTRIBUTION_CHECKS_KEY, attributionChecksEnabled, parseAttributionChecks } from '../src/core/cycle/attribution-checks.ts';
import { assertCycleConfigValue, CYCLE_GUARDED_KEYS } from '../src/core/cycle/config-guards.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

const transcript = [
  '[user]',
  'Let us settle the beta budget and the launch.',
  '[assistant]',
  'I suggest capping the beta at $30K of credits and launching on 2026-10-15.',
  '[user]',
  'Yes, cap the beta at $30K of credits. We have 5 engineers on it.',
  '[assistant]',
  'Noted. Anything else?',
  '[user]',
  'Actually, not $30K. Make the cap $45K. The launch date stays 2026-10-15.',
  '[user]',
  'Also, we do not have 5 engineers on it any more, only 4. The 2019 cohort is unaffected.',
].join('\n');
const src = [groundSource('/t/budget.txt', transcript)];
const on = { supersession: true } as const;

describe('superseded_in_source (#5425 [UC4], dream.attribution_checks on)', () => {
  test('a sentence whose quote the user later took back on the same number is quarantined', () => {
    const body = 'The user said "cap the beta at $30K of credits" for the first month.';
    const r = verifyBody(body, src, on);
    expect(r.quarantined.map(q => q.reason)).toEqual(['superseded_in_source']);
    expect(r.quarantined[0]!.detail).toContain('$30K');
    expect(r.quarantined[0]!.detail).toContain('taken back by the user: Actually, not $30K');
    expect(r.body).toBe('');
    expect(r.failures.superseded_in_source).toBe(1);
  });

  test('a later user sentence that merely repeats the date is not a retraction', () => {
    const body = 'The assistant suggested "launching on 2026-10-15" after the pricing page.';
    expect(verifyBody(body, src, on).quarantined).toEqual([]);
  });

  test('a negation of a different number, even in the same later turn, is not a retraction', () => {
    const body = 'The user said "cap the beta at $30K of credits" for the first month.';
    const later = [groundSource('/t/other.txt', [
      '[assistant]', 'I suggest capping the beta at $30K of credits.',
      '[user]', 'Yes, cap the beta at $30K of credits.',
      '[user]', 'We will not spend $12,000 on ads this quarter.',
    ].join('\n'))];
    expect(verifyBody(body, later, on).quarantined).toEqual([]);
  });

  test('an unrelated later sentence sharing a bare number is not a retraction (same-sentence rule)', () => {
    const body = 'The user said "We have 5 engineers on it" at the start.';
    expect(verifyBody(body, src, on).quarantined).toEqual([]);
  });

  test('a negation in an assistant turn, or a user turn before the quote, supersedes nothing', () => {
    const t = [groundSource('/t/order.txt', [
      '[user]', 'Not $30K, that is too much.',
      '[assistant]', 'Then let us cap the beta at $30K of credits anyway? No, not $30K, sorry, $20K.',
      '[user]', 'Fine, "cap the beta at $20K of credits" it is.',
    ].join('\n'))];
    expect(verifyBody('The user said "cap the beta at $20K of credits" at the end.', t, on).quarantined).toEqual([]);
    expect(verifyBody('The assistant said "cap the beta at $30K of credits" first.', t, on).quarantined).toEqual([]);
  });

  test('a bare year is never a retraction target', () => {
    const t = [groundSource('/t/year.txt', [
      '[assistant]', 'The 2019 cohort set the pattern for this.',
      '[user]', 'No, the 2019 cohort was different.',
    ].join('\n'))];
    expect(verifyBody('The assistant said "The 2019 cohort set the pattern for this".', t, on).quarantined).toEqual([]);
  });

  test('a transcript without speaker turns is never checked', () => {
    const flat = [groundSource('/t/notes.txt', 'Notes: cap the beta at $30K of credits. Not $30K after all.')];
    expect(verifyBody('The notes say "cap the beta at $30K of credits".', flat, on).quarantined).toEqual([]);
  });
});

describe('dream.attribution_checks off: byte-identical output', () => {
  const body = 'The user said "cap the beta at $30K of credits" for the first month.';
  test('verifyBody without the option quarantines nothing and leaves the body alone', () => {
    const r = verifyBody(body, src);
    expect(r.quarantined).toEqual([]);
    expect(r.body).toBe(body);
    expect(r.failures.superseded_in_source).toBe(0);
    expect(verifyBody(body, src, { supersession: false })).toEqual(r);
  });

  test('verifyDreamPage without `supersession` is unchanged; with it, the sentence moves to unverified_claims', () => {
    const page = { slug: 'wiki/x', compiled_truth: body, timeline: '', frontmatter: {} };
    const off = verifyDreamPage(page, src, { prior: null, checkedAt: '2026-10-10' }, emptyQuoteVerifyStats());
    expect(off.compiled_truth).toBe(body);
    expect(off.frontmatter.unverified_claims).toBeUndefined();
    const stats = emptyQuoteVerifyStats();
    const flagged = verifyDreamPage(page, src, { prior: null, checkedAt: '2026-10-10', supersession: true }, stats);
    expect(flagged.compiled_truth).not.toContain('$30K');
    expect((flagged.frontmatter.unverified_claims as Array<{ reason: string }>).map(u => u.reason)).toEqual(['superseded_in_source']);
    expect(stats.superseded_in_source).toBe(1);
  });
});

describe('the switch', () => {
  test('is registered, boolean-validated on config set, and off unless a true word is stored', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain(ATTRIBUTION_CHECKS_KEY);
    expect(CYCLE_GUARDED_KEYS).toContain(ATTRIBUTION_CHECKS_KEY);
    for (const [raw, want] of [['true', true], ['on', true], ['1', true], ['false', false], ['off', false], ['maybe', null], ['', null]] as const) {
      expect(parseAttributionChecks(raw)).toBe(want);
    }
    expect(() => assertCycleConfigValue(ATTRIBUTION_CHECKS_KEY, 'maybe')).toThrow(/expected true or false/);
    expect(() => assertCycleConfigValue(ATTRIBUTION_CHECKS_KEY, 'true')).not.toThrow();
    const engineWith = (value: string | null) => ({ getConfig: async (key: string) => (key === ATTRIBUTION_CHECKS_KEY ? value : null) });
    expect(await attributionChecksEnabled(engineWith(null))).toBe(false);
    expect(await attributionChecksEnabled(engineWith('false'))).toBe(false);
    expect(await attributionChecksEnabled(engineWith('true'))).toBe(true);
    expect(await attributionChecksEnabled({ getConfig: async () => { throw new Error('db down'); } })).toBe(false);
  });
});
