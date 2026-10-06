/**
 * Soft time scope and content date extraction.
 *
 * Protects: (1) the reserved contract never displaces the top ⌈k/2⌉ baseline
 * results and never drops a result; (2) partition is the paper's full
 * reorder; (3) no in-range result leaves the order untouched; (4) relative
 * content dates need a known observation date, and code/URLs never yield
 * dates. Regression it catches: a time scope that evicts the best unscoped
 * evidence, or version strings indexed as event dates.
 */
import { describe, test, expect } from 'bun:test';
import { applyTimeScope } from '../src/core/search/hybrid/time-scope.ts';
import { extractEventDates } from '../src/core/event-dates.ts';

type R = { id: string; dates: Array<{ start: string; end: string }> };
const day = (d: string) => [{ start: d, end: d }];
const pool: R[] = [
  { id: 'a', dates: day('2023-01-10') },
  { id: 'b', dates: day('2023-02-10') },
  { id: 'c', dates: day('2023-04-05') },
  { id: 'd', dates: day('2023-01-11') },
  { id: 'e', dates: day('2023-04-02') },
  { id: 'f', dates: [] },
];
const april = { start: '2023-04-01', end: '2023-04-30' };

describe('applyTimeScope', () => {
  test('reserved keeps the top ⌈k/2⌉ in place and fills the rest of k with in-range results', () => {
    const out = applyTimeScope(pool, april, r => r.dates, { mode: 'reserved', k: 4 });
    expect(out.results.map(r => r.id)).toEqual(['a', 'b', 'c', 'e', 'd', 'f']);
    expect(out.inRange).toBe(2);
  });

  test('partition moves every in-range result first', () => {
    const out = applyTimeScope(pool, april, r => r.dates, { mode: 'partition', k: 4 });
    expect(out.results.map(r => r.id)).toEqual(['c', 'e', 'a', 'b', 'd', 'f']);
  });

  test('slack widens the range by two days on each side by default', () => {
    const out = applyTimeScope(pool, { start: '2023-02-12', end: '2023-02-20' }, r => r.dates, { mode: 'partition', k: 4 });
    expect(out.results[0].id).toBe('b');
    const tight = applyTimeScope(pool, { start: '2023-02-12', end: '2023-02-20' }, r => r.dates, { mode: 'partition', k: 4, slackDays: 0 });
    expect(tight.inRange).toBe(0);
  });

  test('no in-range result returns the input order, and every mode is a permutation', () => {
    const none = applyTimeScope(pool, { start: '2020-01-01', end: '2020-01-31' }, r => r.dates, { mode: 'reserved', k: 4 });
    expect(none.results.map(r => r.id)).toEqual(pool.map(r => r.id));
    expect(none.moved).toBe(0);
    for (const mode of ['reserved', 'partition'] as const) {
      const out = applyTimeScope(pool, april, r => r.dates, { mode, k: 3 });
      expect([...out.results].map(r => r.id).sort()).toEqual(pool.map(r => r.id).sort());
    }
  });
});

describe('extractEventDates', () => {
  test('relative phrases resolve against the observation date; absolute dates always resolve', () => {
    const dated = extractEventDates('Yesterday I finished the book. The launch was on 2023-03-01.', '2023-04-02');
    expect(dated.map(d => [d.origin, d.start])).toEqual([['observation', '2023-04-02'], ['relative', '2023-04-01'], ['mention', '2023-03-01']]);
    const undated = extractEventDates('Yesterday I finished the book. The launch was on 2023-03-01.', null);
    expect(undated.map(d => [d.origin, d.start])).toEqual([['mention', '2023-03-01']]);
  });

  test('code and URLs yield no dates', () => {
    const out = extractEventDates('Run `migrate --since 2021-01-01` and see https://example.com/2020/05/01/post\n```\nreleased 2019-02-03\n```', null);
    expect(out).toEqual([]);
  });
});
