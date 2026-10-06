/**
 * Deterministic query time-range parser: "what did I decide last month" →
 * the calendar range the question points at, resolved against a reference
 * day (today in brain.timezone, or a caller-supplied date).
 *
 * Fires only on explicit cues (temporal-grammar.ts) and abstains otherwise:
 * a question that asks for a duration ("how many days…", "how long…"), or
 * that names two separate times in different roles ("which June deadline did
 * we cancel in May"), returns null so retrieval stays unscoped. Joined
 * mentions ("in March and April", "between May 3 and May 9") are one range.
 */

import { findTimeMentions, asksForDuration, type DayRange, type TimeMention } from '../temporal-grammar.ts';

export interface QueryTimeRange extends DayRange {
  /** The phrase the range came from, e.g. "last month". */
  cue: string;
  /** The day the cue was resolved against. */
  reference_date: string;
}

export type TimeRangeAbstention = 'no_cue' | 'multi_role' | 'duration_question';

export interface TimeRangeParse {
  range: QueryTimeRange | null;
  reason: TimeRangeAbstention | 'applied';
}

/** Two mentions joined by "and/or/to/through/-" with nothing else between them are one span. */
function joined(text: string, a: TimeMention, b: TimeMention): boolean {
  const between = text.slice(a.index + a.cue.length, b.index).trim().toLowerCase();
  return /^(?:and|or|to|through|until|till|-|–|—)$/.test(between);
}

export function parseQueryTimeRange(query: string, referenceDate: string): TimeRangeParse {
  const mentions = findTimeMentions(query, referenceDate, 'past');
  if (mentions.length === 0) return { range: null, reason: 'no_cue' };
  if (asksForDuration(query)) return { range: null, reason: 'duration_question' };
  let start = mentions[0].start;
  let end = mentions[0].end;
  let cue = mentions[0].cue;
  for (let i = 1; i < mentions.length; i++) {
    if (!joined(query, mentions[i - 1], mentions[i])) return { range: null, reason: 'multi_role' };
    start = mentions[i].start < start ? mentions[i].start : start;
    end = mentions[i].end > end ? mentions[i].end : end;
    cue = query.slice(mentions[0].index, mentions[i].index + mentions[i].cue.length);
  }
  return { range: { start, end, cue, reference_date: referenceDate }, reason: 'applied' };
}
