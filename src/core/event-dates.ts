/**
 * Dates a page's content mentions, resolved deterministically (no LLM).
 *
 * Three times are kept apart, matching the facts pipeline's vocabulary:
 * the observation date (when the text was written or said), the dates the
 * text mentions (when the events it describes happened), and the recorded
 * time (when GBrain stored the row, never used here). Relative phrases
 * ("yesterday", "two weeks ago") resolve only against a known observation
 * date; without one, only absolute dates are extracted.
 *
 * Code fences, inline code and URLs are skipped, so version strings and
 * timestamps in code do not become event dates.
 */

import { findTimeMentions, type DayRange } from './temporal-grammar.ts';

export interface EventDate extends DayRange {
  origin: 'observation' | 'mention' | 'relative';
  surface: string;
  qualified: boolean;
}

const PLACEHOLDER_DAY = '1970-01-01';

function stripCodeAndUrls(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ');
}

export function extractEventDates(text: string, observationDate: string | null): EventDate[] {
  const clean = stripCodeAndUrls(text);
  const out: EventDate[] = [];
  if (observationDate) out.push({ start: observationDate, end: observationDate, origin: 'observation', surface: '', qualified: false });
  for (const m of findTimeMentions(clean, observationDate ?? PLACEHOLDER_DAY, 'past')) {
    if (m.kind === 'relative' && !observationDate) continue;
    out.push({ start: m.start, end: m.end, origin: m.kind === 'absolute' ? 'mention' : 'relative', surface: m.cue.slice(0, 80), qualified: m.qualified });
  }
  return out;
}
