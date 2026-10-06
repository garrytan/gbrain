/**
 * The query time-range grammar, frozen before any dev-split scoring. Golden
 * cases are the published LongMemEval time-range examples (question date →
 * expected range, or no range) plus generic English expressions; they were
 * not drawn from benchmark questions.
 *
 * Protects: explicit time cues resolve to the right calendar range against
 * the reference day, and questions without an explicit cue (or asking for a
 * duration, or naming two times in different roles) produce no range — a
 * false range would hide the right evidence.
 */
import { describe, test, expect } from 'bun:test';
import { parseQueryTimeRange } from '../src/core/search/time-range.ts';
import { findTimeMentions } from '../src/core/temporal-grammar.ts';

function range(q: string, ref: string) {
  const r = parseQueryTimeRange(q, ref);
  return r.range ? [r.range.start, r.range.end] : r.reason;
}

describe('published time-range examples', () => {
  test('ranges the examples expect', () => {
    expect(range('What was the date on which I attended the first BBQ event in June?', '2023-07-01')).toEqual(['2023-06-01', '2023-06-30']);
    expect(range('Where did I attend the religious activity last week?', '2023-04-10')).toEqual(['2023-04-03', '2023-04-09']);
    expect(range('Which pair of shoes did I clean last month?', '2023-05-30')).toEqual(['2023-04-01', '2023-04-30']);
    expect(range('Which airline did I fly with the most in March and April?', '2023-04-27')).toEqual(['2023-03-01', '2023-04-30']);
    const twoMonths = parseQueryTimeRange('What did I do with Rachel on the Wednesday two months ago?', '2023-04-01').range!;
    expect(twoMonths.start <= '2023-02-01' && twoMonths.end >= '2023-02-01').toBe(true);
    expect(twoMonths.start >= '2023-01-20' && twoMonths.end <= '2023-02-10').toBe(true);
    const lastTue = parseQueryTimeRange('Who did I meet with during the lunch last Tuesday?', '2023-04-18').range!;
    expect([lastTue.start, lastTue.end]).toEqual(['2023-04-11', '2023-04-11']);
  });

  test('questions the examples mark as having no time range', () => {
    expect(range('How many months ago did I book the Airbnb in San Francisco?', '2023-05-27')).toBe('no_cue');
    expect(range('How long have I been using my Fitbit Charge 3?', '2023-09-04')).toBe('no_cue');
    expect(range('How many bikes do I currently own?', '2023-10-27')).toBe('no_cue');
    expect(range('What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?', '2023-12-18')).toBe('no_cue');
    expect(range('How many engineers do I lead when I just started my new role as Senior Software Engineer? How many engineers do I lead now?', '2023-11-10')).toBe('no_cue');
    expect(range('How long had I been taking guitar lessons when I bought the new guitar amp?', '2023-05-28')).toBe('no_cue');
    expect(range("How many days before the 'Rack Fest' did I participate in the 'Turbocharged Tuesdays' event?", '2023-06-28')).toBe('no_cue');
  });
});

describe('generic English', () => {
  const ref = '2026-10-04'; // a Sunday
  test.each([
    ['what happened yesterday', ['2026-10-03', '2026-10-03']],
    ['notes from this week', ['2026-09-28', '2026-10-04']],
    ['what did we decide last weekend', ['2026-09-26', '2026-09-27']],
    ['what did I read last year', ['2025-01-01', '2025-12-31']],
    ['plans for next month', ['2026-11-01', '2026-11-30']],
    ['the call last Friday', ['2026-10-02', '2026-10-02']],
    ['what changed in the past month', ['2026-09-04', '2026-10-04']],
    ['revenue in Q3 2022', ['2022-07-01', '2022-09-30']],
    ['the offsite in 2022', ['2022-01-01', '2022-12-31']],
    ['the launch on March 15th', ['2026-03-15', '2026-03-15']],
    ['the dinner on 2 May 2024', ['2024-05-02', '2024-05-02']],
    ['the board meeting in December', ['2025-12-01', '2025-12-31']],
    ['what we shipped last summer', ['2026-06-01', '2026-08-31']],
    ['between May and July 2025', ['2025-05-01', '2025-07-31']],
  ])('%s', (q, want) => {
    expect(range(q, ref)).toEqual(want);
  });

  test('a weekday-named day resolves to the most recent one strictly before the reference day', () => {
    expect(range('the lunch last Sunday', '2026-10-04')).toEqual(['2026-09-27', '2026-09-27']);
  });

  test('two separate times in different roles abstain; duration questions abstain', () => {
    expect(range('Which June deadline did we cancel in May?', ref)).toBe('multi_role');
    expect(range('How many days ago did I read the March 15th issue?', ref)).toBe('duration_question');
    expect(range('How many weeks passed between the fair in May and the trip?', ref)).toBe('duration_question');
    expect(range('How many days did I spend hiking this year?', ref)).toEqual(['2026-01-01', '2026-12-31']);
  });

  test('modal "may", plurals and quoted names are not dates', () => {
    expect(range('What may I bring to the party?', ref)).toBe('no_cue');
    expect(range('I go to yoga on Tuesdays', ref)).toBe('no_cue');
    expect(range('Did I like "Last Summer" the movie?', ref)).toBe('no_cue');
  });
});

describe('content mentions resolve against the page date', () => {
  test('relative phrases in a dated page', () => {
    const m = findTimeMentions('I missed a 5K fun run on March 26th. Yesterday I booked a bike fitting for next week.', '2023-04-02', 'past');
    expect(m.map(x => [x.cue, x.start, x.end])).toEqual([
      ['March 26th', '2023-03-26', '2023-03-26'],
      ['Yesterday', '2023-04-01', '2023-04-01'],
      ['next week', '2023-04-03', '2023-04-09'],
    ]);
  });
});
