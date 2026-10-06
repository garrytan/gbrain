/**
 * Soft time scope: move results whose dates fall inside the question's time
 * range forward without dropping anything.
 *
 * `reserved` (shipping candidate) keeps the top ⌈k/2⌉ baseline results in
 * place, fills the rest of the first k slots with in-range results in their
 * baseline order, then continues with the remaining baseline order — so the
 * strongest unscoped evidence is never displaced. `partition` moves every
 * in-range result ahead of every other result (the published replication
 * arm). Both are permutations of the input; with no in-range result the
 * input order is returned unchanged.
 */

import { addDays, type DayRange } from '../../temporal-grammar.ts';

export type TimeScopeMode = 'reserved' | 'partition';

export interface TimeScopeOpts {
  mode: TimeScopeMode;
  /** Result slots the caller will deliver (the reserved contract is defined over these). */
  k: number;
  /** Days of slack on each side of the range (default 2). */
  slackDays?: number;
}

export interface TimeScopeOutcome<T> {
  results: T[];
  inRange: number;
  moved: number;
}

export function overlapsRange(dates: readonly DayRange[] | undefined, range: DayRange, slackDays: number): boolean {
  if (!dates || dates.length === 0) return false;
  const lo = addDays(range.start, -slackDays);
  const hi = addDays(range.end, slackDays);
  return dates.some(d => d.start <= hi && d.end >= lo);
}

export function applyTimeScope<T>(
  results: readonly T[],
  range: DayRange,
  datesOf: (r: T) => readonly DayRange[] | undefined,
  opts: TimeScopeOpts,
): TimeScopeOutcome<T> {
  const slack = opts.slackDays ?? 2;
  const flags = results.map(r => overlapsRange(datesOf(r), range, slack));
  const inRange = flags.filter(Boolean).length;
  if (inRange === 0) return { results: [...results], inRange: 0, moved: 0 };
  let ordered: T[];
  if (opts.mode === 'partition') {
    ordered = [...results.filter((_, i) => flags[i]), ...results.filter((_, i) => !flags[i])];
  } else {
    const keep = Math.ceil(Math.max(1, opts.k) / 2);
    const head = results.slice(0, keep);
    const restIdx = results.map((_, i) => i).slice(keep);
    const fill = restIdx.filter(i => flags[i]).slice(0, Math.max(0, opts.k - keep));
    const fillSet = new Set(fill);
    ordered = [...head, ...fill.map(i => results[i]), ...restIdx.filter(i => !fillSet.has(i)).map(i => results[i])];
  }
  const moved = ordered.reduce((n, r, i) => n + (r !== results[i] ? 1 : 0), 0);
  return { results: ordered, inRange, moved };
}
